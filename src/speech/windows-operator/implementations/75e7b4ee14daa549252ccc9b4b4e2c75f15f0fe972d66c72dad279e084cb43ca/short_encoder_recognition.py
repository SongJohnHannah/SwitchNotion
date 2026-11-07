"""Experimental short-mel CUDA route; trimming changes model mathematics."""
import json
import math
import sys
import time

from recognition import transcribe as stable_transcribe

POLICY = 'stable-gpu-v1-short-encoder'
CONFIG = {'minFrames': 1024, 'maxFrames': 3000, 'tailMargin': 32, 'alignment': 512}


def transcribe(recognizer, message):
    if not isinstance(message, dict) or message.get('decodingPolicy') != POLICY:
        raise RuntimeError('Invalid short encoder policy')
    config = message.get('shortEncoderConfig', {})
    if not isinstance(config, dict) or any(key not in CONFIG or type(value) is not int or value != CONFIG[key] for key, value in config.items()):
        raise RuntimeError('Invalid short encoder configuration')
    if type(message.get('batchSize', 1)) is not int or message.get('batchSize', 1) != 1:
        raise RuntimeError('Short encoder requires batch size 1')
    if recognizer is None or getattr(recognizer.model, 'device', None) != 'cuda':
        raise RuntimeError('Short encoder requires an existing CUDA model')
    if getattr(recognizer, '_short_encoder_active', False):
        raise RuntimeError('Short encoder is already active')
    import numpy as np
    n_mels = getattr(recognizer.model, 'n_mels', 128)
    if n_mels not in (80, 128):
        raise RuntimeError('Unsupported Whisper mel size')
    original_encode = recognizer.encode
    original_extractor = recognizer.feature_extractor
    had_encode = 'encode' in vars(recognizer)
    saved_encode = vars(recognizer).get('encode')
    had_extractor = 'feature_extractor' in vars(recognizer)
    saved_extractor = vars(recognizer).get('feature_extractor')
    diagnostics = {'policy': POLICY, 'config': dict(CONFIG), 'mathEquivalent': False,
                   'note': 'All source features are retained; removing unmasked padded positions can change self/cross-attention and output.',
                   'featureCalls': [], 'encodeCalls': []}
    state = {'source_frames': None}

    class FeatureCapture:
        def __getattr__(self, name):
            return getattr(original_extractor, name)

        def __call__(self, *args, **kwargs):
            values = original_extractor(*args, **kwargs)
            if isinstance(values, np.ndarray) and values.ndim == 2 and values.shape[0] == n_mels:
                state['source_frames'] = values.shape[-1]
                diagnostics['featureCalls'].append({'shape': list(values.shape), 'contentFrames': max(0, values.shape[-1] - 1)})
            else:
                state['source_frames'] = None
            return values

    def encode(features):
        if not isinstance(features, np.ndarray) or features.ndim not in (2, 3) or (features.ndim == 3 and features.shape[0] != 1):
            raise RuntimeError('Short encoder expects a batch-one numpy mel tensor')
        if features.shape[-2] != n_mels or not 1 <= features.shape[-1] <= 3000 or features.dtype != np.float32 or not np.isfinite(features).all():
            raise RuntimeError('Invalid short encoder mel tensor')
        width = features.shape[-1]
        occupied = np.flatnonzero(np.any(features != 0, axis=tuple(range(features.ndim - 1))))
        last_nonzero = int(occupied[-1] + 1) if len(occupied) else 0
        source_frames = state['source_frames']
        protected = min(width, max(last_nonzero, max(0, source_frames - 1))) if source_frames is not None else width
        desired = max(CONFIG['minFrames'], protected + CONFIG['tailMargin'])
        selected = min(width, int(math.ceil(desired / CONFIG['alignment']) * CONFIG['alignment']))
        # Only the standard 3000-frame pad_or_trim path has proven provenance.
        if width != 3000 or source_frames is None:
            selected = width
        if (selected + 1) // 2 == n_mels:
            raise RuntimeError('Encoded time would collide with raw-mel shape detection')
        if selected < width and (selected < source_frames or np.any(features[..., selected:] != 0)):
            raise RuntimeError('Refusing to trim original/nonzero mel columns')
        values = np.ascontiguousarray(features[..., :selected]) if selected < width else features
        item = {'originalShape': list(features.shape), 'newShape': list(values.shape), 'sourceFeatureFrames': source_frames,
                'contentFramesUpperBound': None if source_frames is None else max(0, source_frames - 1),
                'tailZeroFrames': width - last_nonzero, 'protectedFrames': protected, 'trimmedZeroFrames': width - selected,
                'onlyProvenPaddingRemoved': selected == width or selected >= source_frames,
                'mathEquivalent': False}
        before = time.perf_counter()
        try:
            return original_encode(values)
        except Exception as error:
            item['error'] = str(error)
            raise
        finally:
            item['encodeElapsedMs'] = round((time.perf_counter() - before) * 1000, 3)
            diagnostics['encodeCalls'].append(item)
            try:
                sys.stderr.write(json.dumps({'event': 'speech-short-encoder', **item}, ensure_ascii=False) + '\n')
                sys.stderr.flush()
            except OSError:
                pass

    recognizer._short_encoder_active = True
    try:
        recognizer.feature_extractor = FeatureCapture()
        recognizer.encode = encode
        forwarded = dict(message, decodingPolicy='stable-gpu-v1-greedy')
        result = stable_transcribe(recognizer, forwarded)
        result['shortEncoder'] = diagnostics
        return result
    except Exception as error:
        error.short_encoder = diagnostics
        raise
    finally:
        if had_encode:
            recognizer.encode = saved_encode
        else:
            del recognizer.encode
        if had_extractor:
            recognizer.feature_extractor = saved_extractor
        else:
            del recognizer.feature_extractor
        del recognizer._short_encoder_active
