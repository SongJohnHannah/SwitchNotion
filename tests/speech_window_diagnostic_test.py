import base64
import hashlib
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/speech'))
import window_diagnostic_recognition as candidate


class Recognizer:
    time_precision = .02

    def __init__(self, module, fail=False):
        self.module = module
        self.fail = fail
        self.tokenizer = types.SimpleNamespace(timestamp_begin=1000, decode=lambda tokens: ' diagnostic dialogue')
        self.split_return = ([{'seek': 0, 'start': 0, 'end': 1, 'tokens': [1000, 10, 1050]}], 200, True)

    def encode(self, features, **kwargs):
        self.encode_input = features
        return 'encoded'

    def _split_segments_by_timestamps(self, **kwargs):
        self.split_kwargs = kwargs
        return self.split_return

    def generate_with_fallback(self, encoder_output, prompt, tokenizer, options):
        self.generate_args = (encoder_output, prompt, tokenizer, options)
        self.generated = (types.SimpleNamespace(sequences_ids=[[1000, 10, 1050]], no_speech_prob=.1), -.2, 0, 1)
        return self.generated

    def transcribe(self, samples, **kwargs):
        self.samples, self.options = samples, kwargs
        if kwargs['vad_filter']:
            self.vad_return = self.module.get_speech_timestamps(samples, kwargs['vad_parameters'])
        def lazy():
            features = np.zeros((128, 3000), dtype=np.float32)
            self.encode(features)
            if self.fail:
                raise RuntimeError('lazy decoder failed')
            options = types.SimpleNamespace(no_speech_threshold=.6, log_prob_threshold=-1)
            returned = self.generate_with_fallback('encoded', [1], self.tokenizer, options)
            assert returned is self.generated
            split = self._split_segments_by_timestamps(tokenizer=self.tokenizer, tokens=returned[0].sequences_ids[0],
                seek=0, segment_size=200, time_offset=0, segment_duration=2)
            assert split is self.split_return
            yield types.SimpleNamespace(text=' diagnostic dialogue', start=0, end=1, avg_logprob=-.2, no_speech_prob=.1, compression_ratio=1)
        return lazy(), types.SimpleNamespace(language='en', duration=len(samples) / 16000,
            duration_after_vad=len(samples) / 16000 / (2 if kwargs['vad_filter'] else 1))


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.module = types.ModuleType('faster_whisper.transcribe')
        self.ranges = [{'start': 0, 'end': 16000}]
        self.original_vad = lambda *args, **kwargs: self.ranges
        self.module.get_speech_timestamps = self.original_vad
        self.samples = np.full(32000, .02, dtype='<f4')

    def message(self, mode='vad-on', **extra):
        return {'audio': base64.b64encode(self.samples.tobytes()).decode(), 'language': 'en', 'decodingPolicy': candidate.POLICY, 'diagnosticMode': mode, **extra}

    def test_observers_preserve_vad_identity_split_return_and_exact_native_kwargs(self):
        recognizer = Recognizer(self.module)
        with patch.dict(sys.modules, {'faster_whisper.transcribe': self.module}):
            result = candidate.transcribe(recognizer, self.message())
        self.assertIs(recognizer.vad_return, self.ranges)
        self.assertIs(self.module.get_speech_timestamps, self.original_vad)
        np.testing.assert_array_equal(recognizer.samples, self.samples)
        self.assertEqual(recognizer.options, {'language': 'en', 'task': 'transcribe', 'beam_size': 1, 'best_of': 1,
            'patience': 1.5, 'temperature': 0, 'condition_on_previous_text': False, 'initial_prompt': None, 'multilingual': False,
            'language_detection_threshold': .8, 'language_detection_segments': 3, 'without_timestamps': False,
            'chunk_length': 30, 'vad_filter': True, 'vad_parameters': dict(candidate.VAD_PARAMETERS)})
        diagnostics = result['diagnostics']
        self.assertEqual(diagnostics['inputFloat32Sha256'], hashlib.sha256(self.samples.tobytes()).hexdigest())
        self.assertEqual(diagnostics['vadCalls'][0]['ranges'], self.ranges)
        self.assertEqual(diagnostics['seekTraces'][0]['nextSeek'], 200)
        self.assertEqual(diagnostics['seekTraces'][0]['segments'][0]['text'], ' diagnostic dialogue')
        self.assertFalse(diagnostics['generationTraces'][0]['wouldSkipForNoSpeech'])
        self.assertEqual(diagnostics['encoderCalls'][0]['shape'], [128, 3000])
        self.assertNotIn('encode', vars(recognizer))

    def test_vad_off_has_no_vad_calls_or_false_removed_audio_claim(self):
        recognizer = Recognizer(self.module)
        with patch.dict(sys.modules, {'faster_whisper.transcribe': self.module}):
            result = candidate.transcribe(recognizer, self.message('vad-off'))
        self.assertFalse(recognizer.options['vad_filter'])
        self.assertEqual(result['diagnostics']['vadCalls'], [])
        self.assertFalse(result['diagnostics']['vadAppliedObserved'])
        self.assertEqual(result['diagnostics']['vadRemovedSeconds'], 0)

    def test_fixed_clips30_changes_only_clip_argument_and_preserves_exact_tail_samples(self):
        self.samples = np.full(31 * 16000 + 1, .02, dtype='<f4')
        ordinary, clipped = Recognizer(self.module), Recognizer(self.module)
        with patch.dict(sys.modules, {'faster_whisper.transcribe': self.module}):
            candidate.transcribe(ordinary, self.message('vad-off'))
            result = candidate.transcribe(clipped, self.message('vad-off-clips30'))
        expected = dict(ordinary.options, clip_timestamps=[0, 30, 30, len(self.samples) / 16000])
        self.assertEqual(clipped.options, expected)
        planned = result['diagnostics']['plannedClipRanges']
        self.assertEqual([(clip['startSample'], clip['endSample']) for clip in planned], [(0, 480000), (480000, len(self.samples))])
        self.assertEqual(sum(clip['endSample'] - clip['startSample'] for clip in planned), len(self.samples))
        self.assertEqual(result['diagnostics']['transcribeCalls'], 1)
        self.assertTrue(result['diagnostics']['explicitClipBoundaries'])
        self.assertFalse(result['diagnostics']['withoutTimestamps'])
        self.assertEqual(result['diagnostics']['vadCalls'], [])

    def test_no_timestamps_changes_only_timestamp_flag_and_is_not_labelled_word_srt(self):
        ordinary, coarse = Recognizer(self.module), Recognizer(self.module)
        with patch.dict(sys.modules, {'faster_whisper.transcribe': self.module}):
            candidate.transcribe(ordinary, self.message('vad-off'))
            result = candidate.transcribe(coarse, self.message('vad-off-no-timestamps'))
        self.assertEqual(coarse.options, dict(ordinary.options, without_timestamps=True))
        diagnostics = result['diagnostics']
        self.assertTrue(diagnostics['withoutTimestamps'])
        self.assertFalse(diagnostics['wordTimestamps'])
        self.assertEqual(diagnostics['timestampMode'], 'coarse-window-bounds-no-generated-timestamps')
        self.assertEqual(diagnostics['plannedClipRanges'], [])
        self.assertEqual(diagnostics['vadCalls'], [])

    def test_lazy_failure_restores_every_proxy_and_keeps_prefix_diagnostics(self):
        recognizer = Recognizer(self.module, fail=True)
        with patch.dict(sys.modules, {'faster_whisper.transcribe': self.module}), self.assertRaisesRegex(RuntimeError, 'lazy decoder failed') as raised:
            candidate.transcribe(recognizer, self.message())
        self.assertIs(self.module.get_speech_timestamps, self.original_vad)
        for key in ('encode', '_split_segments_by_timestamps', 'generate_with_fallback'):
            self.assertNotIn(key, vars(recognizer))
        self.assertNotIn('_notion_window_diagnostic_active', vars(self.module))
        self.assertEqual(len(raised.exception.window_diagnostics['encoderCalls']), 1)

    def test_invalid_mode_policy_size_and_batch_are_rejected(self):
        recognizer = Recognizer(self.module)
        for extra in ({'diagnosticMode': 'other'}, {'decodingPolicy': 'stable-gpu-v1-native-window'}, {'batchSize': True}, {'nativeWindowSeconds': 121}, {'context': 'previous'}):
            with self.assertRaises(RuntimeError):
                candidate.transcribe(recognizer, self.message(**extra))


if __name__ == '__main__':
    unittest.main()
