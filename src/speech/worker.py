"""Local-only JSON-lines ASR worker. No Codex, Notion or cloud API dependency."""
import argparse
import json
import os
from pathlib import Path
import socket
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--discover', action='store_true')
parser.add_argument('--model', choices=['medium', 'large-v3-turbo'], default='medium')
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
from recognition import transcribe as recognize
def send(data):
    print(json.dumps(data, ensure_ascii=False), flush=True)
if arguments.discover:
    try:
        send({'ok': True, 'runtime': discover_backend(root, arguments.model)})
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
    return recognize(recognizer, message)
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
