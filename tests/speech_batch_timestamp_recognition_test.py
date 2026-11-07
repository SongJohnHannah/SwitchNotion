"""CPU tests use real faster-whisper batching; only the GPU forward is mocked."""
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
import batch_timestamp_recognition as candidate
import batch_recognition as baseline_batch


class Extractor:
    sampling_rate = 16000
    chunk_length = 30

    def __init__(self):
        self.inputs = []

    def __call__(self, audio):
        self.inputs.append(audio.copy())
        return np.ones((80, 4), dtype=np.float32)


class TimestampBatch(unittest.TestCase):
    def message(self, samples, size=2, clip=30):
        return {'audio': base64.b64encode(samples.astype('<f4').tobytes()).decode(),
                'decodingPolicy': candidate.POLICY, 'language': 'en', 'context': '',
                'batchSize': size, 'clipSeconds': clip}

    def run_seam(self, audio, size=2, clip=30, output_mode='normal', bad_duration=False):
        module = importlib.import_module('faster_whisper.transcribe')
        extractor = Extractor()
        model = types.SimpleNamespace(feature_extractor=extractor, frames_per_second=50,
                                      model=types.SimpleNamespace(is_multilingual=True),
                                      logger=Mock(), hf_tokenizer=object())
        pipeline = module.BatchedInferencePipeline(model)
        calls = []

        def forward(features, tokenizer, metadata, options):
            calls.append((metadata, options))
            outputs = []
            for item in metadata:
                # Exactly silent input is still extracted, encoded and reaches
                # this seam, but may return no text segments.
                index = int(item['offset'] / clip)
                if index == 1:
                    outputs.append([])
                    continue
                start, duration = item['offset'], item['duration']
                entries = []
                for offset, end, text in ((0, duration / 2, ' first'),
                                          (duration / 2, duration, ' second')):
                    entries.append({'seek': int(start * 50), 'start': start + offset,
                                    'end': start + end, 'text': text, 'avg_logprob': -.2,
                                    'no_speech_prob': .01, 'compression_ratio': 1, 'tokens': [1]})
                if output_mode == 'overrun': entries[-1]['end'] += 2
                if output_mode == 'out-of-order': entries.reverse()
                outputs.append(entries)
            if output_mode == 'missing-output-list': outputs.pop()
            return outputs

        pipeline.forward = Mock(side_effect=forward)
        original_transcribe = pipeline.transcribe

        def with_bad_info(*args, **kwargs):
            segments, info = original_transcribe(*args, **kwargs)
            return segments, types.SimpleNamespace(duration=info.duration,
                duration_after_vad=info.duration_after_vad - 1, language=info.language)

        if bad_duration: pipeline.transcribe = with_bad_info
        with patch.object(module, 'Tokenizer', return_value=object()), \
                patch.object(module, 'get_suppressed_tokens', return_value=[]), \
                patch.object(module, 'get_speech_timestamps') as vad, \
                patch.object(module, 'collect_chunks') as collect, \
                patch.object(module, 'restore_speech_timestamps') as restore:
            response = candidate.transcribe(model, self.message(audio, size, clip),
                                             pipeline_factory=lambda recognizer: pipeline)
        vad.assert_not_called(); collect.assert_not_called(); restore.assert_not_called()
        np.testing.assert_array_equal(np.concatenate(extractor.inputs), audio)
        return response, calls, extractor

    def test_multiple_segments_and_empty_silence_clip_keep_every_sample(self):
        for size, clip in ((2, 30), (4, 15)):
            with self.subTest(size=size, clip=clip):
                samples = ((np.arange(90 * 16000) % 1000) / 5000).astype('<f4')
                samples[clip * 16000:2 * clip * 16000] = 0
                response, calls, extractor = self.run_seam(samples, size, clip)
                batch = response['batch']
                self.assertEqual(batch['inputSamples'], len(samples))
                self.assertEqual(batch['processedSamples'], len(samples))
                self.assertEqual(batch['removedSamples'], 0)
                self.assertEqual(batch['timestampMode'], 'generated')
                self.assertEqual(batch['clipProcessing'][1]['generatedSegmentCount'], 0)
                self.assertEqual(len(response['segments']), (len(extractor.inputs) - 1) * 2)
                self.assertTrue(all(not options.without_timestamps for _, options in calls))
                self.assertTrue(all(options.beam_size == 1 and options.temperatures == [0] for _, options in calls))

    def test_exact_fractional_tail_and_all_silence_are_not_discarded(self):
        audio = np.zeros(59 * 16000 + 19, dtype='<f4')
        response, calls, extractor = self.run_seam(audio, 4, 15)
        self.assertEqual(response['batch']['clipRanges'][-1]['endSample'], len(audio))
        self.assertEqual(response['batch']['processedSamples'], len(audio))
        self.assertEqual(sum(len(value) for value in extractor.inputs), len(audio))
        self.assertAlmostEqual(response['segments'][-1]['end'], len(audio) / 16000, delta=.00051)

    def test_malformed_dropped_forward_output_is_not_confused_with_empty_clip(self):
        with self.assertRaisesRegex(RuntimeError, 'one output list per input clip'):
            self.run_seam(np.zeros(60 * 16000, dtype='<f4'), output_mode='missing-output-list')

    def test_duration_mismatch_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'covered audio duration'):
            self.run_seam(np.zeros(60 * 16000, dtype='<f4'), bad_duration=True)

    def test_generated_timestamp_overrun_is_preserved_and_flagged_without_invented_clip_coverage(self):
        response, _, _ = self.run_seam(np.zeros(60 * 16000, dtype='<f4'), output_mode='overrun')
        self.assertEqual(response['segments'][1]['end'], 32)
        self.assertEqual(response['segments'][1]['inputClipEnd'], 30)
        self.assertTrue(response['batch']['timestampWarnings'])

    def test_generated_segments_are_stably_sorted_and_original_pipeline_order_retained(self):
        response, _, _ = self.run_seam(np.zeros(60 * 16000, dtype='<f4'), output_mode='out-of-order')
        self.assertEqual(response['text'], 'first second')
        self.assertEqual([item['pipelineOrder'] for item in response['segments']], [1, 0])

    def test_explicit_new_policy_does_not_accept_or_mutate_default_or_old_batch(self):
        factory = Mock()
        message = self.message(np.zeros(16000, dtype='<f4'))
        for changes in ({'decodingPolicy': 'stable-gpu-v1-greedy'},
                        {'decodingPolicy': baseline_batch.POLICY}, {'batchSize': 8},
                        {'batchSize': True}, {'clipSeconds': 20}, {'context': 'previous'},
                        {'encoderMicrobatchSize': 2}, {'gpuEncoderBridge': 1}):
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                candidate.transcribe(object(), {**message, **changes}, pipeline_factory=factory)
        factory.assert_not_called()
        self.assertEqual(baseline_batch.POLICY, 'stable-gpu-v1-batched')


if __name__ == '__main__':
    unittest.main()
