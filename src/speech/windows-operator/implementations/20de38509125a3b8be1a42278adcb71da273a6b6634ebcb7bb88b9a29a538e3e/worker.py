"""Local-only JSON-lines ASR worker. No Codex, Notion or cloud API dependency."""
import argparse
import json
import os
from pathlib import Path
import socket
import sys
import faulthandler
import datetime
import traceback
sys.path.insert(0, str(Path(__file__).resolve().parent))
faulthandler.enable(file=sys.stderr, all_threads=True)

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--discover', action='store_true')
parser.add_argument('--model', choices=['medium', 'large-v3-turbo'], default='medium')
arguments = parser.parse_args()
root = Path(arguments.root)
if not root.is_absolute():
    raise SystemExit('Absolute local state directory required')
(root / 'speech').mkdir(parents=True, exist_ok=True)
native_fault_log = (root / 'speech' / ('native-faults-' + str(os.getpid()) + '.log')).open('a', encoding='utf-8')
faulthandler.enable(file=native_fault_log, all_threads=True)
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1',
                  CUDA_CACHE_PATH=str(root / 'speech/cuda-cache'), PYTHONDONTWRITEBYTECODE='1')
def no_network(*_a, **_k):
    raise RuntimeError('Network access disabled in offline ASR worker')
socket.create_connection = no_network
socket.socket.connect = no_network
socket.socket.connect_ex = no_network
sys.stdout.reconfigure(encoding='utf-8', errors='strict')
sys.dont_write_bytecode = True
from faster_backend import configure as configure_backend, discover as discover_backend, loaded_library_audit, cuda_memory_info
from recognition import transcribe as recognize
def send(data):
    if isinstance(data.get('result'), dict):
        data['result']['workerPid'] = os.getpid()
    print(json.dumps(data, ensure_ascii=False), flush=True)
if arguments.discover:
    try:
        send({'ok': True, 'runtime': discover_backend(root, arguments.model)})
    except Exception:
        send({'ok': False, 'error': 'OFFLINE_RUNTIME_NOT_FOUND'})
    raise SystemExit(0)

recognizer = None
configured = None
request_cuda_memory = None
def save_library_audit():
    try:
        audit_directory = root / 'speech/gpu-v1/library-audits'
        audit_directory.mkdir(parents=True, exist_ok=True)
        file = audit_directory / (str(os.getpid()) + '.json')
        temporary = audit_directory / (str(os.getpid()) + '.json.tmp')
        temporary.write_text(json.dumps(loaded_library_audit(), ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(file)
    except Exception:
        pass  # Diagnostics must never replace the original recognition error.

def configure(runtime):
    global recognizer, configured
    if recognizer is not None:
        raise RuntimeError('Worker already configured')
    try:
        recognizer, configured = configure_backend(runtime)
    finally:
        save_library_audit()
    return configured
def transcribe(message):
    global request_cuda_memory
    request_cuda_memory = None
    memory_before = cuda_memory_info(configured)
    result = None
    try:
        if message.get('decodingPolicy') in ('stable-gpu-v1-batched', 'stable-gpu-v1-batched-timestamps'):
            if not configured or configured.get('device') != 'cuda' or configured.get('computeType') not in ('float16', 'int8_float16'):
                raise RuntimeError('Batched candidate requires configured CUDA float16 or int8_float16')
            if message.get('decodingPolicy') == 'stable-gpu-v1-batched-timestamps':
                from batch_timestamp_recognition import transcribe as recognize_batched
            else:
                from batch_recognition import transcribe as recognize_batched
            result = recognize_batched(recognizer, message)
        else:
            result = recognize(recognizer, message)
        return result
    finally:
        if memory_before is not None:
            request_cuda_memory = {'before': memory_before, 'after': cuda_memory_info(configured)}
            if isinstance(result, dict):
                result['cudaMemory'] = request_cuda_memory
        save_library_audit()  # Include components loaded lazily by the encoder.
while True:
    line = sys.stdin.readline(32 * 1024**2)
    if not line:
        break
    message = None
    request_cuda_memory = None
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
            decoded_recording = decode_recording(message)
            result = transcribe(decoded_recording)
            result['recordingDecode'] = decoded_recording['recordingDecode']
        elif kind == 'probe' and recognizer is not None:
            result = {**configured, 'ready': True}
        else:
            raise RuntimeError('Unsupported ASR request')
        send({'id': message['id'], 'ok': True, 'result': result})
    except Exception as error:
        failure = {'event': 'speech-worker-failure', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'pid': os.getpid(), 'requestId': message.get('id') if isinstance(message, dict) else None,
                          'kind': message.get('type') if isinstance(message, dict) else None,
                          'errorType': type(error).__name__, 'detail': str(error)[:2000], 'traceback': traceback.format_exc()[-12000:]}
        if request_cuda_memory is not None:
            failure['cudaMemory'] = request_cuda_memory
        encoded_failure = json.dumps(failure, ensure_ascii=False)
        with (root / 'speech/worker-failures.jsonl').open('a', encoding='utf-8') as log:
            log.write(encoded_failure + '\n')
        print(encoded_failure, file=sys.stderr, flush=True)
        send({'id': message.get('id') if isinstance(message, dict) else None,
              'ok': False, 'error': 'LOCAL_ASR_FAILED'})
