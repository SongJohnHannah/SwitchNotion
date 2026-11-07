import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from gpu_operator import OperatorBridge, OperatorCancelled, OperatorError


class OperatorBridgeTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {'TRANSCRIBER_GPU_PROFILE': 'winner',
                                             'TRANSCRIBER_GPU_ALLOW_EXPERIMENTAL': '0'})
        environment.start()
        self.addCleanup(environment.stop)
        self.temp = tempfile.TemporaryDirectory(prefix='.operator-test-', dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.fixture = self.root / 'bridge_fixture.py'

    def bridge(self, code):
        self.fixture.write_text(code, encoding='utf-8')
        return OperatorBridge(self.root, command=[sys.executable, '-X', 'utf8', '-u', str(self.fixture)])

    def test_transcription_uses_json_bridge_and_preserves_full_result(self):
        bridge = self.bridge('''import json,sys
request=json.loads(sys.stdin.readline())
assert request['type']=='transcribe'
assert request['language']=='en'
assert request['source'].endswith('采访.mp4')
print(json.dumps({'event':'progress','totalChunks':2,'index':0}),flush=True)
print(json.dumps({'event':'result','result':{'complete':True,'device':'cuda','model':'large-v3-turbo','text':'Hello world.','segments':[{'start':0.2,'end':1.2,'text':'Hello world.'}],'transcriptFile':'raw.txt','checkpointFile':'checkpoint.json','eventsFile':'events.jsonl','totalSamples':32000,'duration':2,'transcriptSha256':'abc'}}),flush=True)
''')
        events = []
        result = bridge.transcribe(self.root / '采访.mp4', self.root / 'operator', language='en', on_progress=events.append)
        self.assertEqual(result['text'], 'Hello world.')
        self.assertEqual(result['segments'], [{'start': 0.2, 'end': 1.2, 'text': 'Hello world.'}])
        self.assertEqual(events[0]['totalChunks'], 2)

    def test_cancel_is_cooperative_and_preserves_the_operator_checkpoint(self):
        checkpoint = self.root / 'operator' / 'checkpoint.json'
        cancelled = threading.Event()
        bridge = self.bridge('''import json,sys,pathlib
request=json.loads(sys.stdin.readline())
p=pathlib.Path(request['outputDirectory'])/'checkpoint.json'
p.parent.mkdir(parents=True,exist_ok=True)
p.write_text('{"parts":[0]}',encoding='utf-8')
print(json.dumps({'event':'progress','index':0}),flush=True)
assert json.loads(sys.stdin.readline())=={'type':'cancel'}
print(json.dumps({'event':'error','error':'cancelled'}),flush=True)
sys.exit(2)
''')
        with self.assertRaises(OperatorCancelled):
            bridge.transcribe(self.root / 'source.mp4', checkpoint.parent,
                              on_progress=lambda _event: cancelled.set(), is_cancelled=cancelled.is_set)
        self.assertEqual(json.loads(checkpoint.read_text('utf-8')), {'parts': [0]})

    def test_describe_reads_bundle_metadata_without_loading_a_model(self):
        bridge = self.bridge('''import json,sys
assert json.loads(sys.stdin.readline())=={'type':'describe'}
print(json.dumps({'event':'description','result':{'resourcesReady':True,'device':'cuda','model':'large-v3-turbo','gpuProbePerformed':False}}),flush=True)
''')
        result = bridge.describe()
        self.assertTrue(result['resourcesReady'])
        self.assertFalse(result['gpuProbePerformed'])

    def test_describe_closes_input_after_request_so_bridge_can_exit(self):
        bridge = self.bridge('''import json,sys
assert json.loads(sys.stdin.readline())=={'type':'describe'}
assert sys.stdin.read()==''
print(json.dumps({'event':'description','result':{'resourcesReady':True}}),flush=True)
''')
        self.assertTrue(bridge.describe()['resourcesReady'])

    def test_cpu_result_is_rejected_without_retry_or_fallback(self):
        bridge = self.bridge('''import json,sys,pathlib
request=json.loads(sys.stdin.readline())
p=pathlib.Path(request['outputDirectory'])
p.mkdir(parents=True,exist_ok=True)
(p/'calls').write_text('one',encoding='utf-8')
print(json.dumps({'event':'result','result':{'complete':True,'device':'cpu','text':'wrong','segments':[]}}),flush=True)
''')
        with self.assertRaisesRegex(OperatorError, 'CUDA'):
            bridge.transcribe(self.root / 'source.mp4', self.root / 'output')
        self.assertEqual((self.root / 'output/calls').read_text('utf-8'), 'one')

    def test_result_followed_by_nonzero_exit_is_not_success(self):
        bridge = self.bridge('''import json,sys
json.loads(sys.stdin.readline())
print(json.dumps({'event':'result','result':{'complete':True,'device':'cuda','text':'partial','segments':[]}}),flush=True)
print(json.dumps({'event':'error','message':'GPU failed','code':'CUDA_ERROR'}),flush=True)
sys.exit(1)
''')
        with self.assertRaisesRegex(OperatorError, 'GPU failed'):
            bridge.transcribe(self.root / 'source.mp4', self.root / 'output')

    def test_experimental_profile_requires_explicit_environment_opt_in(self):
        bridge = self.bridge('''import json,sys
request=json.loads(sys.stdin.readline())
assert request['profile']=='native-test'
assert request['allowExperimental'] is True
print(json.dumps({'event':'result','result':{'complete':True,'device':'cuda','text':'ok','segments':[]}}),flush=True)
''')
        with patch.dict(os.environ, {'TRANSCRIBER_GPU_PROFILE': 'native-test',
                                     'TRANSCRIBER_GPU_ALLOW_EXPERIMENTAL': '0'}):
            with self.assertRaisesRegex(OperatorError, 'profile'):
                bridge.transcribe(self.root / 'source.mp4', self.root / 'output')
        with patch.dict(os.environ, {'TRANSCRIBER_GPU_PROFILE': 'native-test',
                                     'TRANSCRIBER_GPU_ALLOW_EXPERIMENTAL': '1'}):
            self.assertEqual(bridge.transcribe(self.root / 'source.mp4', self.root / 'output')['text'], 'ok')

    def test_bridge_cancel_code_is_a_cancellation_not_a_failed_file(self):
        bridge = self.bridge('''import json,sys
json.loads(sys.stdin.readline())
print(json.dumps({'event':'error','message':'cancelled','code':'CANCELLED'}),flush=True)
sys.exit(2)
''')
        with self.assertRaises(OperatorCancelled):
            bridge.transcribe(self.root / 'source.mp4', self.root / 'output')

    def test_transcription_keeps_input_for_cancel_then_closes_it_after_result(self):
        bridge = self.bridge('''import json,sys
request=json.loads(sys.stdin.readline())
assert request['type']=='transcribe'
print(json.dumps({'event':'result','result':{'complete':True,'device':'cuda','text':'finished','segments':[]}}),flush=True)
assert sys.stdin.read()==''
''')
        self.assertEqual(bridge.transcribe(self.root / 'source.mp4', self.root / 'output')['text'], 'finished')


if __name__ == '__main__':
    unittest.main()
