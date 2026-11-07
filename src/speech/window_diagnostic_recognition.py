"""Read-only observers around the exact NativeWindow decoder for local probes."""
import base64
import hashlib
import importlib
import math
import time

POLICY = 'stable-gpu-v1-window-diagnostic'
SAMPLE_RATE = 16000
VAD_PARAMETERS = {'min_speech_duration_ms': 150, 'min_silence_duration_ms': 350, 'speech_pad_ms': 150}


def transcribe(recognizer, message):
    if recognizer is None or not isinstance(message, dict) or message.get('decodingPolicy') != POLICY:
        raise RuntimeError('Window diagnostic policy must be explicitly selected')
    mode = message.get('diagnosticMode')
    if mode not in ('vad-on', 'vad-off', 'vad-off-clips30', 'vad-off-no-timestamps'):
        raise RuntimeError('Invalid window diagnosticMode')
    if type(message.get('batchSize', 1)) is not int or message.get('batchSize', 1) != 1:
        raise RuntimeError('Window diagnostic requires scalar batchSize 1')
    window = message.get('nativeWindowSeconds', 120)
    if type(window) is not int or not 1 <= window <= 120:
        raise RuntimeError('Window diagnostic accepts at most 120 seconds')
    language = message.get('language', 'en')
    if language not in ('auto', 'en', 'zh') or message.get('context', '') != '':
        raise RuntimeError('Invalid diagnostic language or context')
    encoded = message.get('audio')
    maximum = SAMPLE_RATE * 4 * window
    if not isinstance(encoded, str) or len(encoded) > ((maximum + 2) // 3) * 4:
        raise RuntimeError('Invalid diagnostic audio size')
    data = base64.b64decode(encoded, validate=True)
    if not data or len(data) % 4 or len(data) > maximum:
        raise RuntimeError('Diagnostic PCM exceeds declared window')
    import numpy as np
    samples = np.frombuffer(data, dtype='<f4')
    if not np.isfinite(samples).all() or np.abs(samples).max() > 1.01:
        raise RuntimeError('Invalid diagnostic PCM')
    module = importlib.import_module('faster_whisper.transcribe')
    marker = '_notion_window_diagnostic_active'
    if getattr(module, marker, False):
        raise RuntimeError('Window diagnostic observers are already active')
    had_marker = hasattr(module, marker)
    old_marker = getattr(module, marker, None)
    original_vad = module.get_speech_timestamps
    planned_clips = [{'startSample': start, 'endSample': min(start + 30 * SAMPLE_RATE, len(samples)),
                      'start': start / SAMPLE_RATE, 'end': min(start + 30 * SAMPLE_RATE, len(samples)) / SAMPLE_RATE}
                     for start in range(0, len(samples), 30 * SAMPLE_RATE)] if mode == 'vad-off-clips30' else []
    clip_timestamps = [boundary for clip in planned_clips for boundary in (clip['start'], clip['end'])]
    without_timestamps = mode == 'vad-off-no-timestamps'
    diagnostics = {'policy': POLICY, 'mode': mode, 'inputSamples': len(samples), 'submittedSamples': len(samples),
                   'sampleRate': SAMPLE_RATE, 'inputFloat32Sha256': hashlib.sha256(data).hexdigest(),
                   'fullPcmSubmittedOnce': True, 'transcribeCalls': 1, 'outerAcousticSubdivision': False,
                   'internalChunkSeconds': 30, 'vadFilterRequested': mode == 'vad-on', 'vadCalls': [],
                   'plannedClipRanges': planned_clips, 'explicitClipBoundaries': bool(planned_clips),
                   'clipTimestampsArgument': clip_timestamps if planned_clips else None,
                   'withoutTimestamps': without_timestamps, 'wordTimestamps': False,
                   'timestampMode': 'coarse-window-bounds-no-generated-timestamps' if without_timestamps else 'generated-segment-timestamps',
                   'encoderCalls': [], 'seekTraces': [], 'generationTraces': [], 'observerErrors': [],
                   'vadCoordinates': 'original request PCM samples', 'seekCoordinates': 'post-VAD feature frames/time',
                   'outputCoordinates': 'original request time restored by standard FWM',
                   'qualityScope': 'Observers preserve inputs/outputs; submitted samples and timestamps do not prove every spoken word was emitted.'}

    def decode(tokenizer, tokens):
        try:
            return tokenizer.decode(tokens)
        except Exception as error:
            diagnostics['observerErrors'].append({'kind': 'token-decode', 'error': str(error)})
            return None

    def token_info(tokenizer, tokens):
        values = list(tokens or [])
        begin = getattr(tokenizer, 'timestamp_begin', None)
        precision = getattr(recognizer, 'time_precision', .02)
        return {'tokens': values, 'text': decode(tokenizer, values),
                'timestampTokens': [{'id': token, 'seconds': (token - begin) * precision}
                                    for token in values if begin is not None and token >= begin]}

    def observed_vad(*args, **kwargs):
        values = args[0] if args else kwargs.get('audio')
        item = {'inputSamples': len(values), 'inputFloat32Sha256': hashlib.sha256(np.asarray(values, dtype='<f4').tobytes()).hexdigest()}
        diagnostics['vadCalls'].append(item)
        before = time.perf_counter()
        try:
            ranges = original_vad(*args, **kwargs)
            item['ranges'] = [{'start': int(row['start']), 'end': int(row['end'])} for row in ranges]
            item['retainedSamples'] = sum(row['end'] - row['start'] for row in item['ranges'])
            return ranges
        finally:
            item['elapsedMs'] = round((time.perf_counter() - before) * 1000, 3)

    original_encode = recognizer.encode
    def observed_encode(features, *args, **kwargs):
        item = {'shape': list(features.shape), 'dtype': str(features.dtype)}
        diagnostics['encoderCalls'].append(item)
        before = time.perf_counter()
        try:
            return original_encode(features, *args, **kwargs)
        except Exception as error:
            item['error'] = str(error)
            raise
        finally:
            item['elapsedMs'] = round((time.perf_counter() - before) * 1000, 3)

    original_split = recognizer._split_segments_by_timestamps
    def observed_split(*args, **kwargs):
        bound = dict(zip(('tokenizer', 'tokens', 'time_offset', 'segment_size', 'segment_duration', 'seek'), args))
        bound.update(kwargs)
        item = {key: bound.get(key) for key in ('seek', 'segment_size', 'time_offset', 'segment_duration')}
        item.update(token_info(bound.get('tokenizer'), bound.get('tokens')))
        diagnostics['seekTraces'].append(item)
        returned = original_split(*args, **kwargs)
        try:
            current, next_seek, ending = returned
            item.update({'nextSeek': next_seek, 'singleTimestampEnding': ending,
                         'segments': [{**{key: row.get(key) for key in ('seek', 'start', 'end')},
                                       **token_info(bound.get('tokenizer'), row.get('tokens'))} for row in current]})
        except Exception as error:
            diagnostics['observerErrors'].append({'kind': 'split-observer', 'error': str(error)})
        return returned

    original_generate = getattr(recognizer, 'generate_with_fallback', None)
    def observed_generate(*args, **kwargs):
        bound = dict(zip(('encoder_output', 'prompt', 'tokenizer', 'options'), args))
        bound.update(kwargs)
        returned = original_generate(*args, **kwargs)
        try:
            result, avg, temperature, ratio = returned
            options = bound.get('options')
            threshold = getattr(options, 'no_speech_threshold', None)
            log_threshold = getattr(options, 'log_prob_threshold', None)
            skip = threshold is not None and result.no_speech_prob > threshold
            if log_threshold is not None and avg > log_threshold:
                skip = False
            diagnostics['generationTraces'].append({**token_info(bound.get('tokenizer'), result.sequences_ids[0]),
                'noSpeechProbability': result.no_speech_prob, 'avgLogprob': avg, 'temperature': temperature,
                'compressionRatio': ratio, 'noSpeechThreshold': threshold, 'logProbThreshold': log_threshold,
                'wouldSkipForNoSpeech': skip, 'promptTokens': list(bound.get('prompt') or [])})
        except Exception as error:
            diagnostics['observerErrors'].append({'kind': 'generation-observer', 'error': str(error)})
        return returned

    methods = {'encode': observed_encode, '_split_segments_by_timestamps': observed_split}
    if callable(original_generate):
        methods['generate_with_fallback'] = observed_generate
    originals = {key: (key in vars(recognizer), vars(recognizer).get(key)) for key in methods}
    before = time.perf_counter()
    setattr(module, marker, True)
    try:
        module.get_speech_timestamps = observed_vad
        for key, value in methods.items():
            setattr(recognizer, key, value)
        options = dict(language=None if language == 'auto' else language, task='transcribe', beam_size=1,
            best_of=1, patience=1.5, temperature=0, condition_on_previous_text=False, initial_prompt=None,
            multilingual=language == 'auto', language_detection_threshold=.8, language_detection_segments=3,
            without_timestamps=without_timestamps, chunk_length=30, vad_filter=mode == 'vad-on', vad_parameters=dict(VAD_PARAMETERS))
        if planned_clips:
            options['clip_timestamps'] = clip_timestamps
        segments, info = recognizer.transcribe(samples, **options)
        segments = list(segments)
    except Exception as error:
        error.window_diagnostics = diagnostics
        raise
    finally:
        module.get_speech_timestamps = original_vad
        for key, (had, value) in originals.items():
            if had:
                setattr(recognizer, key, value)
            else:
                delattr(recognizer, key)
        if had_marker:
            setattr(module, marker, old_marker)
        else:
            delattr(module, marker)
    duration = len(samples) / SAMPLE_RATE
    reported, speech = float(info.duration), float(info.duration_after_vad)
    if not math.isfinite(reported) or not math.isfinite(speech) or abs(reported - duration) > 1 / SAMPLE_RATE or not 0 <= speech <= duration + 1 / SAMPLE_RATE:
        raise RuntimeError('Window diagnostic returned invalid audio durations')
    result = []
    for index, segment in enumerate(segments):
        if not isinstance(segment.text, str) or not math.isfinite(segment.start) or not math.isfinite(segment.end) or segment.end < segment.start:
            raise RuntimeError('Invalid diagnostic transcript segment')
        result.append({'start': segment.start, 'end': segment.end, 'text': segment.text, 'pipelineOrder': index,
                       'avgLogprob': segment.avg_logprob, 'noSpeechProbability': segment.no_speech_prob, 'compressionRatio': segment.compression_ratio})
    text = ''.join(row['text'] for row in result).strip()
    if len(text) > 50000:
        raise RuntimeError('Diagnostic transcript too long')
    diagnostics.update({'inputDuration': duration, 'reportedDuration': reported, 'reportedSpeechDuration': speech,
                        'vadAppliedObserved': bool(diagnostics['vadCalls']),
                        'vadRemovedSeconds': max(0, duration - speech) if diagnostics['vadCalls'] else 0})
    reliable = ''.join(row['text'] for row in result if row['avgLogprob'] >= -.8 and row['noSpeechProbability'] < .6 and row['compressionRatio'] < 2.4)
    return {'text': text, 'segments': result, 'language': info.language, 'contextText': reliable[-120:],
            'elapsedMs': round((time.perf_counter() - before) * 1000), 'diagnostics': diagnostics}
