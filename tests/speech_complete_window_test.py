import base64
import hashlib
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/speech'))
import complete_window_recognition as candidate


class Recognizer:
    def __init__(self):
        self.model = types.SimpleNamespace(device='cuda', n_mels=128)
        self.inputs = []
        self.fail = False
        self.wrong_shape = False

    def encode(self, features):
        return 'unchanged Native output'

    def transcribe(self, audio, **kwargs):
        self.inputs.append(audio.copy())
        self.encode(np.zeros((128, 2048 if self.wrong_shape else 3000), dtype=np.float32))
        if self.fail:
            raise RuntimeError('Native failed')
        segment = types.SimpleNamespace(start=0, end=len(audio) / 16000, text=' real audio output', avg_logprob=-.1, no_speech_prob=0, compression_ratio=1)
        return iter([segment]), types.SimpleNamespace(language='en')


def message(samples, **extra):
    return {'audio': base64.b64encode(samples.astype('<f4').tobytes()).decode(), 'language': 'en',
            'decodingPolicy': candidate.POLICY, 'nativeWindowSeconds': 120, 'windowMode': 'stable30', **extra}


class CompleteWindowTests(unittest.TestCase):
    def test_full_120_container_has_four_ordered_30_second_inner_calls(self):
        samples = np.full(120 * 16000, .05, dtype='<f4')
        result = candidate.transcribe(Recognizer(), message(samples))
        metadata = result['completeWindow']
        self.assertEqual(metadata['transcribeCalls'], 4)
        self.assertEqual([(part['startSample'], part['samples']) for part in metadata['parts']],
                         [(offset * 16000, 480000) for offset in (0, 30, 60, 90)])
        self.assertEqual(metadata['partSamplesSum'], len(samples))
        self.assertFalse(metadata['hasShortTail'])
        self.assertEqual(metadata['innerAcousticMaximumSeconds'], 20)

    def test_stable30_exact_31_seconds_plus_one_sample_and_offsets_without_reference(self):
        samples = np.full(31 * 16000 + 1, .05, dtype='<f4'); samples[-1] = .123
        recognizer = Recognizer()
        result = candidate.transcribe(recognizer, message(samples, referenceText='DO NOT COPY THIS REFERENCE'))
        np.testing.assert_array_equal(np.concatenate(recognizer.inputs), samples)
        metadata = result['completeWindow']
        self.assertEqual([(part['startSample'], part['endSample']) for part in metadata['parts']], [(0, 480000), (480000, len(samples))])
        self.assertEqual(metadata['partSamplesSum'], len(samples)); self.assertEqual(metadata['lastPartSamples'], 16001)
        self.assertTrue(metadata['hasShortTail']); self.assertTrue(metadata['fullPcmSubmitted'])
        self.assertEqual(metadata['parts'][1]['inputFloat32Sha256'], hashlib.sha256(samples[480000:].tobytes()).hexdigest())
        self.assertEqual(result['segments'][-1]['start'], 30)
        self.assertEqual(metadata['parts'][1]['rawResult']['segments'][0]['start'], 0)
        self.assertNotIn('DO NOT COPY', result['text'])
        self.assertEqual(result['text'], 'real audio output real audio output\nreal audio output')
        self.assertNotIn('encode', vars(recognizer))
        self.assertTrue(all(row['shape'] == [128, 3000] for row in metadata['encoderObservations']))

    def test_coverage_modes_delegate_only_pcm_and_decoder_parameters_and_retain_raw_diagnostics(self):
        samples = np.full(16000, .05, dtype='<f4')
        for mode, diagnostic in [('coverage-clips30', 'vad-off-clips30'), ('coverage-no-ts', 'vad-off-no-timestamps')]:
            original_diagnostics = {'raw': 'unmodified'}
            with patch.object(candidate, 'diagnostic_transcribe', return_value={'text': 'actual diagnostic words', 'segments': [], 'diagnostics': original_diagnostics}) as delegate:
                result = candidate.transcribe(Recognizer(), message(samples, windowMode=mode, referenceText='fake reference'))
            forwarded = delegate.call_args.args[1]
            self.assertEqual(forwarded['diagnosticMode'], diagnostic)
            self.assertEqual(forwarded['audio'], message(samples)['audio'])
            self.assertNotIn('referenceText', forwarded)
            self.assertIs(result['diagnostics'], original_diagnostics)
            self.assertEqual(result['text'], 'actual diagnostic words')
            self.assertFalse(result['completeWindow']['single120SecondAcousticEncode'])

    def test_native_failure_or_wrong_encoder_shape_restore_proxy(self):
        samples = np.full(16000, .05, dtype='<f4')
        for attribute in ('fail', 'wrong_shape'):
            recognizer = Recognizer(); setattr(recognizer, attribute, True)
            with self.assertRaises(RuntimeError) as raised:
                candidate.transcribe(recognizer, message(samples))
            self.assertNotIn('encode', vars(recognizer))
            self.assertFalse(raised.exception.complete_window['fullPcmSubmitted'])

    def test_parameters_gpu_model_window_mode_and_audio_limits_are_enforced(self):
        samples = np.full(16000, .05, dtype='<f4')
        for extra in ({'nativeWindowSeconds': 30}, {'nativeWindowSeconds': 120.0}, {'windowMode': 'other'}, {'batchSize': 2}, {'context': 'old prompt'}, {'decodingPolicy': 'stable-gpu-v1-native-window'}):
            with self.assertRaises(RuntimeError):
                candidate.transcribe(Recognizer(), message(samples, **extra))
        recognizer = Recognizer(); recognizer.model.device = 'cpu'
        with self.assertRaisesRegex(RuntimeError, 'CUDA'):
            candidate.transcribe(recognizer, message(samples))
        with self.assertRaises(RuntimeError):
            candidate.transcribe(Recognizer(), message(np.full(120 * 16000 + 1, .05, dtype='<f4')))


if __name__ == '__main__':
    unittest.main()
