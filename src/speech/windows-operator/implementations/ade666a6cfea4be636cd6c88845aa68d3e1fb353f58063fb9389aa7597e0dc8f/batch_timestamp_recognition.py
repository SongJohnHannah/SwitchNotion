"""Experimental full-PCM batched decoding with generated timestamps.

This policy is opt-in and does not change Native30 or the existing batch policy.
Input coverage is audited independently from the number of text segments: a
silent clip may legitimately yield zero, and a spoken clip may yield many.
"""
import base64
import hashlib
import math
import time

from batch_recognition import (SAMPLE_RATE, MAX_AUDIO_BYTES,
                               MAX_AUDIO_BASE64_CHARS, full_coverage_clips)

POLICY = 'stable-gpu-v1-batched-timestamps'


def transcribe(recognizer, message, pipeline_factory=None):
    if recognizer is None:
        raise RuntimeError('Worker not configured')
    batch_size = message.get('batchSize')
    if message.get('decodingPolicy') != POLICY or type(batch_size) is not int or batch_size not in (2, 4):
        raise RuntimeError('Generated-timestamp policy requires batchSize 2 or 4')
    clip_seconds = message.get('clipSeconds', 15 if batch_size == 4 else 30)
    if type(clip_seconds) is not int or clip_seconds not in (15, 30):
        raise RuntimeError('Generated-timestamp policy requires 15 or 30 second clips')
    if message.get('encoderMicrobatchSize', 0) != 0:
        raise RuntimeError('Generated-timestamp policy does not enable an encoder bridge')
    language = message.get('language', 'en')
    if language not in ('auto', 'en', 'zh') or message.get('context', '') != '':
        raise RuntimeError('Invalid generated-timestamp language or context')
    audio = message.get('audio')
    if not isinstance(audio, str) or len(audio) > MAX_AUDIO_BASE64_CHARS:
        raise RuntimeError('Invalid audio size')
    data = base64.b64decode(audio, validate=True)
    if not data or len(data) % 4 or len(data) > MAX_AUDIO_BYTES:
        raise RuntimeError('Expected at most 240 seconds of 16kHz mono Float32 LE PCM')
    import numpy as np
    samples = np.frombuffer(data, dtype='<f4')
    if not np.isfinite(samples).all() or np.abs(samples).max() > 1.01:
        raise RuntimeError('Invalid PCM samples')
    ranges, clips = full_coverage_clips(len(samples), batch_size, clip_seconds)
    if pipeline_factory is None:
        from faster_whisper import BatchedInferencePipeline
        pipeline_factory = BatchedInferencePipeline
    pipeline = pipeline_factory(recognizer)
    # Observe the standard forward seam without changing features, operators or
    # generated tokens. One output list per clip can contain zero or many items.
    original_forward = pipeline.forward
    observed = []
    frames_per_second = float(recognizer.frames_per_second)
    if not math.isfinite(frames_per_second) or frames_per_second <= 0:
        raise RuntimeError('Invalid recognizer timestamp frame rate')

    def audited_forward(features, tokenizer, metadata, options):
        first = len(observed)
        if len(features) != len(metadata) or len(metadata) > batch_size:
            raise RuntimeError('Generated-timestamp batch metadata shape changed')
        for relative, item in enumerate(metadata):
            index = first + relative
            if index >= len(ranges):
                raise RuntimeError('Generated-timestamp pipeline duplicated an input clip')
            bounds = ranges[index]
            source_segments = item.get('segments')
            if source_segments != [{'start': bounds['startSample'], 'end': bounds['endSample']}]:
                raise RuntimeError('Generated-timestamp pipeline changed exact input clip samples')
            if (abs(float(item['offset']) - bounds['startSample'] / SAMPLE_RATE) > 1e-9 or
                    abs(float(item['duration']) - (bounds['endSample'] - bounds['startSample']) / SAMPLE_RATE) > 1e-9):
                raise RuntimeError('Generated-timestamp pipeline changed input clip timing')
        outputs = original_forward(features, tokenizer, metadata, options)
        if len(outputs) != len(metadata) or any(not isinstance(output, list) for output in outputs):
            raise RuntimeError('Generated-timestamp decoder did not return one output list per input clip')
        observed.extend({'clipIndex': first + index, **ranges[first + index],
                         'generatedSegmentCount': len(output)} for index, output in enumerate(outputs))
        return outputs

    pipeline.forward = audited_forward
    before = time.perf_counter()
    try:
        segments, info = pipeline.transcribe(
            samples, language=None if language == 'auto' else language,
            task='transcribe', beam_size=1, best_of=1, patience=1.5,
            temperature=0, condition_on_previous_text=False, initial_prompt=None,
            multilingual=language == 'auto', language_detection_threshold=.8,
            language_detection_segments=3, batch_size=batch_size,
            vad_filter=False, clip_timestamps=clips, chunk_length=30,
            without_timestamps=False, word_timestamps=False,
        )
        segments = list(segments)
    finally:
        pipeline.forward = original_forward
    duration = len(samples) / SAMPLE_RATE
    if (not math.isfinite(float(info.duration)) or not math.isfinite(float(info.duration_after_vad)) or
            abs(float(info.duration) - duration) > 1 / SAMPLE_RATE or
            abs(float(info.duration_after_vad) - duration) > 1 / SAMPLE_RATE):
        raise RuntimeError('Generated-timestamp pipeline changed the covered audio duration')
    if len(observed) != len(ranges):
        raise RuntimeError('Generated-timestamp pipeline did not process every input clip')
    processed_samples = sum(item['endSample'] - item['startSample'] for item in observed)
    if processed_samples != len(samples) or sum(item['generatedSegmentCount'] for item in observed) != len(segments):
        raise RuntimeError('Generated-timestamp pipeline coverage/output accounting changed')
    seek_to_clip = {int(bounds['startSample'] / SAMPLE_RATE * frames_per_second): index
                    for index, bounds in enumerate(ranges)}
    result, warnings = [], []
    for order, segment in enumerate(segments):
        if (not isinstance(segment.text, str) or not math.isfinite(segment.start) or
                not math.isfinite(segment.end) or segment.end < segment.start):
            raise RuntimeError('Invalid generated transcript segment')
        clip_index = seek_to_clip.get(segment.seek)
        if clip_index is None:
            raise RuntimeError('Generated transcript segment references an unknown input clip')
        bounds = ranges[clip_index]
        start, end = bounds['startSample'] / SAMPLE_RATE, bounds['endSample'] / SAMPLE_RATE
        # Preserve the real generated values and text. Timestamp overrun is an
        # observable model issue, not evidence that audio beyond this clip ran.
        if segment.start < start - .005 or segment.end > end + .005:
            warnings.append({'code': 'generated-timestamp-outside-input-clip', 'pipelineOrder': order,
                             'clipIndex': clip_index, 'start': segment.start, 'end': segment.end})
        result.append({'start': segment.start, 'end': segment.end, 'text': segment.text,
                       'pipelineStart': segment.start, 'pipelineEnd': segment.end, 'pipelineOrder': order,
                       'clipIndex': clip_index, 'inputClipStart': start, 'inputClipEnd': end,
                       'avgLogprob': segment.avg_logprob, 'noSpeechProbability': segment.no_speech_prob,
                       'compressionRatio': segment.compression_ratio})
    result.sort(key=lambda item: (item['start'], item['end'], item['pipelineOrder']))
    text = ''.join(item['text'] for item in result).strip()
    if len(text) > 50000:
        raise RuntimeError('Transcript too long')
    reliable = ''.join(item['text'] for item in result if item['avgLogprob'] >= -.8
                       and item['noSpeechProbability'] < .6 and item['compressionRatio'] < 2.4)
    return {'text': text, 'segments': result, 'language': info.language,
            'contextText': reliable[-120:], 'elapsedMs': round((time.perf_counter() - before) * 1000),
            'batch': {'policy': POLICY, 'requestedBatchSize': batch_size,
                      'effectiveBatchSize': min(batch_size, len(ranges)), 'clipCount': len(ranges),
                      'inputSamples': len(samples), 'processedSamples': processed_samples, 'removedSamples': 0,
                      'inputFloat32Sha256': hashlib.sha256(data).hexdigest(),
                      'sampleRate': SAMPLE_RATE, 'vadFilter': False, 'vadIgnoredByExplicitClips': True,
                      'duration': info.duration, 'durationAfterVad': info.duration_after_vad,
                      'timestampMode': 'generated', 'wordTimestamps': False,
                      'clipSeconds': clip_seconds, 'clipRanges': ranges, 'clipProcessing': observed,
                      'generatedSegments': len(result), 'timestampWarnings': warnings,
                      'ordering': 'stable-start-end-pipeline-order',
                      'qualityScope': 'All PCM clips processed; generated timestamps do not prove every spoken word was transcribed.'}}
