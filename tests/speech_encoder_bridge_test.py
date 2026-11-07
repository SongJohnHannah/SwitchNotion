"""Run the real batching/forward/generation path with only CUDA operations mocked."""
import base64
import importlib
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/speech'))
from encoder_bridge import EncoderMicrobatchBridge
from batch_recognition import transcribe, POLICY


class Extractor:
    sampling_rate = 16000
    chunk_length = 30

    def __init__(self):
        self.inputs = []

    def __call__(self, samples):
        self.inputs.append(samples.copy())
        return np.full((80, 4), samples[0], dtype=np.float32)


class EncoderBridge(unittest.TestCase):
    def model(self):
        module = importlib.import_module('faster_whisper.transcribe')
        from ctranslate2 import StorageView
        encodes, decodes = [], []

        def encode(features, to_cpu=False):
            values = np.asarray(features)
            encodes.append({'values': values.copy(), 'toCpu': to_cpu})
            output = np.broadcast_to(values[:, :1, :1], (len(values), values.shape[2] // 2, 5)).astype(np.float16).copy()
            return StorageView.from_array(output)

        def generate(encoded, prompts, **options):
            values = np.asarray(encoded)
            # This is the documented encoded shape. Receiving mel features
            # would mean the bridge caused another encoder pass.
            self.assertEqual(values.shape[1:], (1500, 5))
            self.assertEqual(len(values), len(prompts))
            self.assertEqual(values.dtype, np.float16)
            decodes.append({'values': values.copy(), 'options': options})
            return [types.SimpleNamespace(sequences_ids=[[round(float(value[0, 0]) * 10)]],
                                          scores=[-.2], no_speech_prob=.01) for value in values]

        core = types.SimpleNamespace(device='cuda', device_index=[0], is_multilingual=True,
                                     encode=Mock(side_effect=encode), generate=Mock(side_effect=generate))
        model = types.SimpleNamespace(model=core, feature_extractor=Extractor(), logger=Mock(),
                                      hf_tokenizer=object(), max_length=448, frames_per_second=50,
                                      input_stride=2, time_precision=.02, get_prompt=Mock(return_value=[1, 2, 3]))
        model._split_segments_by_timestamps = lambda **options: module.WhisperModel._split_segments_by_timestamps(model, **options)
        model.encode = Mock(side_effect=lambda features: core.encode(StorageView.from_array(np.ascontiguousarray(features)), to_cpu=False))
        return module, model, encodes, decodes

    def test_real_pipeline_encodes_one_or_two_at_a_time_then_decodes_four_or_eight_in_order(self):
        for decoder_size, microbatch in ((4, 1), (4, 2), (8, 1), (8, 2)):
            with self.subTest(decoder_size=decoder_size, microbatch=microbatch):
                module, model, encodes, decodes = self.model()
                samples = np.concatenate([np.full(30 * 16000, (index + 1) / 10, dtype='<f4') for index in range(decoder_size)])
                tokenizer = types.SimpleNamespace(timestamp_begin=50000, decode=lambda tokens: ' clip-' + str(tokens[0]))
                message = {'audio': base64.b64encode(samples.tobytes()).decode(), 'language': 'en', 'context': '',
                           'decodingPolicy': POLICY, 'batchSize': decoder_size, 'clipSeconds': 30,
                           'encoderMicrobatchSize': microbatch}
                with patch.object(module, 'Tokenizer', return_value=tokenizer), patch.object(module, 'get_suppressed_tokens', return_value=[]):
                    result = transcribe(model, message)
                np.testing.assert_array_equal(np.concatenate(model.feature_extractor.inputs), samples)
                self.assertEqual([len(call['values']) for call in encodes], [microbatch] * (decoder_size // microbatch))
                self.assertTrue(all(call['toCpu'] for call in encodes))
                self.assertEqual(len(decodes), 1)
                np.testing.assert_array_equal(decodes[0]['values'][:, 0, 0], np.array([(i + 1) / 10 for i in range(decoder_size)], dtype=np.float16))
                model.encode.assert_not_called()
                self.assertEqual(result['text'], ' '.join('clip-' + str(i + 1) for i in range(decoder_size)))
                metadata = result['batch']['encoderBridge']
                self.assertEqual(metadata['actualEncoderBatchSizes'], [microbatch] * (decoder_size // microbatch))
                self.assertEqual(metadata['decoderInputBatchSizes'], [decoder_size])
                self.assertEqual(metadata['encoderDevice'], 'cuda')
                self.assertEqual(metadata['decoderDevice'], 'cuda')
                self.assertEqual(metadata['outputBridge'], 'cpu')
                self.assertEqual(decodes[0]['options']['beam_size'], 1)
                self.assertEqual(decodes[0]['options']['sampling_temperature'], 0)

    def test_default_zero_keeps_the_existing_model_encode_path(self):
        module, model, encodes, decodes = self.model()
        samples = np.full(60 * 16000, .1, dtype='<f4')
        tokenizer = types.SimpleNamespace(timestamp_begin=50000, decode=lambda tokens: ' clip-' + str(tokens[0]))
        message = {'audio': base64.b64encode(samples.tobytes()).decode(), 'language': 'en', 'context': '',
                   'decodingPolicy': POLICY, 'batchSize': 2, 'encoderMicrobatchSize': 0}
        with patch.object(module, 'Tokenizer', return_value=tokenizer), patch.object(module, 'get_suppressed_tokens', return_value=[]):
            result = transcribe(model, message)
        model.encode.assert_called_once()
        self.assertEqual(len(encodes), 1)
        self.assertFalse(encodes[0]['toCpu'])
        self.assertNotIn('encoderBridge', result['batch'])

    def test_fractional_tail_and_partial_encoder_microbatch_keep_order(self):
        module, model, encodes, decodes = self.model()
        samples = np.concatenate([np.full(30 * 16000, .1, dtype='<f4'), np.full(30 * 16000, .2, dtype='<f4'),
                                  np.full(5 * 16000 + 19, .3, dtype='<f4')])
        tokenizer = types.SimpleNamespace(timestamp_begin=50000, decode=lambda tokens: ' clip-' + str(tokens[0]))
        message = {'audio': base64.b64encode(samples.tobytes()).decode(), 'language': 'en', 'context': '',
                   'decodingPolicy': POLICY, 'batchSize': 4, 'clipSeconds': 30, 'encoderMicrobatchSize': 2}
        with patch.object(module, 'Tokenizer', return_value=tokenizer), patch.object(module, 'get_suppressed_tokens', return_value=[]):
            result = transcribe(model, message)
        np.testing.assert_array_equal(np.concatenate(model.feature_extractor.inputs), samples)
        self.assertEqual([len(call['values']) for call in encodes], [2, 1])
        self.assertEqual([len(call['values']) for call in decodes], [3])
        self.assertEqual(result['batch']['effectiveBatchSize'], 3)
        self.assertEqual(result['segments'][-1]['end'], len(samples) / 16000)
        self.assertEqual(result['text'], 'clip-1 clip-2 clip-3')

    def test_non_cuda_models_are_rejected_without_neural_work(self):
        model = types.SimpleNamespace(model=types.SimpleNamespace(device='cpu', encode=Mock()))
        with self.assertRaisesRegex(RuntimeError, 'existing CUDA'):
            EncoderMicrobatchBridge(model, 1)
        model.model.encode.assert_not_called()


if __name__ == '__main__':
    unittest.main()
