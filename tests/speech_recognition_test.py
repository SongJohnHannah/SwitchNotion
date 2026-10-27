"""Decode policy tests; real ASR accuracy is evaluated on audio separately."""
import base64
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/speech'))
from recognition import transcribe

class RecognitionPolicy(unittest.TestCase):
    def sample(self, **extra):
        return {'audio': base64.b64encode(np.full(16000, .1, dtype='<f4').tobytes()).decode(), **extra}

    def model(self):
        segment = types.SimpleNamespace(start=0, end=1, text='真实发言 English.', avg_logprob=-.2,
                                        no_speech_prob=.01, compression_ratio=1)
        model = Mock()
        model.transcribe.return_value = ([segment], types.SimpleNamespace(language='zh'))
        return model, segment

    def test_automatic_bilingual_decode_does_not_bias_audio_with_previous_text(self):
        model, _ = self.model()
        result = transcribe(model, self.sample(context='前文' * 100))
        options = model.transcribe.call_args.kwargs
        self.assertTrue(options['multilingual'])
        self.assertIsNone(options['language'])
        self.assertEqual(options['task'], 'transcribe')
        self.assertEqual(options['temperature'], [0, .2, .4])
        self.assertTrue(options['vad_filter'])
        self.assertIsNone(options['initial_prompt'])
        self.assertIn('English', result['contextText'])

    def test_explicit_english_is_respected_and_low_confidence_is_never_reused_as_context(self):
        model, segment = self.model()
        segment.avg_logprob = -1.5
        result = transcribe(model, self.sample(language='en'))
        self.assertEqual(model.transcribe.call_args.kwargs['language'], 'en')
        self.assertFalse(model.transcribe.call_args.kwargs['multilingual'])
        self.assertIsNone(model.transcribe.call_args.kwargs['initial_prompt'])
        self.assertEqual(result['contextText'], '')

    def test_invalid_context_and_silent_samples_do_not_reach_decoder(self):
        model, _ = self.model()
        with self.assertRaises(RuntimeError):
            transcribe(model, self.sample(context='x' * 401))
        data = base64.b64encode(np.zeros(16000, dtype='<f4').tobytes()).decode()
        self.assertEqual(transcribe(model, {'audio': data})['text'], '')
        model.transcribe.assert_not_called()

    def test_bilingual_recording_decodes_each_acoustic_phrase_without_translation(self):
        model, english = self.model()
        english.text = 'Please keep the English sentence.'
        chinese = types.SimpleNamespace(**vars(english))
        chinese.text = '中文保持中文。'
        samples = np.concatenate([np.full(5 * 16000, .1), np.zeros(16000), np.full(6 * 16000, .2)]).astype('<f4')
        model.transcribe.side_effect = [([english], types.SimpleNamespace(language='en')),
                                        ([chinese], types.SimpleNamespace(language='zh'))]
        result = transcribe(model, {'audio': base64.b64encode(samples.tobytes()).decode()})
        self.assertIn(english.text, result['text'])
        self.assertIn(chinese.text, result['text'])
        self.assertEqual(model.transcribe.call_count, 2)
        calls = model.transcribe.call_args_list
        self.assertEqual([len(c.args[0]) for c in calls], [92800, 99200])
        np.testing.assert_array_equal(np.concatenate([c.args[0] for c in calls]), samples)
        for call in calls:
            self.assertIsNone(call.kwargs['language'])
            self.assertEqual(call.kwargs['task'], 'transcribe')
        self.assertEqual(result['segments'][1]['start'], 5.8)

if __name__ == '__main__':
    unittest.main()
