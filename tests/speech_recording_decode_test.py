import base64
import hashlib
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/speech'))
from recording_decode import decode_recording


class RecordingDecodeTests(unittest.TestCase):
    def decode(self, seconds, **fields):
        samples = np.full(int(seconds * 16000), .1, dtype=np.float32)

        class Container:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def decode(self, **kwargs): return [samples]

        class Resampler:
            def __init__(self, **kwargs): pass
            def resample(self, frame):
                return [] if frame is None else [types.SimpleNamespace(to_ndarray=lambda: frame)]

        fake_av = types.SimpleNamespace(open=lambda *a, **kw: Container(), AudioResampler=Resampler)
        message = {'audio': base64.b64encode(b'\x1aE\xdf\xa3encoded').decode(), **fields}
        with patch.dict(sys.modules, {'av': fake_av}):
            return decode_recording(message)

    def test_stable_policy_and_language_reach_recognition_and_codec_tail_is_not_cut(self):
        decoded = self.decode(60.5, language='en', decodingPolicy='stable-gpu-v1-greedy')
        pcm = base64.b64decode(decoded['audio'])
        self.assertEqual(decoded['language'], 'en')
        self.assertEqual(decoded['decodingPolicy'], 'stable-gpu-v1-greedy')
        self.assertEqual(len(pcm) // 4, 968000)
        self.assertEqual(decoded['recordingDecode']['samples'], 968000)
        self.assertEqual(decoded['recordingDecode']['pcmSha256'], hashlib.sha256(pcm).hexdigest())

    def test_invalid_language_policy_and_long_recordings_fail_instead_of_truncating(self):
        for fields in ({'language': 'invalid'}, {'decodingPolicy': 'stable-gpu-v1-batched'}, {'context': 'unverified prompt'}):
            with self.assertRaises(RuntimeError): self.decode(1, **fields)
        with self.assertRaises(RuntimeError): self.decode(61.1)


if __name__ == '__main__': unittest.main()
