import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const home = path.resolve(import.meta.dirname, '..');
const base = path.join(home, '.notion-switch/speech/gpu-v1');
const stage = path.join(base, 'gpuops-stage');
const ct2 = path.join(base, 'ct2-sm75');
const python = path.join(base, '../python/Scripts/python.exe');
fs.mkdirSync(stage, { recursive: true });
const setup = `import ctypes,os
k=ctypes.windll.kernel32
k.GetCurrentProcess.restype=ctypes.c_void_p
k.SetPriorityClass.argtypes=[ctypes.c_void_p,ctypes.c_uint32]
if not k.SetPriorityClass(k.GetCurrentProcess(),0x4000): raise ctypes.WinError()
from setuptools import setup,Extension
import pybind11
setup(name='ct2-native-gpuops',version='0.1.0',ext_modules=[Extension('_ct2_gpuops',
 sources=[${JSON.stringify(path.join(home, 'src/speech/gpuops/concat.cpp'))}],
 include_dirs=[pybind11.get_include(),${JSON.stringify(path.join(ct2, 'source/include'))}],
 library_dirs=[${JSON.stringify(path.join(ct2, 'build/Release'))}],libraries=['ctranslate2'],
 extra_compile_args=['/std:c++17','/d2FH4-','/O2'])])
`;
fs.writeFileSync(path.join(stage, 'setup.py'), setup);
if (process.argv.includes('--prepare-only')) { console.log(stage); process.exit(0); }
const log = fs.createWriteStream(path.join(stage, 'build.log'), { flags: 'a' });
const allowed = /^(?:PATH|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|HOMEDRIVE|HOMEPATH|COMSPEC|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|NUMBER_OF_PROCESSORS)$/i;
const child = spawn(python, [path.join(stage, 'setup.py'), 'build_ext', '--build-lib', path.join(stage, 'dist'), '--build-temp', path.join(stage, 'build'), '--parallel', '1'], {
  cwd: stage, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))),
    PYTHONPATH: path.join(ct2, 'build-deps'), PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    CMAKE_BUILD_PARALLEL_LEVEL: '1', MAX_JOBS: '1' },
});
child.stdout.on('data', data => log.write(data)); child.stderr.on('data', data => log.write(data));
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
await new Promise(resolve => log.end(`\nGPUops build exit ${code}\n`, resolve));
console.log(JSON.stringify({ stage, code, log: path.join(stage, 'build.log') }));
process.exitCode = code || 0;
