import base64
import io


def decode_recording(message):
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
    samples = np.concatenate(parts)[:60 * 16000].astype('<f4')
    if not np.isfinite(samples).all():
        raise RuntimeError('Invalid decoded samples')
    np.clip(samples, -1, 1, out=samples)
    return {'audio': base64.b64encode(samples.tobytes()).decode('ascii'), 'language': 'auto'}
