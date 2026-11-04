"""Reference Whisper forward using Transformers, for operator validation.

This is a development/reference tool only; the shipped engine will not depend
on PyTorch or Transformers.
"""
import argparse
import json
import time
import wave
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[3]
DEFAULT_MODEL = REPO / '.notion-switch/speech/whisper-large-v3-turbo-hf'


def read_wav(path):
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
    if rate != 16000:
        times = np.arange(audio.size, dtype=np.float64) / rate
        target = np.arange(int(audio.size * 16000 / rate), dtype=np.float64) / 16000
        audio = np.interp(target, times, audio).astype(np.float32)
    return audio


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default=str(DEFAULT_MODEL))
    parser.add_argument('--wav', required=True)
    parser.add_argument('--language', default=None)
    parser.add_argument('--dtype', choices=['float16', 'float32'], default='float16')
    parser.add_argument('--dump-dir', default=None)
    args = parser.parse_args()

    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    dtype = torch.float16 if args.dtype == 'float16' and device == 'cuda' else torch.float32
    processor = WhisperProcessor.from_pretrained(args.model, local_files_only=True)
    model = WhisperForConditionalGeneration.from_pretrained(
        args.model, local_files_only=True, torch_dtype=dtype).to(device).eval()

    audio = read_wav(args.wav)
    features = processor(audio, sampling_rate=16000, return_tensors='pt').input_features.to(device, dtype)

    if args.dump_dir:
        out = Path(args.dump_dir)
        out.mkdir(parents=True, exist_ok=True)
        np.save(out / 'input_features.npy', features.float().cpu().numpy())
        with torch.inference_mode():
            encoder = model.model.encoder(features).last_hidden_state
        np.save(out / 'encoder_last_hidden_state.npy', encoder.float().cpu().numpy())

    kwargs = {'task': 'transcribe', 'max_new_tokens': 440, 'num_beams': 1, 'do_sample': False}
    if args.language:
        kwargs['language'] = args.language
    else:
        kwargs['language'] = None

    with torch.inference_mode():
        started = time.perf_counter()
        tokens = model.generate(features, **kwargs)
        elapsed = (time.perf_counter() - started) * 1000.0
    text = processor.batch_decode(tokens, skip_special_tokens=True)[0]
    print(json.dumps({'text': text, 'ms': round(elapsed, 1), 'device': device,
                      'dtype': args.dtype, 'tokens': tokens[0].tolist()}, ensure_ascii=False))


if __name__ == '__main__':
    main()
