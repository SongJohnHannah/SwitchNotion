"""CPU-only cross-pyd ABI check. Do not query or allocate any CUDA device."""
import json
import os
from pathlib import Path
import sys

variant = Path(sys.argv[1]).resolve()
project = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(project / 'src/speech'))
os.environ['NOTION_SWITCH_CT2_MODULE_PATH'] = str(variant)
import faster_backend
assert faster_backend.prepare_module_path() == variant
directories, _ = faster_backend.variant_library_paths(variant)
for directory in directories:
    faster_backend.DLL_HANDLES.append(os.add_dll_directory(directory))
import ctranslate2
import _ct2_gpuops
import numpy as np
assert Path(ctranslate2.__file__).parent.resolve() == variant / 'ctranslate2'
assert Path(_ct2_gpuops.__file__).parent.resolve() == variant
assert ctranslate2.__version__ == '4.8.5'
array = np.zeros((1, 4, 1280), dtype=np.float16)
view = ctranslate2.StorageView.from_array(array)
assert _ct2_gpuops.cpu_abi_check(view) == {'shape': [1, 4, 1280], 'bytes': array.nbytes}
try:
    _ct2_gpuops.concat_axis0([view])
except ValueError as error:
    assert 'requires CUDA StorageView inputs' in str(error)
else:
    raise AssertionError('GPU-only extension accepted a CPU input')
audit = faster_backend.loaded_library_audit()
assert any(item['name'].lower() == 'ctranslate2.dll' and Path(item['path']).resolve().parent == variant / 'ctranslate2'
           for item in audit['libraries'])
assert not any(item['name'].lower().startswith('cudnn') for item in audit['libraries'])
assert not any(item['name'].lower().startswith(('cublas', 'cudart')) and '_12.dll' in item['name'].lower() for item in audit['libraries'])
audit.update(dependencyImportChecked=True, cpuCrossPydStorageViewAbiChecked=True,
             cpuFallbackRejected=True, gpuApiInvoked=False, gpuInferenceExecuted=False,
             gpuValidationPending=True, extensionFile=str(Path(_ct2_gpuops.__file__).resolve()))
(variant / 'import-check.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'cpuAbiChecked': True, 'gpuValidationPending': True, 'extension': _ct2_gpuops.__file__}))
