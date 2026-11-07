"""CPU-only native-window seam: original transcribe/encode are observed, not GPU-run."""
import base64
import hashlib
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/speech'))
import native_window_recognition as candidate


def segment(start, end, text):
    return types.SimpleNamespace(start=start, end=end, text=text,
        avg_logprob=-.2, no_speech_prob=.01, compression_ratio=1)


class NativeWindow(unittest.TestCase):
    def message(self, samples):
        return {'audio': base64.b64encode(samples.astype('<f4').tobytes()).decode(),
                'language': 'en', 'context': '', 'decodingPolicy': candidate.POLICY}

    def model(self, *, empty=False, fail=False, duration_delta=0):
        model = types.SimpleNamespace(encode=Mock(return_value='encoded'))

        def transcribe(samples, **kwargs):
            def lazy_segments():
                if empty:
                    return
                self.assertEqual(model.encode(np.zeros((128, 3000), dtype=np.float32)), 'encoded')
                if fail:
                    raise RuntimeError('lazy decoder failure')
                yield segment(0, 1, ' first')
                yield segment(2, 3, ' second')
            return lazy_segments(), types.SimpleNamespace(language='en', duration=len(samples) / 16000 + duration_delta,
                duration_after_vad=0 if empty else len(samples) / 16000 / 2)

        model.transcribe = Mock(side_effect=transcribe)
        return model

    def test_whole_30s_is_submitted_exactly_once_without_outer_subdivision(self):
        samples = ((np.arange(30 * 16000) % 1000) / 5000).astype('<f4')
        model = self.model(); original = model.encode
        response = candidate.transcribe(model, self.message(samples))
        model.transcribe.assert_called_once()
        actual = model.transcribe.call_args.args[0]
        np.testing.assert_array_equal(actual, samples)
        options = model.transcribe.call_args.kwargs
        self.assertEqual(options['beam_size'], 1); self.assertEqual(options['best_of'], 1)
        self.assertEqual(options['temperature'], 0); self.assertFalse(options['condition_on_previous_text'])
        self.assertIsNone(options['initial_prompt']); self.assertFalse(options['without_timestamps'])
        self.assertTrue(options['vad_filter']); self.assertEqual(options['vad_parameters'], candidate.VAD_PARAMETERS)
        self.assertEqual(options['chunk_length'], 30)
        self.assertIs(model.encode, original)
        self.assertEqual(response['nativeWindow']['encoderCalls'], 1)
        self.assertEqual(response['nativeWindow']['encoderObservations'][0]['expectedStorageViewShape'], [1, 128, 3000])
        self.assertEqual(response['text'], 'first second')
        self.assertEqual(response['segments'][1]['start'], 2)
        self.assertEqual(response['nativeWindow']['speechDuration'], 15)
        self.assertEqual(response['nativeWindow']['submittedSamples'], len(samples))

    def test_fractional_tail_sample_is_submitted_unchanged_and_hashes_match(self):
        samples = np.full(29 * 16000 + 19, .1, dtype='<f4'); samples[-1] = .37
        model = self.model(); response = candidate.transcribe(model, self.message(samples))
        np.testing.assert_array_equal(model.transcribe.call_args.args[0], samples)
        self.assertEqual(response['nativeWindow']['inputSamples'], len(samples))
        self.assertEqual(response['nativeWindow']['inputFloat32Sha256'], hashlib.sha256(samples.tobytes()).hexdigest())

    def test_all_silence_still_reaches_standard_vad_once_and_empty_segments_are_valid(self):
        samples = np.zeros(16000, dtype='<f4'); model = self.model(empty=True)
        response = candidate.transcribe(model, self.message(samples))
        model.transcribe.assert_called_once(); self.assertEqual(response['segments'], [])
        self.assertEqual(response['nativeWindow']['encoderCalls'], 0)
        self.assertEqual(response['nativeWindow']['speechDuration'], 0)
        self.assertEqual(response['nativeWindow']['vadRemovedSeconds'], 1)

    def test_lazy_failure_restores_original_encode_method(self):
        model = self.model(fail=True); original = model.encode
        with self.assertRaisesRegex(RuntimeError, 'lazy decoder failure'):
            candidate.transcribe(model, self.message(np.zeros(16000, dtype='<f4')))
        self.assertIs(model.encode, original)

    def test_multiple_internal_encodes_are_recorded_not_forbidden_or_hidden(self):
        model = self.model()
        def transcribe(samples, **options):
            def result():
                model.encode(np.zeros((128, 3000), dtype=np.float32))
                model.encode(np.zeros((1, 128, 3000), dtype=np.float32))
                yield segment(0, 1, ' two encodes')
            return result(), types.SimpleNamespace(language='en', duration=1, duration_after_vad=1)
        model.transcribe.side_effect = transcribe
        response = candidate.transcribe(model, self.message(np.zeros(16000, dtype='<f4')))
        self.assertEqual(response['nativeWindow']['encoderCalls'], 2)

    def test_policy_size_context_batch_and_nonfinite_inputs_fail_before_standard_decoder(self):
        samples = np.zeros(16000, dtype='<f4'); model = self.model()
        for changes in ({'decodingPolicy': 'stable-gpu-v1-greedy'}, {'batchSize': 2}, {'batchSize': True},
                        {'context': 'previous context'}, {'language': 'fr'}):
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                candidate.transcribe(model, {**self.message(samples), **changes})
        with self.assertRaises(RuntimeError):
            candidate.transcribe(model, self.message(np.zeros(30 * 16000 + 1, dtype='<f4')))
        with self.assertRaises(RuntimeError):
            candidate.transcribe(model, self.message(np.array([np.nan], dtype='<f4')))
        model.transcribe.assert_not_called()

    def test_invalid_duration_is_not_marked_as_full_input_processed(self):
        with self.assertRaisesRegex(RuntimeError, 'invalid audio durations'):
            candidate.transcribe(self.model(duration_delta=-1), self.message(np.zeros(16000, dtype='<f4')))

    def test_explicit_long_window_is_one_submission_with_fixed_internal_30s_not_large_attention(self):
        for seconds in (60, 120, 240):
            with self.subTest(seconds=seconds):
                samples = np.zeros(seconds * 16000, dtype='<f4'); samples[-1] = .3
                model = self.model()
                response = candidate.transcribe(model, {**self.message(samples), 'nativeWindowSeconds': seconds})
                model.transcribe.assert_called_once()
                np.testing.assert_array_equal(model.transcribe.call_args.args[0], samples)
                self.assertEqual(model.transcribe.call_args.kwargs['chunk_length'], 30)
                self.assertEqual(response['nativeWindow']['declaredWindowSeconds'], seconds)
                self.assertEqual(response['nativeWindow']['internalChunkSeconds'], 30)
                self.assertEqual(response['nativeWindow']['inputSamples'], len(samples))

    def test_default_and_explicit_window_limits_are_enforced_before_decoder(self):
        model = self.model()
        for invalid in (True, 20, 31, 90, 241, '120', 120.0):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(RuntimeError, 'window seconds'):
                candidate.transcribe(model, {**self.message(np.zeros(16000, dtype='<f4')), 'nativeWindowSeconds': invalid})
        for seconds in (30, 60, 120, 240):
            with self.subTest(seconds=seconds), self.assertRaises(RuntimeError):
                candidate.transcribe(model, {**self.message(np.zeros(seconds * 16000 + 1, dtype='<f4')),
                                             'nativeWindowSeconds': seconds})
        model.transcribe.assert_not_called()


if __name__ == '__main__':
    unittest.main()
