"""Opt-in Native30 decoder without the outer acoustic_chunks subdivision.

It submits original PCM once to standard WhisperModel transcribe (30s by
default; explicitly selected 60/120/240s windows are processed sequentially by
its fixed 30s internal encoder windows). VAD, generated timestamps and padding
remain in that method; this does not guarantee a single encode.
"""
import base64
import hashlib
import math
import time

SAMPLE_RATE = 16000
MAX_AUDIO_BYTES = SAMPLE_RATE * 4 * 240
MAX_AUDIO_BASE64_CHARS = ((MAX_AUDIO_BYTES + 2) // 3) * 4
POLICY = 'stable-gpu-v1-native-window'
VAD_PARAMETERS = {'min_speech_duration_ms': 150,
                  'min_silence_duration_ms': 350,
                  'speech_pad_ms': 150}


def transcribe(recognizer, message):
    if recognizer is None:
        raise RuntimeError('Worker not configured')
    if message.get('decodingPolicy') != POLICY:
        raise RuntimeError('Native-window policy must be explicitly selected')
    if type(message.get('batchSize', 1)) is not int or message.get('batchSize', 1) != 1:
        raise RuntimeError('Native-window policy requires scalar batchSize 1')
    window_seconds = message.get('nativeWindowSeconds', 30)
    if type(window_seconds) is not int or window_seconds not in (30, 60, 120, 240):
        raise RuntimeError('Native-window seconds must be explicitly 30, 60, 120 or 240')
    window_bytes = SAMPLE_RATE * 4 * window_seconds
    language = message.get('language', 'en')
    if language not in ('auto', 'en', 'zh') or message.get('context', '') != '':
        raise RuntimeError('Invalid native-window language or context')
    audio = message.get('audio')
    if not isinstance(audio, str) or len(audio) > ((window_bytes + 2) // 3) * 4:
        raise RuntimeError('Invalid audio size')
    data = base64.b64decode(audio, validate=True)
    if not data or len(data) % 4 or len(data) > window_bytes:
        raise RuntimeError('PCM exceeds the declared native-window seconds')
    import numpy as np
    samples = np.frombuffer(data, dtype='<f4')
    if not np.isfinite(samples).all() or np.abs(samples).max() > 1.01:
        raise RuntimeError('Invalid PCM samples')

    observed = []
    original_encode = recognizer.encode

    def observed_encode(features, *args, **kwargs):
        shape = list(features.shape)
        observation = {'numpyFeaturesShape': shape,
                       'expectedStorageViewShape': [1] + shape if len(shape) == 2 else shape,
                       'dtype': str(features.dtype)}
        observed.append(observation)
        before_encode = time.perf_counter()
        try:
            return original_encode(features, *args, **kwargs)
        finally:
            observation['elapsedMs'] = round((time.perf_counter() - before_encode) * 1000, 3)

    # Worker requests are serialized. Only this request's Python method is
    # observed; every feature tensor and return value reaches the original
    # encoder unchanged. Restoration also covers lazy generator failures.
    before = time.perf_counter()
    recognizer.encode = observed_encode
    try:
        segments, info = recognizer.transcribe(
            samples, language=None if language == 'auto' else language,
            task='transcribe', beam_size=1, best_of=1, patience=1.5,
            temperature=0, condition_on_previous_text=False, initial_prompt=None,
            multilingual=language == 'auto', language_detection_threshold=.8,
            language_detection_segments=3, without_timestamps=False,
            chunk_length=30,
            vad_filter=True, vad_parameters=dict(VAD_PARAMETERS),
        )
        segments = list(segments)
    finally:
        recognizer.encode = original_encode

    duration = len(samples) / SAMPLE_RATE
    reported_duration = float(info.duration)
    speech_duration = float(info.duration_after_vad)
    if (not math.isfinite(reported_duration) or not math.isfinite(speech_duration) or
            abs(reported_duration - duration) > 1 / SAMPLE_RATE or
            speech_duration < 0 or speech_duration > duration + 1 / SAMPLE_RATE):
        raise RuntimeError('Native-window decoder returned invalid audio durations')
    result = []
    for order, segment in enumerate(segments):
        if (not isinstance(segment.text, str) or not math.isfinite(segment.start) or
                not math.isfinite(segment.end) or segment.end < segment.start):
            raise RuntimeError('Invalid native-window transcript segment')
        # Preserve standard Whisper/VAD restored timestamps, including any
        # model timestamp overrun. Content review must see the raw return.
        result.append({'start': segment.start, 'end': segment.end, 'text': segment.text,
                       'pipelineOrder': order, 'avgLogprob': segment.avg_logprob,
                       'noSpeechProbability': segment.no_speech_prob,
                       'compressionRatio': segment.compression_ratio})
    text = ''.join(item['text'] for item in result).strip()
    if len(text) > 50000:
        raise RuntimeError('Transcript too long')
    reliable = ''.join(item['text'] for item in result if item['avgLogprob'] >= -.8
                       and item['noSpeechProbability'] < .6 and item['compressionRatio'] < 2.4)
    return {'text': text, 'segments': result, 'language': info.language,
            'contextText': reliable[-120:], 'elapsedMs': round((time.perf_counter() - before) * 1000),
            'nativeWindow': {'policy': POLICY, 'inputSamples': len(samples),
                             'submittedSamples': len(samples), 'sampleRate': SAMPLE_RATE,
                             'inputFloat32Sha256': hashlib.sha256(data).hexdigest(),
                             'outerAcousticSubdivision': False, 'transcribeCalls': 1,
                             'declaredWindowSeconds': window_seconds, 'internalChunkSeconds': 30,
                             'inputDuration': duration, 'reportedDuration': reported_duration,
                             'speechDuration': speech_duration,
                             'vadRemovedSeconds': max(0, duration - speech_duration),
                             'vadFilter': True, 'vadParameters': dict(VAD_PARAMETERS),
                             'timestampMode': 'generated-vad-restored', 'encoderCalls': len(observed),
                             'encoderObservations': observed,
                             'qualityScope': 'All input PCM submitted once; VAD may remove silence before encoding. Encode count and timestamps do not prove every spoken word was transcribed.'}}
