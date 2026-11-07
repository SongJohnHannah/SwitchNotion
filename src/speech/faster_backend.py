"""Platform-specific faster-whisper setup behind the shared JSONL interface."""
import importlib.metadata
import ctypes
import json
import os
from pathlib import Path
import platform
import sys
import sysconfig
import time

DLL_HANDLES = []
CUDA_MEMINFO_FUNCTIONS = {}


def prepare_module_path():
    value = os.environ.get('NOTION_SWITCH_CT2_MODULE_PATH')
    if not value:
        return None
    directory = Path(value)
    if not directory.is_absolute() or not (directory / 'ctranslate2/__init__.py').is_file():
        raise RuntimeError('Invalid private CTranslate2 module directory')
    directory = directory.resolve()
    loaded = sys.modules.get('ctranslate2')
    if loaded is not None and (not getattr(loaded, '__file__', None) or
                               directory not in Path(loaded.__file__).resolve().parents):
        raise RuntimeError('Cannot replace an already loaded CTranslate2 package')
    while str(directory) in sys.path:
        sys.path.remove(str(directory))
    sys.path.insert(0, str(directory))
    return directory


def variant_library_paths(variant):
    manifest = variant / 'variant.json'
    if not manifest.is_file():
        return None, None
    try:
        data = json.loads(manifest.read_text(encoding='utf-8'))
        directories, libraries = data['dllDirectories'], data.get('preloadLibraries')
        if data.get('version') != 1 or not isinstance(directories, list) or not 1 <= len(directories) <= 8:
            raise ValueError()
        paths = []
        for value in directories:
            if not isinstance(value, str) or not value or '\x00' in value:
                raise ValueError()
            file = Path(value)
            paths.append(str((file if file.is_absolute() else variant / file).resolve()))
        if libraries is not None and (not isinstance(libraries, list) or not 1 <= len(libraries) <= 32 or
                any(not isinstance(name, str) or Path(name).name != name or not name.lower().endswith('.dll') for name in libraries)):
            raise ValueError()
        return paths, libraries
    except (KeyError, TypeError, ValueError, OSError):
        raise RuntimeError('Invalid private GPU runtime manifest') from None


def preload_cuda_libraries(directories, names=None):
    names = names or ['cudart64_12.dll', 'cublasLt64_12.dll', 'cublas64_12.dll', 'cudnn64_9.dll']
    files = [next((Path(directory) / name for directory in directories
                   if (Path(directory) / name).is_file()), None) for name in names]
    if any(file is None or not file.is_absolute() for file in files):
        raise RuntimeError('A complete CUDA 12/cuDNN 9 library set is required for explicit preload')
    for file in files:
        DLL_HANDLES.append(ctypes.WinDLL(str(file.resolve())))


def loaded_library_audit():
    """Inspect this process only; no CUDA or inference API is invoked."""
    package = sys.modules.get('ctranslate2')
    audit = {'pid': os.getpid(), 'moduleDirectory': os.environ.get('NOTION_SWITCH_CT2_MODULE_PATH'),
             'ctranslate2Package': getattr(package, '__file__', None), 'libraries': []}
    if sys.platform != 'win32':
        return audit
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    process = kernel.GetCurrentProcess()
    modules = (ctypes.c_void_p * 4096)()
    needed = wintypes.DWORD()
    psapi.EnumProcessModulesEx.argtypes = [wintypes.HANDLE, ctypes.POINTER(ctypes.c_void_p), wintypes.DWORD,
                                          ctypes.POINTER(wintypes.DWORD), wintypes.DWORD]
    psapi.EnumProcessModulesEx.restype = wintypes.BOOL
    psapi.GetModuleFileNameExW.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.LPWSTR, wintypes.DWORD]
    psapi.GetModuleFileNameExW.restype = wintypes.DWORD
    if not psapi.EnumProcessModulesEx(process, modules, ctypes.sizeof(modules), ctypes.byref(needed), 3):
        audit['error'] = 'EnumProcessModulesEx failed'
        return audit
    for module in modules[:min(len(modules), needed.value // ctypes.sizeof(ctypes.c_void_p))]:
        name = ctypes.create_unicode_buffer(32768)
        if psapi.GetModuleFileNameExW(process, module, name, len(name)):
            file = Path(name.value)
            if file.name.lower().startswith(('cudnn', 'cublas', 'cudart', 'ctranslate', 'nvcuda', '_ext.')):
                audit['libraries'].append({'name': file.name, 'path': str(file)})
    return audit


def cuda_memory_info(configured):
    """Optional context budget observation; never synchronizes or clears errors.

    Only cudaMemGetInfo from the single already loaded CUDART is called. Its
    return code is recorded verbatim, including asynchronous prior errors.
    A reported free amount is not a guarantee that an allocation will succeed.
    """
    if not configured or configured.get('device') != 'cuda' or os.environ.get('NOTION_SWITCH_SPEECH_CUDA_MEMINFO') != '1':
        return None
    before = time.perf_counter()
    result = {'freeBytes': None, 'totalBytes': None, 'returnCode': None, 'runtimePath': None,
              'diagnosticCode': None, 'capturedAtUnix': time.time()}
    try:
        audit = loaded_library_audit()
        candidates = {item['path'] for item in audit.get('libraries', [])
                      if item.get('name', '').lower() in ('cudart64_12.dll', 'cudart64_13.dll')}
        if len(candidates) != 1:
            result['diagnosticCode'] = 'MISSING_CUDART' if not candidates else 'AMBIGUOUS_CUDART'
            result['runtimeCandidates'] = sorted(candidates)
            return result
        path = candidates.pop()
        result['runtimePath'] = path
        if not Path(path).is_absolute():
            result['diagnosticCode'] = 'INVALID_CUDART_PATH'
            return result
        if path not in CUDA_MEMINFO_FUNCTIONS:
            library = ctypes.WinDLL(path)
            function = library.cudaMemGetInfo
            function.argtypes = [ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_size_t)]
            function.restype = ctypes.c_int
            CUDA_MEMINFO_FUNCTIONS[path] = (library, function)
        function = CUDA_MEMINFO_FUNCTIONS[path][1]
        free, total = ctypes.c_size_t(), ctypes.c_size_t()
        code = int(function(ctypes.byref(free), ctypes.byref(total)))
        result['returnCode'] = code
        if code == 0:
            result['freeBytes'], result['totalBytes'] = free.value, total.value
        else:
            result['diagnosticCode'] = 'CUDA_RUNTIME_ERROR'
        return result
    except Exception as error:
        result['diagnosticCode'] = 'QUERY_EXCEPTION'
        result['exceptionCode'] = getattr(error, 'winerror', None) or getattr(error, 'errno', None)
        result['exceptionType'] = type(error).__name__
        result['detail'] = str(error)[:240]
        return result
    finally:
        result['queryWallMs'] = round((time.perf_counter() - before) * 1000, 3)


def require_cuda_backend(selected, version):
    if selected['device'] != 'cuda':
        return
    try:
        parts = tuple(int(part) for part in version.split('.')[:3])
    except (ValueError, AttributeError):
        parts = ()
    if parts < (4, 8, 5):
        raise RuntimeError('GPU transcription requires CTranslate2 4.8.5 or newer; prepare the local speech environment again')


def profile():
    machine = platform.machine().lower()
    # Python 3.11 platform.machine() on Windows reads PROCESSOR_* variables,
    # intentionally absent in our minimal worker environment. Inspect the
    # interpreter build instead, also rejecting a 32-bit Python executable.
    if sys.platform == 'win32' and sysconfig.get_platform() == 'win-amd64':
        cpu = os.environ.get('NOTION_SWITCH_SPEECH_DEVICE') == 'cpu'
        precision = os.environ.get('NOTION_SWITCH_SPEECH_COMPUTE_TYPE', 'float16')
        if not cpu and precision not in ('float16', 'float32', 'int8_float16'):
            raise RuntimeError('Unsupported CUDA compute type')
        return {'platform': 'win32', 'architecture': 'x64', 'device': 'cpu' if cpu else 'cuda',
                'computeType': 'int8' if cpu else precision, 'cpuThreads': 4}
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
    variant = prepare_module_path()
    if variant and sys.platform == 'win32':
        directories, libraries = variant_library_paths(variant)
        for value in directories or []:
            if not Path(value).is_dir():
                raise RuntimeError('Invalid private GPU DLL directory')
            DLL_HANDLES.append(os.add_dll_directory(value))
        if os.environ.get('NOTION_SWITCH_SPEECH_PRELOAD_DLLS') == '1':
            preload_cuda_libraries(directories or [variant / 'gpu-libs'], libraries)
    selected = profile()
    require_cuda_backend(selected, importlib.metadata.version('ctranslate2'))
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
    variant = prepare_module_path()
    directories = ([runtime['dllDirectory']] if runtime.get('dllDirectory') else []) + runtime.get('dllDirectories', [])
    preload = os.environ.get('NOTION_SWITCH_SPEECH_PRELOAD_DLLS') == '1'
    libraries = None
    if variant:
        variant_directories, libraries = variant_library_paths(variant)
        if variant_directories:
            directories = variant_directories
        elif preload:
            directories = [str(variant / 'gpu-libs')]
    if selected['device'] == 'cuda':
        for value in directories:
            dll = Path(value)
            if not dll.is_absolute() or not dll.is_dir():
                raise RuntimeError('Invalid DLL directory')
            os.environ['PATH'] = str(dll) + os.pathsep + os.environ.get('PATH', '')
            DLL_HANDLES.append(os.add_dll_directory(str(dll)))
        if preload:
            preload_cuda_libraries(directories, libraries)
    elif directories:
        raise RuntimeError('Windows DLL paths cannot be used on macOS')
    import ctranslate2
    require_cuda_backend(selected, ctranslate2.__version__)
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
