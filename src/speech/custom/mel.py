"""Whisper log-mel front end in NumPy, matching transformers' feature extractor."""
import numpy as np

SAMPLE_RATE = 16000
N_FFT = 400
HOP = 160
N_MELS = 128
N_FRAMES = 3000


def read_wav(path):
    import wave
    with wave.open(str(path), 'rb') as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.getnframes()
        raw = handle.readframes(frames)
    if width == 2:
        audio = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    elif width == 4:
        audio = np.frombuffer(raw, dtype='<i4').astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f'Unsupported WAV sample width {width}')
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE:
        times = np.arange(audio.size, dtype=np.float64) / rate
        target = np.arange(int(audio.size * SAMPLE_RATE / rate), dtype=np.float64) / SAMPLE_RATE
        audio = np.interp(target, times, audio).astype(np.float32)
    return audio


def _hz_to_mel(frequency):
    frequency = np.asarray(frequency, dtype=np.float64)
    log_step = np.log(6.4) / 27.0
    linear = frequency / (200.0 / 3.0)
    logarithmic = 15.0 + np.log(np.maximum(frequency, 1e-10) / 1000.0) / log_step
    return np.where(frequency >= 1000.0, logarithmic, linear)


def _mel_to_hz(mel):
    mel = np.asarray(mel, dtype=np.float64)
    log_step = np.log(6.4) / 27.0
    return np.where(mel >= 15.0, 1000.0 * np.exp((mel - 15.0) * log_step), mel * (200.0 / 3.0))


def mel_filters():
    frequencies = np.linspace(0.0, SAMPLE_RATE / 2.0, 1 + N_FFT // 2)
    mel_points = np.linspace(_hz_to_mel(0.0), _hz_to_mel(8000.0), N_MELS + 2)
    hz_points = _mel_to_hz(mel_points)
    filters = np.zeros((N_MELS, frequencies.size), dtype=np.float32)
    for index in range(N_MELS):
        lower, center, upper = hz_points[index:index + 3]
        for bucket, frequency in enumerate(frequencies):
            if lower < frequency < center:
                weight = (frequency - lower) / (center - lower)
            elif center <= frequency < upper:
                weight = (upper - frequency) / (upper - center)
            else:
                continue
            filters[index, bucket] = weight * (2.0 / (upper - lower))
    return filters


def log_mel(audio):
    audio = np.asarray(audio, dtype=np.float32)
    if audio.size > 30 * SAMPLE_RATE:
        audio = audio[:30 * SAMPLE_RATE]
    else:
        audio = np.pad(audio, (0, 30 * SAMPLE_RATE - audio.size))
    padded = np.pad(audio, (N_FFT // 2, N_FFT // 2), mode='reflect')
    window = (0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(N_FFT) / N_FFT)).astype(np.float32)
    frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT)[::HOP][:N_FRAMES]
    spectrum = np.fft.rfft(frames * window, n=N_FFT, axis=1)
    power = spectrum.real ** 2 + spectrum.imag ** 2
    mel = power @ mel_filters().T
    log_spec = np.log10(np.maximum(mel, 1e-10))
    log_spec = np.maximum(log_spec, log_spec.max() - 8.0)
    return ((log_spec + 4.0) / 4.0).T.astype(np.float32)


def from_wav(path):
    return log_mel(read_wav(path))
