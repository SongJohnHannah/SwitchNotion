"""Opt-in full-coverage batched candidate; the established decoder is unchanged."""
import base64
import math
import time

SAMPLE_RATE = 16000
POLICY = 'stable-gpu-v1-batched'
MAX_REQUEST_SECONDS = 240
MAX_AUDIO_BYTES = SAMPLE_RATE * 4 * MAX_REQUEST_SECONDS
MAX_AUDIO_BASE64_CHARS = ((MAX_AUDIO_BYTES + 2) // 3) * 4


def seconds_for_sample(sample):
    """Round-trip through faster-whisper's int(seconds * 16000) exactly."""
    seconds = sample / SAMPLE_RATE
    for _ in range(8):
        actual = int(seconds * SAMPLE_RATE)
        if actual == sample:
            return seconds
        seconds = math.nextafter(seconds, math.inf if actual < sample else -math.inf)
    raise RuntimeError('Cannot represent exact audio clip boundary')


def full_coverage_clips(samples, batch_size, clip_seconds=None):
    # Preserve the original 2x30s / 4x15s defaults exactly. New larger requests
    # explicitly select 30s clips; the final clip remains its original length.
    if clip_seconds is None:
        clip_seconds = 15 if batch_size == 4 else 30
    if type(clip_seconds) is not int or not 1 <= clip_seconds <= 30:
        raise RuntimeError('Batched clips must be between 1 and 30 seconds')
    width = clip_seconds * SAMPLE_RATE
    ranges = [{'startSample': start, 'endSample': min(start + width, samples)}
              for start in range(0, samples, width)]
    clips = [{'start': seconds_for_sample(item['startSample']),
              'end': seconds_for_sample(item['endSample'])} for item in ranges]
    if sum(item['endSample'] - item['startSample'] for item in ranges) != samples:
        raise RuntimeError('Batch audio does not cover every input sample')
    return ranges, clips


def transcribe(recognizer, message, pipeline_factory=None):
    if recognizer is None:
        raise RuntimeError('Worker not configured')
    if message.get('decodingPolicy') != POLICY or type(message.get('batchSize')) is not int or message.get('batchSize') not in (2, 3, 4, 8):
        raise RuntimeError('Batched policy requires batchSize 2, 3, 4 or 8')
    batch_size = message['batchSize']
    encoder_microbatch_size = message.get('encoderMicrobatchSize', 0)
    if type(encoder_microbatch_size) is not int or encoder_microbatch_size not in (0, 1, 2):
        raise RuntimeError('Encoder microbatch size must be 0, 1 or 2')
    if encoder_microbatch_size and batch_size not in (4, 8):
        raise RuntimeError('Encoder bridge candidate requires decoder batch 4 or 8')
    clip_seconds = message.get('clipSeconds')
    if clip_seconds is None:
        clip_seconds = 15 if batch_size == 4 else 30
    if type(clip_seconds) is not int or not 1 <= clip_seconds <= 30:
        raise RuntimeError('Batched clips must be between 1 and 30 seconds')
    language = message.get('language', 'en')
    if language not in ('auto', 'en', 'zh') or message.get('context', '') != '':
        raise RuntimeError('Invalid batched recognition language or context')
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
    encoder_bridge = None
    if encoder_microbatch_size:
        from encoder_bridge import EncoderMicrobatchBridge
        encoder_bridge = EncoderMicrobatchBridge(recognizer, encoder_microbatch_size)
        recognizer = encoder_bridge
    pipeline = pipeline_factory(recognizer)
    before = time.perf_counter()
    segments, info = pipeline.transcribe(
        samples, language=None if language == 'auto' else language,
        task='transcribe', beam_size=1, best_of=1, patience=1.5,
        temperature=0, condition_on_previous_text=False, initial_prompt=None,
        multilingual=language == 'auto', language_detection_threshold=.8,
        language_detection_segments=3, batch_size=batch_size,
        vad_filter=False, clip_timestamps=clips, chunk_length=30,
        without_timestamps=True, word_timestamps=False,
    )
    segments = list(segments)
    # Without generated timestamps the library emits one segment per supplied
    # clip. Refuse unexpected output rather than pretending a partial batch is
    # a successful complete transcript.
    if len(segments) != len(ranges):
        raise RuntimeError('Batched decoder did not return every requested audio clip')
    duration = len(samples) / SAMPLE_RATE
    if abs(float(info.duration) - duration) > .001 or abs(float(info.duration_after_vad) - duration) > .001:
        raise RuntimeError('Batched pipeline changed the covered audio duration')
    result = []
    for segment, bounds in zip(segments, ranges):
        start, end = bounds['startSample'] / SAMPLE_RATE, bounds['endSample'] / SAMPLE_RATE
        if not isinstance(segment.text, str) or not math.isfinite(segment.start) or not math.isfinite(segment.end):
            raise RuntimeError('Invalid batched transcript segment')
        if abs(segment.start - start) > .005 or abs(segment.end - end) > .005:
            raise RuntimeError('Batched decoder changed an original clip timestamp')
        result.append({'start': start, 'end': end, 'text': segment.text,
                       'pipelineStart': segment.start, 'pipelineEnd': segment.end,
                       'avgLogprob': segment.avg_logprob, 'noSpeechProbability': segment.no_speech_prob,
                       'compressionRatio': segment.compression_ratio})
    text = ''.join(segment['text'] for segment in result).strip()
    if len(text) > 50000:
        raise RuntimeError('Transcript too long')
    reliable = ''.join(segment.text for segment in segments if segment.avg_logprob >= -.8
                       and segment.no_speech_prob < .6 and segment.compression_ratio < 2.4)
    response = {'text': text, 'segments': result, 'language': info.language,
            'contextText': reliable[-120:], 'elapsedMs': round((time.perf_counter() - before) * 1000),
            'batch': {'policy': POLICY, 'requestedBatchSize': batch_size,
                      'effectiveBatchSize': min(batch_size, len(ranges)), 'clipCount': len(ranges),
                      'inputSamples': len(samples), 'processedSamples': len(samples), 'removedSamples': 0,
                      'sampleRate': SAMPLE_RATE, 'vadFilter': False, 'vadIgnoredByExplicitClips': True,
                      'duration': info.duration, 'durationAfterVad': info.duration_after_vad,
                      'timestampMode': 'original-input-clip-bounds', 'wordTimestamps': False,
                      'clipSeconds': clip_seconds, 'clipRanges': ranges}}
    if encoder_bridge is not None:
        response['batch']['encoderBridge'] = encoder_bridge.metadata()
        response['batch']['encoderBridge']['languageDetectionMayEncodeSeparately'] = language == 'auto'
    return response
