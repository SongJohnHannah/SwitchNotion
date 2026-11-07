import base64
import io
import hashlib


def decode_recording(message):
    language = message.get('language', 'auto')
    policy = message.get('decodingPolicy')
    if language not in ('auto', 'en', 'zh') or policy not in (None, 'stable-gpu-v1', 'stable-gpu-v1-greedy') or message.get('context', '') != '':
        raise RuntimeError('Invalid recording language or decoding policy')
    import av
    import numpy as np
    encoded = message.get('audio')
    if not isinstance(encoded, str) or len(encoded) > 24 * 1024**2:
        raise RuntimeError('Recording too large')
    data = base64.b64decode(encoded, validate=True)
    if len(data) > 16 * 1024**2 or not data.startswith(b'\x1a\x45\xdf\xa3'):
        raise RuntimeError('Expected browser WebM recording')
    parts = []
    count = 0
    with av.open(io.BytesIO(data), mode='r') as container:
        resampler = av.AudioResampler(format='fltp', layout='mono', rate=16000)
        for frame in container.decode(audio=0):
            for mono in resampler.resample(frame):
                samples = mono.to_ndarray().reshape(-1)
                count += samples.size
                if count > 61 * 16000:
                    raise RuntimeError('Recording longer than one minute')
                parts.append(samples)
        for mono in resampler.resample(None):
            samples = mono.to_ndarray().reshape(-1)
            count += samples.size
            if count > 61 * 16000:
                raise RuntimeError('Recording longer than one minute')
            parts.append(samples)
    if not parts:
        raise RuntimeError('Empty recording')
    # Keep the browser codec's bounded tail. Silently slicing at 60 seconds can
    # remove the end of a word; the recognizer validates this decoded provenance.
    samples = np.concatenate(parts).astype('<f4')
    if not np.isfinite(samples).all():
        raise RuntimeError('Invalid decoded samples')
    np.clip(samples, -1, 1, out=samples)
    pcm = samples.tobytes()
    return {'audio': base64.b64encode(pcm).decode('ascii'), 'language': language, 'context': '',
            **({'decodingPolicy': policy} if policy is not None else {}),
            'recordingDecode': {'pcmSha256': hashlib.sha256(pcm).hexdigest(), 'samples': len(samples),
                                'sampleRate': 16000, 'channels': 1, 'sampleFormat': 'f32le'}}
