"""Exercise the real batch splitting/mapping seam with only GPU forward mocked."""
import ast
import base64
import importlib
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch
import numpy as np

speech = Path(__file__).resolve().parents[1] / 'src/speech'
sys.path.insert(0, str(speech))
import batch_recognition as batch


class Extractor:
    sampling_rate = 16000
    chunk_length = 30

    def __init__(self):
        self.inputs = []

    def __call__(self, samples):
        self.inputs.append(samples.copy())
        return np.ones((80, 4), dtype=np.float32)


class BatchedPolicy(unittest.TestCase):
    def message(self, samples, batch_size=2, clip_seconds=None):
        result = {'audio': base64.b64encode(samples.astype('<f4').tobytes()).decode(), 'language': 'en',
                  'context': '', 'decodingPolicy': batch.POLICY, 'batchSize': batch_size}
        if clip_seconds is not None:
            result['clipSeconds'] = clip_seconds
        return result

    def real_pipeline(self):
        module = importlib.import_module('faster_whisper.transcribe')
        extractor = Extractor()
        model = types.SimpleNamespace(feature_extractor=extractor, model=types.SimpleNamespace(is_multilingual=True),
                                      logger=Mock(), hf_tokenizer=object())
        pipeline = module.BatchedInferencePipeline(model)
        calls = []

        def forward(features, tokenizer, metadata, options):
            calls.append({'batch': len(features), 'metadata': metadata, 'options': options})
            return [[{'seek': int(item['offset'] * 50), 'text': ' clip ' + str(index),
                      'start': item['offset'], 'end': item['offset'] + item['duration'],
                      'avg_logprob': -.2, 'no_speech_prob': .01, 'compression_ratio': 1, 'tokens': [1]}]
                    for index, item in enumerate(metadata)]

        pipeline.forward = Mock(side_effect=forward)
        return module, model, pipeline, extractor, calls

    def run_real_pipeline_seam(self, samples, batch_size, clip_seconds=None):
        module, model, pipeline, extractor, calls = self.real_pipeline()
        with patch.object(module, 'Tokenizer', return_value=object()), \
                patch.object(module, 'get_suppressed_tokens', return_value=[]), \
                patch.object(module, 'get_speech_timestamps') as vad, \
                patch.object(module, 'collect_chunks') as collect, \
                patch.object(module, 'restore_speech_timestamps') as restore:
            result = batch.transcribe(model, self.message(samples, batch_size, clip_seconds), pipeline_factory=lambda recognizer: pipeline)
        vad.assert_not_called()
        collect.assert_not_called()
        restore.assert_not_called()
        np.testing.assert_array_equal(np.concatenate(extractor.inputs), samples)
        self.assertEqual(sum(len(chunk) for chunk in extractor.inputs), len(samples))
        self.assertTrue(all(len(chunk) <= 30 * 16000 for chunk in extractor.inputs))
        model.logger.warning.assert_not_called()
        return result, calls

    def test_real_pipeline_receives_every_sample_and_batches_two_or_four_clips(self):
        samples = ((np.arange(60 * 16000, dtype=np.int32) % 1000) / 5000).astype('<f4')
        samples[10 * 16000:20 * 16000] = 0  # This silence must also enter the model.
        for size in (2, 4):
            with self.subTest(size=size):
                result, calls = self.run_real_pipeline_seam(samples, size)
                self.assertEqual([call['batch'] for call in calls], [size])
                self.assertEqual(len(result['segments']), size)
                self.assertEqual(result['batch']['removedSamples'], 0)
                self.assertEqual(result['batch']['processedSamples'], len(samples))
                self.assertEqual(result['segments'][0]['start'], 0)
                self.assertEqual(result['segments'][-1]['end'], 60)
                self.assertEqual(result['batch']['timestampMode'], 'original-input-clip-bounds')
                self.assertEqual(calls[0]['options'].beam_size, 1)
                self.assertEqual(calls[0]['options'].best_of, 1)
                self.assertEqual(calls[0]['options'].temperatures, [0])
                self.assertFalse(calls[0]['options'].condition_on_previous_text)
                self.assertTrue(calls[0]['options'].without_timestamps)

    def test_fractional_tail_has_exact_original_sample_end_not_a_truncated_second(self):
        samples = np.full(59 * 16000 + 19, .1, dtype='<f4')
        result, calls = self.run_real_pipeline_seam(samples, 4)
        self.assertEqual(result['segments'][-1]['end'], len(samples) / 16000)
        ranges = result['batch']['clipRanges']
        self.assertEqual(ranges[-1]['endSample'], len(samples))
        self.assertEqual(sum(item['endSample'] - item['startSample'] for item in ranges), len(samples))

    def test_real_three_four_or_eight_thirty_second_clips_keep_the_entire_long_input(self):
        for batch_size, seconds in ((3, 90), (4, 120), (8, 240)):
            with self.subTest(batch_size=batch_size):
                samples = ((np.arange(seconds * 16000, dtype=np.int32) % 1000) / 5000).astype('<f4')
                samples[20 * 16000:40 * 16000] = 0
                result, calls = self.run_real_pipeline_seam(samples, batch_size, 30)
                self.assertEqual([call['batch'] for call in calls], [batch_size])
                self.assertEqual(result['batch']['clipSeconds'], 30)
                self.assertEqual(result['batch']['requestedBatchSize'], batch_size)
                self.assertEqual(result['batch']['effectiveBatchSize'], batch_size)
                self.assertEqual(result['segments'][-1]['end'], seconds)
                self.assertEqual(result['batch']['removedSamples'], 0)
                self.assertEqual(result['batch']['inputSamples'], len(samples))

    def test_long_fractional_tail_keeps_fixed_thirty_second_boundaries(self):
        samples = np.full(239 * 16000 + 19, .1, dtype='<f4')
        result, calls = self.run_real_pipeline_seam(samples, 8, 30)
        ranges = result['batch']['clipRanges']
        self.assertEqual([item['startSample'] for item in ranges], [value * 16000 for value in range(0, 240, 30)])
        self.assertEqual(ranges[-1]['endSample'], len(samples))
        self.assertEqual(result['segments'][-1]['end'], len(samples) / 16000)
        self.assertEqual([call['batch'] for call in calls], [8])

    def test_all_silence_is_processed_instead_of_returning_a_fake_fast_result(self):
        samples = np.zeros(60 * 16000, dtype='<f4')
        result, calls = self.run_real_pipeline_seam(samples, 2)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result['batch']['inputSamples'], len(samples))
        self.assertEqual(result['batch']['durationAfterVad'], 60)

    def test_missing_output_clip_fails_instead_of_being_marked_complete(self):
        sample = np.full(60 * 16000, .1, dtype='<f4')
        segment = types.SimpleNamespace(text='only half', start=0, end=30, avg_logprob=-.2,
                                        no_speech_prob=.01, compression_ratio=1)
        pipeline = types.SimpleNamespace(transcribe=Mock(return_value=([segment], types.SimpleNamespace(duration=60, duration_after_vad=60))))
        with self.assertRaisesRegex(RuntimeError, 'every requested audio clip'):
            batch.transcribe(object(), self.message(sample), pipeline_factory=lambda recognizer: pipeline)

    def test_invalid_parameters_and_oversized_audio_do_not_reach_the_pipeline(self):
        samples = np.ones(16000, dtype='<f4') * .1
        factory = Mock()
        for extra in ({'batchSize': 1}, {'batchSize': 16}, {'clipSeconds': 31}, {'context': 'previous text'}, {'language': 'fr'}):
            with self.subTest(extra=extra), self.assertRaises(RuntimeError):
                batch.transcribe(object(), {**self.message(samples), **extra}, pipeline_factory=factory)
        with self.assertRaises(RuntimeError):
            batch.transcribe(object(), self.message(np.zeros(240 * 16000 + 1, dtype='<f4')), pipeline_factory=factory)
        factory.assert_not_called()

    def test_clip_seconds_round_trip_through_the_library_sample_conversion(self):
        for sample in range(0, 240 * 16000 + 1, 997):
            self.assertEqual(int(batch.seconds_for_sample(sample) * 16000), sample)

    def test_worker_dispatch_keeps_baseline_unchanged_and_requires_gpu_for_batch(self):
        tree = ast.parse((speech / 'worker.py').read_text(encoding='utf-8'))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'transcribe')
        model, recognize, batched = object(), Mock(return_value={'text': 'baseline'}), Mock(return_value={'text': 'batch'})
        namespace = {'recognizer': model, 'configured': {'device': 'cuda', 'computeType': 'float16'},
                     'recognize': recognize, 'save_library_audit': Mock(), 'cuda_memory_info': Mock(return_value=None)}
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'worker-dispatch', 'exec'), namespace)
        message = {'decodingPolicy': 'stable-gpu-v1-greedy', 'batchSize': 1}
        self.assertEqual(namespace['transcribe'](message), {'text': 'baseline'})
        recognize.assert_called_once_with(model, message)
        with patch.dict(sys.modules, {'batch_recognition': types.SimpleNamespace(transcribe=batched)}):
            message = {'decodingPolicy': batch.POLICY, 'batchSize': 2}
            self.assertEqual(namespace['transcribe'](message), {'text': 'batch'})
            batched.assert_called_once_with(model, message)
            batched.reset_mock()
            namespace['configured'] = {'device': 'cuda', 'computeType': 'int8_float16'}
            self.assertEqual(namespace['transcribe'](message), {'text': 'batch'})
            batched.assert_called_once_with(model, message)
            namespace['configured'] = {'device': 'cpu', 'computeType': 'int8'}
            with self.assertRaisesRegex(RuntimeError, 'CUDA float16'):
                namespace['transcribe'](message)

    def test_worker_memory_metadata_preserves_results_and_the_original_decode_exception(self):
        tree = ast.parse((speech / 'worker.py').read_text(encoding='utf-8'))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'transcribe')
        before = {'freeBytes': 10 * 1024**3, 'totalBytes': 16 * 1024**3, 'returnCode': 0}
        after = {'freeBytes': None, 'totalBytes': None, 'returnCode': 700}
        returned = {'text': 'unchanged recognition'}
        namespace = {'recognizer': object(), 'configured': {'device': 'cuda', 'computeType': 'float16'},
                     'recognize': Mock(return_value=returned), 'save_library_audit': Mock(),
                     'cuda_memory_info': Mock(side_effect=[before, after])}
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'worker-memory', 'exec'), namespace)
        self.assertIs(namespace['transcribe']({'decodingPolicy': 'stable-gpu-v1-greedy'}), returned)
        self.assertEqual(returned['text'], 'unchanged recognition')
        self.assertEqual(returned['cudaMemory'], {'before': before, 'after': after})
        error = RuntimeError('original CUDA failure')
        namespace['recognize'].side_effect = error
        namespace['cuda_memory_info'].side_effect = [before, after]
        with self.assertRaises(RuntimeError) as raised:
            namespace['transcribe']({'decodingPolicy': 'stable-gpu-v1-greedy'})
        self.assertIs(raised.exception, error)
        self.assertEqual(namespace['request_cuda_memory'], {'before': before, 'after': after})


if __name__ == '__main__':
    unittest.main()
