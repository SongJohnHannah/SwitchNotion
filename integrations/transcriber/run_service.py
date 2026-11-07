"""Start only the local web UI, without supervisor resume or browser launch."""
import json
import os
import sys
from pathlib import Path

target = Path(r'D:\www\claude\transcriber')
sys.path.insert(0, str(target))
os.environ['TRANSCRIBER_AUTO_RESUME'] = '0'

import app
import core
from waitress import serve

core.init_models()  # static bundle describe, not GPU model initialization
assert not core.state['queue'] and not core.state['transcribing']
gpu_modules = [name for name in sys.modules if name.split('.')[0] in ('torch', 'faster_whisper', 'ctranslate2')]
if gpu_modules:
    raise RuntimeError('UI startup unexpectedly imported an old GPU framework')
print(json.dumps({'event': 'web-service-start', 'pid': os.getpid(),
                  'host': '127.0.0.1', 'port': 3066,
                  'model': core.WHISPER_MODEL,
                  'resourcesReady': core.state['operator_ready'],
                  'gpuModulesImported': gpu_modules,
                  'queueResumed': False, 'browserOpened': False}, ensure_ascii=False), flush=True)
serve(app.app, host='127.0.0.1', port=3066)
