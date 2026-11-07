"""CPU-only GPU bridge seams. Fake GPU views never reach any CUDA API."""
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock
import weakref
import gc
import base64
import importlib
from unittest.mock import patch
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/speech'))
from encoder_gpu_bridge import EncoderGpuBridge, MAX_BRIDGE_BYTES, cub_bin_bytes


class FakeGpuView:
    def __init__(self, values, device='cuda', index=0):
        self.values = values
        self.shape = list(values.shape)
        self.device, self.device_index = device, index

    @property
    def __cuda_array_interface__(self):
        # Dummy address deliberately cannot be consumed by CT2; only the mock
        # concat inspects actual CPU arrays in this test.
        return {'shape': tuple(self.shape), 'typestr': '<f2', 'strides': None, 'data': (0, False), 'version': 3}


class GpuBridge(unittest.TestCase):
    def seam(self, size=4, max_bytes=MAX_BRIDGE_BYTES, change=None):
        encodes, weak_sources, concats = [], [], []
        def encode(features):
            encodes.append(features.copy())
            output = np.full((1, (features.shape[2] + 1) // 2, 1280), features[0, 0, 0], dtype=np.float16)
            view = FakeGpuView(output)
            if change: change(view)
            weak_sources.append(weakref.ref(view)); return view
        def concat(views, *, max_bytes, input_mels):
            self.assertTrue(all(value() is not None for value in weak_sources[-len(views):]))
            self.assertEqual(input_mels, 128)
            self.assertEqual(len(views), len(encodes))
            concats.append(list(views))
            return FakeGpuView(np.concatenate([view.values for view in views], axis=0))
        recognizer = types.SimpleNamespace(model=types.SimpleNamespace(device='cuda', device_index=[0], n_mels=128),
                                          encode=Mock(side_effect=encode))
        gpuops = types.SimpleNamespace(concat_axis0=Mock(side_effect=concat))
        bridge = EncoderGpuBridge(recognizer, size, gpuops=gpuops, max_bytes=max_bytes)
        return bridge, recognizer, gpuops, encodes, weak_sources, concats

    def test_b2_b4_use_only_validated_b1_encoder_then_ordered_gpu_concat(self):
        for size in (2, 4):
            with self.subTest(size=size):
                bridge, recognizer, ops, encodes, weak_sources, concats = self.seam(size)
                features = np.stack([np.full((128, 8), (index + 1) / 10, dtype=np.float32) for index in range(size)])
                merged = bridge.encode(features)
                self.assertEqual([list(value.shape) for value in encodes], [[1, 128, 8]] * size)
                self.assertEqual(merged.shape, [size, 4, 1280])
                np.testing.assert_array_equal(merged.values[:, 0, 0], features[:, 0, 0].astype(np.float16))
                ops.concat_axis0.assert_called_once()
                self.assertTrue(all('to_cpu' not in call.kwargs for call in recognizer.encode.call_args_list))
                metadata = bridge.metadata()
                self.assertFalse(metadata['zeroCopy']); self.assertTrue(metadata['generatePerformsSyncCopy'])
                self.assertEqual(metadata['batches'][0]['actualEncoderBatchSizes'], [1] * size)
                self.assertEqual(metadata['batches'][0]['logicalBridgePeakBytes'], size * 4 * 1280 * 2 * 3)
                self.assertEqual(metadata['batches'][0]['budgetedBridgePeakBytes'], size * cub_bin_bytes(4 * 1280 * 2) + 2 * cub_bin_bytes(size * 4 * 1280 * 2))

    def test_sources_survive_concat_and_synchronous_decode_until_explicit_close(self):
        bridge, _, ops, _, refs, concats = self.seam(2)
        encoded = bridge.encode(np.ones((2, 128, 8), dtype=np.float32))
        # Remove mock's owner references; bridge itself must retain them.
        concats.clear(); ops.concat_axis0.reset_mock(); gc.collect()
        self.assertTrue(all(ref() is not None for ref in refs))
        self.assertIs(bridge._last_output, encoded)
        bridge.close(); gc.collect()
        self.assertTrue(all(ref() is None for ref in refs))

    def test_partial_tail_batch_is_valid_and_metadata_counts_actual_rows(self):
        bridge, _, _, encodes, _, _ = self.seam(4)
        result = bridge.encode(np.ones((3, 128, 8), dtype=np.float32))
        self.assertEqual(result.shape[0], 3)
        self.assertEqual(bridge.metadata()['batches'][0]['encoderCalls'], 3)

    def test_budget_is_total_source_concat_generate_copy_not_just_destination(self):
        bridge, _, ops, encodes, _, _ = self.seam(4, max_bytes=1000)
        with self.assertRaisesRegex(RuntimeError, 'bridge budget'):
            bridge.encode(np.ones((4, 128, 8), dtype=np.float32))
        self.assertEqual(len(encodes), 1); ops.concat_axis0.assert_not_called()
        self.assertEqual(bridge._held_outputs, [])

    def test_device_dtype_and_encoded_shape_are_checked_before_concat(self):
        for change in (lambda view: setattr(view, 'device', 'cpu'),
                       lambda view: setattr(view, 'device_index', 1),
                       lambda view: setattr(view, 'shape', [1, 128, 1280])):
            with self.subTest(change=change):
                bridge, _, ops, _, _, _ = self.seam(2, change=change)
                with self.assertRaises(RuntimeError): bridge.encode(np.ones((2, 128, 8), dtype=np.float32))
                ops.concat_axis0.assert_not_called(); self.assertEqual(bridge._held_outputs, [])

    def test_failed_concat_drops_owned_references_but_does_not_free_external_gpu_pointers(self):
        bridge, _, ops, _, refs, _ = self.seam(2)
        ops.concat_axis0.side_effect = RuntimeError('simulated concat error')
        with self.assertRaisesRegex(RuntimeError, 'concat error'):
            bridge.encode(np.ones((2, 128, 8), dtype=np.float32))
        self.assertEqual(bridge._held_outputs, []); self.assertIsNone(bridge._last_output)

    def test_invalid_cpu_model_batch_and_cap_fail_without_loading_extension(self):
        model = types.SimpleNamespace(model=types.SimpleNamespace(device='cpu', device_index=[0]))
        with self.assertRaisesRegex(RuntimeError, 'existing CUDA'): EncoderGpuBridge(model, 2)
        model.model.device = 'cuda'
        for size in (1, 8, True):
            with self.assertRaises(RuntimeError): EncoderGpuBridge(model, size)
        with self.assertRaises(RuntimeError): EncoderGpuBridge(model, 2, max_bytes=MAX_BRIDGE_BYTES + 1)

    def test_real_timestamp_pipeline_uses_gpu_bridge_b1_then_b4_and_finally_closes(self):
        from batch_timestamp_recognition import transcribe, POLICY
        import encoder_gpu_bridge as bridge_module
        module = importlib.import_module('faster_whisper.transcribe')
        inputs, encode_batches, decode_batches, adapters = [], [], [], []
        class Extractor:
            sampling_rate, chunk_length = 16000, 30
            def __call__(self, audio):
                inputs.append(audio.copy())
                return np.full((128, 4), audio[0], dtype=np.float32)
        def encode(values):
            encode_batches.append(values.copy())
            return FakeGpuView(np.full((1, 1500, 1280), values[0, 0, 0], dtype=np.float16))
        def concat(views, **options):
            return FakeGpuView(np.concatenate([view.values for view in views], axis=0))
        def generate(encoded, prompts, **options):
            decode_batches.append(encoded.values.copy())
            self.assertEqual(encoded.shape, [4, 1500, 1280]); self.assertEqual(len(prompts), 4)
            self.assertEqual(options['beam_size'], 1); self.assertEqual(options['sampling_temperature'], 0)
            return [types.SimpleNamespace(sequences_ids=[[round(float(row[0, 0]) * 10)]], scores=[-.2], no_speech_prob=.01)
                    for row in encoded.values]
        core = types.SimpleNamespace(device='cuda', device_index=[0], n_mels=128, is_multilingual=True,
                                     generate=Mock(side_effect=generate))
        model = types.SimpleNamespace(model=core, encode=Mock(side_effect=encode), feature_extractor=Extractor(),
            hf_tokenizer=object(), logger=Mock(), max_length=448, frames_per_second=50, input_stride=2, time_precision=.02,
            get_prompt=Mock(return_value=[1, 2, 3]))
        model._split_segments_by_timestamps = lambda **options: module.WhisperModel._split_segments_by_timestamps(model, **options)
        def factory(recognizer, size):
            bridge = EncoderGpuBridge(recognizer, size, gpuops=types.SimpleNamespace(concat_axis0=concat))
            adapters.append(bridge); return bridge
        samples = np.concatenate([np.full(15 * 16000, (index + 1) / 10, dtype='<f4') for index in range(4)])
        message = {'audio': base64.b64encode(samples.tobytes()).decode(), 'language': 'en', 'context': '',
                   'decodingPolicy': POLICY, 'batchSize': 4, 'clipSeconds': 15, 'gpuEncoderBridge': True}
        tokenizer = types.SimpleNamespace(timestamp_begin=50000, decode=lambda tokens: ' clip-' + str(tokens[0]))
        with patch.object(module, 'Tokenizer', return_value=tokenizer), patch.object(module, 'get_suppressed_tokens', return_value=[]), \
                patch.object(bridge_module, 'EncoderGpuBridge', side_effect=factory):
            response = transcribe(model, message)
        np.testing.assert_array_equal(np.concatenate(inputs), samples)
        self.assertEqual([value.shape[0] for value in encode_batches], [1, 1, 1, 1])
        self.assertEqual(len(decode_batches), 1)
        self.assertEqual(response['batch']['gpuEncoderBridge']['batches'][0]['decoderBatchSize'], 4)
        self.assertEqual(response['batch']['gpuEncoderBridge']['batches'][0]['budgetedBridgePeakBytes'], 48 * 1024**2)
        self.assertEqual(response['text'], 'clip-1 clip-2 clip-3 clip-4')
        self.assertEqual(adapters[0]._held_outputs, []); self.assertIsNone(adapters[0]._last_output)
        core.generate.side_effect = RuntimeError('simulated decoder failure')
        with patch.object(module, 'Tokenizer', return_value=tokenizer), patch.object(module, 'get_suppressed_tokens', return_value=[]), \
                patch.object(bridge_module, 'EncoderGpuBridge', side_effect=factory):
            with self.assertRaisesRegex(RuntimeError, 'decoder failure'): transcribe(model, message)
        self.assertEqual(adapters[-1]._held_outputs, [])


if __name__ == '__main__':
    unittest.main()
