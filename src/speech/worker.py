"""Local-only JSON-lines ASR worker. No Codex, Notion or cloud API dependency."""
import argparse
import base64
import json
import os
from pathlib import Path
import socket
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--discover', action='store_true')
arguments = parser.parse_args()
root = Path(arguments.root)
if not root.is_absolute():
    raise SystemExit('Absolute local state directory required')
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1',
                  CUDA_CACHE_PATH=str(root / 'speech/cuda-cache'), PYTHONDONTWRITEBYTECODE='1')
def no_network(*_a, **_k):
    raise RuntimeError('Network access disabled in offline ASR worker')
socket.create_connection = no_network
socket.socket.connect = no_network
socket.socket.connect_ex = no_network
sys.stdout.reconfigure(encoding='utf-8', errors='strict')
sys.dont_write_bytecode = True
from faster_backend import configure as configure_backend, discover as discover_backend
def send(data):
    print(json.dumps(data, ensure_ascii=False), flush=True)
if arguments.discover:
    try:
        send({'ok': True, 'runtime': discover_backend(root)})
    except Exception:
        send({'ok': False, 'error': 'OFFLINE_RUNTIME_NOT_FOUND'})
    raise SystemExit(0)

recognizer = None
configured = None
def configure(runtime):
    global recognizer, configured
    if recognizer is not None:
        raise RuntimeError('Worker already configured')
    recognizer, configured = configure_backend(runtime)
    return configured
def transcribe(message):
    if recognizer is None:
        raise RuntimeError('Worker not configured')
    audio = message.get('audio')
    if not isinstance(audio, str) or len(audio) > 6 * 1024**2:
        raise RuntimeError('Invalid audio size')
    data = base64.b64decode(audio, validate=True)
    if not data or len(data) % 4 or len(data) > 16000 * 4 * 60:
        raise RuntimeError('Expected 16kHz mono Float32 LE PCM')
    language = message.get('language', 'auto')
    if language not in ['auto', 'zh', 'en']:
        raise RuntimeError('Invalid language')
    import numpy as np
    samples = np.frombuffer(data, dtype='<f4')
    if not np.isfinite(samples).all() or np.abs(samples).max() > 1.01:
        raise RuntimeError('Invalid PCM samples')
    if np.sqrt(np.mean(samples**2)) < .001:
        return {'text': '', 'segments': [], 'elapsedMs': 0}
    before = time.perf_counter()
    segments, info = recognizer.transcribe(samples, language=None if language == 'auto' else language,
        beam_size=5, best_of=5, temperature=0, condition_on_previous_text=False,
        vad_filter=True, vad_parameters={'min_speech_duration_ms': 150,
            'min_silence_duration_ms': 350, 'speech_pad_ms': 150})
    result = [{'start': s.start, 'end': s.end, 'text': s.text} for s in segments]
    text = ''.join(s['text'] for s in result).strip()
    if len(text) > 50000:
        raise RuntimeError('Transcript too long')
    return {'text': text, 'segments': result, 'language': info.language,
            'elapsedMs': round((time.perf_counter() - before) * 1000)}
while True:
    line = sys.stdin.readline(32 * 1024**2)
    if not line:
        break
    message = None
    try:
        if not line.endswith('\n'):
            raise RuntimeError('Input too large')
        message = json.loads(line)
        if not isinstance(message.get('id'), int):
            raise RuntimeError('Invalid request ID')
        kind = message.get('type')
        if kind == 'configure':
            if message.get('protocolVersion') != 1:
                raise RuntimeError('Unsupported speech protocol version')
            result = configure(message['runtime'])
        elif kind == 'transcribe':
            result = transcribe(message)
        elif kind == 'transcribe_recording':
            from recording_decode import decode_recording
            result = transcribe(decode_recording(message))
        elif kind == 'probe' and recognizer is not None:
            result = {**configured, 'ready': True}
        else:
            raise RuntimeError('Unsupported ASR request')
        send({'id': message['id'], 'ok': True, 'result': result})
    except Exception:
        send({'id': message.get('id') if isinstance(message, dict) else None,
              'ok': False, 'error': 'LOCAL_ASR_FAILED'})
