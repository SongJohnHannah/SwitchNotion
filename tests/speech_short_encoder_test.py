import base64
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/speech'))
from short_encoder_recognition import transcribe, POLICY


class Extractor:
    hop_length = 160
    nb_max_frames = 3000

    def __init__(self, frames):
        self.frames = frames

    def __call__(self, audio, **kwargs):
        return np.ones((128, self.frames + 1), dtype=np.float32)


class Recognizer:
    def __init__(self, frames=1000):
        self.model = SimpleNamespace(device='cuda', n_mels=128)
        self.feature_extractor = Extractor(frames)
        self.seen = []
        self.last_nonzero = False
        self.fail = False
        self.batch = 1

    def encode(self, features):
        self.seen.append(features.copy())
        if self.fail:
            raise RuntimeError('native encoder failed')
        return SimpleNamespace(shape=[1, (features.shape[-1] + 1) // 2, 1280])

    def transcribe(self, audio, **kwargs):
        self.options = kwargs
        features = self.feature_extractor(audio, chunk_length=None)
        content_frames = features.shape[-1] - 1
        padded = np.pad(features[:, :content_frames], ((0, 0), (0, 3000 - content_frames)))
        if self.last_nonzero:
            padded[:, -1] = 1e-20
        if self.batch != 1:
            padded = np.stack([padded] * self.batch)
        self.encode(padded)
        segment = SimpleNamespace(text=' Complete real dialogue.', start=0, end=1, avg_logprob=-.1, no_speech_prob=0, compression_ratio=1)
        return iter([segment]), SimpleNamespace(language='en')


def message(**extra):
    values = np.full(16000, .05, dtype='<f4')
    return {'decodingPolicy': POLICY, 'language': 'en', 'audio': base64.b64encode(values.tobytes()).decode(), **extra}


class ShortEncoderTests(unittest.TestCase):
    def test_proven_pad_is_trimmed_with_margin_alignment_and_original_strategy(self):
        recognizer = Recognizer(1000)
        original_extractor = recognizer.feature_extractor
        result = transcribe(recognizer, message())
        self.assertEqual(recognizer.seen[0].shape, (128, 1536))
        self.assertTrue(np.all(recognizer.seen[0][:, :1000] == 1))
        self.assertEqual(recognizer.options['beam_size'], 1)
        self.assertTrue(recognizer.options['vad_filter'])
        self.assertEqual(result['shortEncoder']['encodeCalls'][0]['trimmedZeroFrames'], 1464)
        self.assertFalse(result['shortEncoder']['mathEquivalent'])
        self.assertIs(recognizer.feature_extractor, original_extractor)
        self.assertNotIn('encode', recognizer.__dict__)

    def test_no_tail_zero_and_nonzero_last_frame_are_never_trimmed(self):
        recognizer = Recognizer(3000)
        transcribe(recognizer, message())
        self.assertEqual(recognizer.seen[0].shape[-1], 3000)
        recognizer = Recognizer(1000)
        recognizer.last_nonzero = True
        transcribe(recognizer, message())
        self.assertEqual(recognizer.seen[0].shape[-1], 3000)

    def test_minimum_1024_and_original_zero_feature_columns_remain(self):
        recognizer = Recognizer(10)
        transcribe(recognizer, message())
        self.assertEqual(recognizer.seen[0].shape[-1], 1024)
        self.assertNotEqual((recognizer.seen[0].shape[-1] + 1) // 2, 128)

    def test_real_zero_feature_columns_are_protected_by_provenance_not_value_guessing(self):
        class ZeroFeatures(Extractor):
            def __call__(self, audio, **kwargs):
                return np.zeros((128, 1001), dtype=np.float32)
        recognizer = Recognizer()
        recognizer.feature_extractor = ZeroFeatures(1000)
        result = transcribe(recognizer, message())
        self.assertEqual(recognizer.seen[0].shape[-1], 1536)
        self.assertEqual(result['shortEncoder']['encodeCalls'][0]['protectedFrames'], 1000)

    def test_observed_406_and_452_source_frame_cases_use_1024_not_512(self):
        for source_frames in (406, 452):
            with self.subTest(source_frames=source_frames):
                recognizer = Recognizer(source_frames - 1)
                result = transcribe(recognizer, message())
                call = result['shortEncoder']['encodeCalls'][0]
                self.assertEqual(call['sourceFeatureFrames'], source_frames)
                self.assertEqual(call['newShape'], [128, 1024])
                self.assertTrue(np.all(recognizer.seen[0][:, :source_frames - 1] == 1))

    def test_v2_shape_family_and_configuration_are_explicit(self):
        observed = set()
        for frames in (10, 406, 452, 1000, 1530, 2000, 2500, 2970, 3000):
            recognizer = Recognizer(frames)
            result = transcribe(recognizer, message())
            self.assertEqual(result['shortEncoder']['config'], {'minFrames': 1024, 'maxFrames': 3000, 'tailMargin': 32, 'alignment': 512})
            observed.add(recognizer.seen[0].shape[-1])
        self.assertEqual(observed, {1024, 1536, 2048, 2560, 3000})

    def test_missing_feature_provenance_passes_original_tensor_without_trimming(self):
        class NoExtractor(Recognizer):
            def transcribe(self, audio, **kwargs):
                self.encode(np.zeros((128, 3000), dtype=np.float32))
                segment = SimpleNamespace(text=' Complete dialogue.', start=0, end=1, avg_logprob=-.1, no_speech_prob=0, compression_ratio=1)
                return iter([segment]), SimpleNamespace(language='en')
        recognizer = NoExtractor()
        result = transcribe(recognizer, message())
        self.assertEqual(recognizer.seen[0].shape[-1], 3000)
        self.assertIsNone(result['shortEncoder']['encodeCalls'][0]['sourceFeatureFrames'])

    def test_exception_restores_methods_and_extractor_and_retains_diagnostics(self):
        recognizer = Recognizer()
        original_extractor = recognizer.feature_extractor
        recognizer.fail = True
        with self.assertRaisesRegex(RuntimeError, 'native encoder failed') as context:
            transcribe(recognizer, message())
        self.assertIn('encodeCalls', context.exception.short_encoder)
        self.assertIs(recognizer.feature_extractor, original_extractor)
        self.assertNotIn('encode', recognizer.__dict__)
        self.assertNotIn('_short_encoder_active', recognizer.__dict__)

    def test_invalid_policy_configuration_batch_and_cpu_are_rejected(self):
        for extra in [{'decodingPolicy': 'stable-gpu-v1-greedy'}, {'shortEncoderConfig': {'tailMargin': 0}}, {'shortEncoderConfig': {'bad': 1}}, {'batchSize': 2}]:
            with self.assertRaises(RuntimeError):
                transcribe(Recognizer(), message(**extra))
        recognizer = Recognizer()
        recognizer.model.device = 'cpu'
        with self.assertRaisesRegex(RuntimeError, 'CUDA'):
            transcribe(recognizer, message())
        recognizer = Recognizer()
        recognizer.batch = 2
        with self.assertRaisesRegex(RuntimeError, 'batch-one'):
            transcribe(recognizer, message())
        self.assertNotIn('encode', recognizer.__dict__)


if __name__ == '__main__':
    unittest.main()
