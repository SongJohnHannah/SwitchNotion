"""120s transport container with explicit, independently auditable inner routes."""
import base64
import hashlib
import math
import time

from recognition import transcribe as stable_transcribe
from segmentation import POLICY as ACOUSTIC_POLICY
from window_diagnostic_recognition import transcribe as diagnostic_transcribe, POLICY as DIAGNOSTIC_POLICY

POLICY = 'stable-gpu-v1-complete-window'
SAMPLE_RATE = 16000
INNER_SAMPLES = 30 * SAMPLE_RATE
MAX_BYTES = 120 * SAMPLE_RATE * 4


def transcribe(recognizer, message):
    if recognizer is None or not isinstance(message, dict) or message.get('decodingPolicy') != POLICY:
        raise RuntimeError('Complete-window policy must be explicitly selected')
    if type(message.get('nativeWindowSeconds')) is not int or message.get('nativeWindowSeconds') != 120:
        raise RuntimeError('Complete-window nativeWindowSeconds must be 120')
    mode = message.get('windowMode')
    if mode not in ('coverage-clips30', 'coverage-no-ts', 'stable30'):
        raise RuntimeError('Invalid complete-window mode')
    if type(message.get('batchSize', 1)) is not int or message.get('batchSize', 1) != 1:
        raise RuntimeError('Complete-window requires batchSize 1')
    if getattr(recognizer.model, 'device', None) != 'cuda' or getattr(recognizer.model, 'n_mels', 128) != 128:
        raise RuntimeError('Complete-window requires a CUDA Turbo model')
    language = message.get('language', 'en')
    if language not in ('auto', 'en', 'zh') or message.get('context', '') != '':
        raise RuntimeError('Invalid complete-window language/context')
    encoded = message.get('audio')
    if not isinstance(encoded, str) or len(encoded) > ((MAX_BYTES + 2) // 3) * 4:
        raise RuntimeError('Invalid complete-window audio size')
    data = base64.b64decode(encoded, validate=True)
    if not data or len(data) % 4 or len(data) > MAX_BYTES:
        raise RuntimeError('Complete-window PCM must be nonempty and at most 120 seconds')
    import numpy as np
    samples = np.frombuffer(data, dtype='<f4')
    if not np.isfinite(samples).all() or np.abs(samples).max() > 1.01:
        raise RuntimeError('Invalid complete-window PCM')
    metadata = {'policy': POLICY, 'mode': mode, 'containerSeconds': 120,
                'inputSamples': len(samples), 'inputFloat32Sha256': hashlib.sha256(data).hexdigest(),
                'sampleRate': SAMPLE_RATE, 'submittedSamples': 0, 'fullPcmSubmitted': False,
                'qualityScope': 'PCM coverage is checked; no reference transcript is read or copied. Baseline VAD/RMS and model accuracy still need content review.'}
    before = time.perf_counter()
    if mode != 'stable30':
        diagnostic_mode = 'vad-off-clips30' if mode == 'coverage-clips30' else 'vad-off-no-timestamps'
        # Only audio and actual decoder parameters reach the delegate.
        forwarded = {'audio': encoded, 'language': language, 'context': '', 'batchSize': 1,
                     'nativeWindowSeconds': 120, 'decodingPolicy': DIAGNOSTIC_POLICY, 'diagnosticMode': diagnostic_mode}
        result = diagnostic_transcribe(recognizer, forwarded)
        metadata.update({'submittedSamples': len(samples), 'fullPcmSubmitted': True, 'transcribeCalls': 1,
                         'innerRoute': diagnostic_mode, 'innerChunkSeconds': 30, 'outerAcousticSubdivision': False,
                         'single120SecondAcousticEncode': False,
                         'timestampMode': result.get('diagnostics', {}).get('timestampMode', 'unknown')})
        result['completeWindow'] = metadata
        return result
    metadata.update({'innerRoute': 'stable-gpu-v1-greedy', 'innerChunkSeconds': 30,
                     'innerAcousticMaximumSamples': ACOUSTIC_POLICY['maximumSamples'],
                     'innerAcousticMaximumSeconds': ACOUSTIC_POLICY['maximumSamples'] / SAMPLE_RATE,
                     'outerAcousticSubdivision': True, 'single120SecondAcousticEncode': False,
                     'timestampMode': 'original-native-segment-timestamps-with-inner-offset',
                     'parts': [], 'encoderObservations': [], 'completedPartSamples': 0})
    original_encode = recognizer.encode
    had_encode = 'encode' in vars(recognizer)
    saved_encode = vars(recognizer).get('encode')
    active = {'part': None}

    def observed_encode(features, *args, **kwargs):
        shape = list(features.shape)
        if shape not in ([128, 3000], [1, 128, 3000]):
            raise RuntimeError('Complete-window stable30 requires unchanged 128x3000 Native features')
        item = {'partIndex': active['part'], 'shape': shape, 'dtype': str(features.dtype)}
        metadata['encoderObservations'].append(item)
        started = time.perf_counter()
        try:
            return original_encode(features, *args, **kwargs)
        except Exception as error:
            item['error'] = str(error)
            raise
        finally:
            item['elapsedMs'] = round((time.perf_counter() - started) * 1000, 3)

    texts, segments, languages = [], [], set()
    recognizer.encode = observed_encode
    try:
        for index, start in enumerate(range(0, len(samples), INNER_SAMPLES)):
            end = min(start + INNER_SAMPLES, len(samples))
            part_data = data[start * 4:end * 4]
            part = {'index': index, 'startSample': start, 'endSample': end, 'samples': end - start,
                    'inputFloat32Sha256': hashlib.sha256(part_data).hexdigest()}
            metadata['parts'].append(part)
            metadata['submittedSamples'] += end - start
            active['part'] = index
            raw = stable_transcribe(recognizer, {'audio': base64.b64encode(part_data).decode('ascii'),
                'language': language, 'context': '', 'decodingPolicy': 'stable-gpu-v1-greedy'})
            part['rawResult'] = raw
            if not isinstance(raw.get('text'), str):
                raise RuntimeError('Invalid stable30 text')
            if raw['text'].strip():
                texts.append(raw['text'].strip())
            offset = start / SAMPLE_RATE
            for row in raw.get('segments', []):
                if not isinstance(row.get('text'), str) or not math.isfinite(row['start']) or not math.isfinite(row['end']) or row['end'] < row['start']:
                    raise RuntimeError('Invalid stable30 timestamp')
                segments.append({**row, 'start': row['start'] + offset, 'end': row['end'] + offset, 'innerPartIndex': index})
            languages.add(raw.get('language', 'auto'))
            metadata['completedPartSamples'] += end - start
        if metadata['completedPartSamples'] != len(samples) or metadata['submittedSamples'] != len(samples):
            raise RuntimeError('Stable30 inner parts do not cover complete PCM')
        metadata.update({'fullPcmSubmitted': True, 'partSamplesSum': sum(part['samples'] for part in metadata['parts']),
                         'transcribeCalls': len(metadata['parts']), 'lastPartSamples': metadata['parts'][-1]['samples'],
                         'hasShortTail': metadata['parts'][-1]['samples'] < INNER_SAMPLES})
        text = '\n'.join(texts)
        if len(text) > 50000:
            raise RuntimeError('Complete-window transcript too long')
        return {'text': text, 'segments': segments, 'language': next(iter(languages)) if len(languages) == 1 else 'auto',
                'contextText': metadata['parts'][-1]['rawResult'].get('contextText', ''),
                'elapsedMs': round((time.perf_counter() - before) * 1000), 'completeWindow': metadata}
    except Exception as error:
        error.complete_window = metadata
        raise
    finally:
        if had_encode:
            recognizer.encode = saved_encode
        else:
            del recognizer.encode
