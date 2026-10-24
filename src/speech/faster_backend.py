"""Platform-specific faster-whisper setup behind the shared JSONL interface."""
import importlib.metadata
import os
from pathlib import Path
import platform
import sys
import sysconfig
import time

DLL_HANDLES = []


def profile():
    machine = platform.machine().lower()
    # Python 3.11 platform.machine() on Windows reads PROCESSOR_* variables,
    # intentionally absent in our minimal worker environment. Inspect the
    # interpreter build instead, also rejecting a 32-bit Python executable.
    if sys.platform == 'win32' and sysconfig.get_platform() == 'win-amd64':
        return {'platform': 'win32', 'architecture': 'x64', 'device': 'cuda',
                'computeType': 'float16', 'cpuThreads': 4}
    if sys.platform == 'darwin' and machine in ('arm64', 'aarch64'):
        return {'platform': 'darwin', 'architecture': 'arm64', 'device': 'cpu',
                'computeType': 'int8', 'cpuThreads': 4}
    raise RuntimeError('Native Windows x64 or Apple Silicon ARM64 Python required')


def model_directory(directory):
    directory = Path(directory)
    if not directory.is_absolute() or not all((directory / n).is_file()
            for n in ['model.bin', 'config.json', 'tokenizer.json']):
        raise RuntimeError('Invalid local speech model directory')
    return directory


def discover(root, model_id='medium'):
    selected = profile()
    from faster_whisper.utils import download_model
    model = root / ('speech/faster-whisper-' + model_id)
    if not (model / 'model.bin').is_file():
        model = Path(download_model(model_id, local_files_only=True))
    model = model_directory(model)
    dll = None
    dll_directories = []
    if selected['device'] == 'cuda':
        candidates = [root / 'speech/gpu-libs', Path(sys.prefix) / 'Lib/site-packages/torch/lib']
        versions = Path.home() / '.pyenv/pyenv-win/versions'
        if versions.is_dir():
            candidates += [d / 'Lib/site-packages/torch/lib' for d in sorted(versions.iterdir(), reverse=True) if d.is_dir()]
        dll = next((d for d in candidates if all((d / f).is_file()
                   for f in ['cublas64_12.dll', 'cudnn64_9.dll'])), None)
        packages = Path(sys.prefix) / 'Lib/site-packages/nvidia'
        if dll is None:
            dll_directories = [packages / 'cublas/bin', packages / 'cudnn/bin', packages / 'cuda_runtime/bin']
        if dll is None and not all(d.is_dir() for d in dll_directories):
            raise RuntimeError('Local CUDA 12 and cuDNN 9 runtime not found')
    return {**selected, 'model': model_id, 'pythonExecutable': sys.executable, 'modelDirectory': str(model),
            'dllDirectory': str(dll) if dll else None, 'modelBytes': (model / 'model.bin').stat().st_size,
            'dllDirectories': [str(d) for d in dll_directories],
            'versions': {p: importlib.metadata.version(p) for p in ['faster-whisper', 'ctranslate2']}}


def configure(runtime):
    selected = profile()
    if any(runtime.get(k) != v for k, v in selected.items()):
        raise RuntimeError('Runtime belongs to another platform or compute backend')
    directory = model_directory(runtime['modelDirectory'])
    directories = ([runtime['dllDirectory']] if runtime.get('dllDirectory') else []) + runtime.get('dllDirectories', [])
    if selected['device'] == 'cuda':
        for value in directories:
            dll = Path(value)
            if not dll.is_absolute() or not dll.is_dir():
                raise RuntimeError('Invalid DLL directory')
            os.environ['PATH'] = str(dll) + os.pathsep + os.environ.get('PATH', '')
            DLL_HANDLES.append(os.add_dll_directory(str(dll)))
    elif directories:
        raise RuntimeError('Windows DLL paths cannot be used on macOS')
    import ctranslate2
    if selected['computeType'] not in ctranslate2.get_supported_compute_types(selected['device']):
        raise RuntimeError('Requested compute backend unavailable')
    from faster_whisper import WhisperModel
    from faster_whisper.vad import get_vad_model
    get_vad_model()  # Verify and warm the bundled local VAD, never download it.
    before = time.perf_counter()
    recognizer = WhisperModel(str(directory), device=selected['device'],
        compute_type=selected['computeType'], cpu_threads=selected['cpuThreads'],
        num_workers=1, local_files_only=True)
    if not recognizer.model.is_multilingual:
        raise RuntimeError('A multilingual model is required')
    status = {**selected, 'protocolVersion': 1, 'provider': 'faster-whisper', 'model': runtime.get('model', 'medium'),
              'offline': True, 'loadMs': round((time.perf_counter() - before) * 1000)}
    return recognizer, status
