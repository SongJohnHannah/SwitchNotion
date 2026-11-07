import copy
import contextlib
import io
import json
import tempfile
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from gpu_operator import OperatorCancelled, OperatorError

import core
import app as web
import transcribe_file as harness


class OperatorIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.saved = copy.deepcopy(core.state)
        self.temp = tempfile.TemporaryDirectory(prefix='.integration-test-', dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / '采访.mp4'
        self.source.touch()
        core.state.update(video_dir=str(self.root), output_dir=str(self.root), cancel_requested=False,
                          add_ipa=False, language='auto', operator_outputs={})
        self.state_patch = patch.object(core, 'STATE_FILE', self.root / 'state.json')
        self.state_patch.start()
        self.addCleanup(self.state_patch.stop)

    def tearDown(self):
        core.state.clear()
        core.state.update(self.saved)

    def test_single_file_exports_exact_operator_text_and_all_global_srt_times(self):
        result = {'complete': True, 'device': 'cuda', 'model': 'large-v3-turbo',
                  'text': 'Opening.\nFinal words.', 'duration': 65.5, 'totalSamples': 1048000,
                  'segments': [{'start': .25, 'end': 1.5, 'text': 'Opening.'},
                               {'start': 64.1, 'end': 65.5, 'text': 'Final words.'}],
                  'transcriptFile': 'operator-raw.txt', 'checkpointFile': 'checkpoint.json',
                  'eventsFile': 'raw-results.jsonl', 'transcriptSha256': 'hash'}
        with patch.object(core, 'OperatorBridge') as bridge_class:
            bridge_class.return_value.transcribe.return_value = result
            returned = core.transcribe_one(str(self.source), language='en')
            call = bridge_class.return_value.transcribe.call_args
        self.assertEqual(call.kwargs['language'], 'en')
        self.assertEqual(Path(call.args[0]), self.source)
        self.assertTrue(Path(call.args[1]).name.startswith('.gpu-operator_采访'))
        self.assertEqual(self.source.with_suffix('.txt').read_text('utf-8'), result['text'])
        srt = self.source.with_suffix('.srt').read_text('utf-8')
        self.assertIn('00:01:04,100 --> 00:01:05,500', srt)
        self.assertIn('Final words.', srt)
        self.assertEqual(returned['operatorOutputDirectory'], str(call.args[1]))
        saved_result = Path(call.args[1]) / 'transcriber-result.json'
        self.assertEqual(json.loads(saved_result.read_text('utf-8'))['checkpointFile'], 'checkpoint.json')

    def test_status_does_not_import_gpu_framework_or_claim_resources_are_a_probe(self):
        core.state['operator_description'] = {'resourcesReady': True, 'model': 'large-v3-turbo'}
        core.state['operator_ready'] = True
        core.state['last_operator_result'] = None
        with patch.dict(sys.modules, {'torch': None, 'faster_whisper': None, 'ctranslate2': None}):
            with web.app.test_client() as client:
                response = client.get('/api/system')
                model_response = client.get('/api/model_status')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json['resources_ready'])
        self.assertFalse(response.json['gpu_verified'])
        self.assertEqual(response.json['device_required'], 'cuda')
        self.assertEqual(model_response.status_code, 200)
        self.assertEqual(model_response.json['model_name'], 'large-v3-turbo')

    def test_cancel_keeps_pending_file_state_and_never_exports_a_partial_txt(self):
        item = {'path': str(self.source), 'name': self.source.stem}
        core.state.update(transcribing=True, queue=[item], done=[], errors=[], total=1, current_index=0)

        def cancel(_source, output, **_kwargs):
            (output / 'checkpoint.json').write_text('{"parts":[0]}', 'utf-8')
            core.state['cancel_requested'] = True
            raise OperatorCancelled('cancelled')

        with patch.object(core, 'OperatorBridge') as bridge:
            bridge.return_value.transcribe.side_effect = cancel
            core.worker()
        self.assertFalse(core.state['transcribing'])
        self.assertEqual(core.state['queue'], [item])
        self.assertEqual(core.state['done'], [])
        self.assertEqual(core.state['errors'], [])
        self.assertFalse(self.source.with_suffix('.txt').exists())
        saved = core.load_state()
        self.assertEqual(saved['queue'], [item])
        self.assertTrue((Path(saved['operator_outputs'][str(self.source)]) / 'checkpoint.json').exists())

    def test_operator_failure_preserves_existing_export_and_does_not_create_srt(self):
        self.source.with_suffix('.txt').write_text('existing', 'utf-8')
        with patch.object(core, 'OperatorBridge') as bridge:
            bridge.return_value.transcribe.side_effect = OperatorError('CUDA error')
            with self.assertRaisesRegex(OperatorError, 'CUDA error'):
                core.transcribe_one(str(self.source))
        self.assertEqual(self.source.with_suffix('.txt').read_text('utf-8'), 'existing')
        self.assertFalse(self.source.with_suffix('.srt').exists())

    def test_ui_and_task_settings_use_turbo_stable_instead_of_old_beam_choices(self):
        with web.app.test_client() as client:
            html = client.get('/').get_data(as_text=True)
            self.assertIn('统一 Turbo 稳定 GPU 算子', html)
            self.assertNotIn('<option value="accurate">', html)
            self.assertNotIn('CPU 模式', html)
            with patch.object(web.threading, 'Thread'):
                response = client.post('/api/transcribe', json={
                    'videos': [{'path': str(self.source), 'name': self.source.stem}],
                    'video_dir': str(self.root), 'output_dir': str(self.root),
                    'transcribe_mode': 'accurate', 'chunk_mode': 'manual', 'language': 'en'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(core.state['transcribe_mode'], 'stable')
        self.assertEqual(core.state['chunk_mode'], 'operator')
        self.assertEqual(core.state['language'], 'en')

    def test_offline_harness_exports_into_its_own_root_without_replacing_web_queue_state(self):
        web_state = core.STATE_FILE
        web_state.write_text('web-state-marker', 'utf-8')
        output = self.root / 'fresh-harness-run'
        stdout = io.StringIO()
        with patch.object(core, 'OperatorBridge') as bridge, contextlib.redirect_stdout(stdout):
            bridge.return_value.transcribe.return_value = {
                'complete': True, 'device': 'cuda', 'text': 'Offline transcript.',
                'segments': [{'start': .25, 'end': 1, 'text': 'Offline transcript.'}],
                'model': 'large-v3-turbo'}
            code = harness.main([str(self.source), '--output-dir', str(output), '--language', 'en'])
        self.assertEqual(code, 0)
        self.assertEqual(web_state.read_text('utf-8'), 'web-state-marker')
        self.assertEqual((output / '采访.txt').read_text('utf-8'), 'Offline transcript.')
        result = json.loads(stdout.getvalue())
        self.assertEqual(result['event'], 'result')
        self.assertIn('model-load', result['timingScope'])


if __name__ == '__main__':
    unittest.main()
