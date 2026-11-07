import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// This experiment never writes into the validated CT2 source/build tree.
// It compiles one private C++ object and relinks the remaining existing inputs.
const root = path.resolve(import.meta.dirname, '..');
const base = path.join(root, '.notion-switch/speech/gpu-v1');
const stage = path.join(base, 'fp16-accum-v1-stage');
const ct2 = path.join(base, 'ct2-sm75');
const sourceRoot = path.join(ct2, 'source');
const oldBuild = path.join(ct2, 'build');
const oldSource = path.join(sourceRoot, 'src/models/whisper.cc');
const oldObject = path.join(oldBuild, 'ctranslate2.dir/Release/src/models/whisper.cc.obj');
const attentionSource = path.join(sourceRoot, 'src/layers/attention.cc');
const clTlog = path.join(oldBuild, 'ctranslate2.dir/Release/ctranslate2.tlog/CL.command.1.tlog');
const linkTlog = path.join(oldBuild, 'ctranslate2.dir/Release/ctranslate2.tlog/link.command.1.tlog');
const oldDef = path.join(oldBuild, 'ctranslate2.dir/Release/exports.def');
const oldDll = path.join(oldBuild, 'Release/ctranslate2.dll');
const nativePackage = path.join(base, 'variants/sm75-native/ctranslate2');
const toolsRoot = 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools';
const vcbin = path.join(toolsRoot, 'VC/Tools/MSVC/14.44.35207/bin/HostX86/x64');
const cl = path.join(vcbin, 'cl.exe');
const linker = path.join(vcbin, 'link.exe');
const vcvars = path.join(toolsRoot, 'VC/Auxiliary/Build/vcvars64.bat');
const privateSource = path.join(stage, 'source/src/models/whisper.cc');
const privateObject = path.join(stage, 'obj/models-whisper.cc.obj');
const privateDef = path.join(stage, 'exports.def');
const privateDll = path.join(stage, 'Release/ctranslate2.dll');
const compileRsp = path.join(stage, 'compile.rsp');
const linkRsp = path.join(stage, 'link.rsp');
const manifestPath = path.join(stage, 'build-manifest.json');

const norm = file => path.resolve(file).replaceAll('/', '\\').toLowerCase();
function sha(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function snapshot(file) { return { path: file, bytes: fs.statSync(file).size, sha256: sha(file) }; }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function onlyReplace(text, pattern, replacement, count, description) {
  let seen = 0;
  const result = text.replace(pattern, (...args) => { seen++; return typeof replacement === 'function' ? replacement(...args) : replacement; });
  assert(seen === count, `${description}: expected ${count} replacements, got ${seen}`);
  return result;
}

assert(!fs.existsSync(stage), `Refusing to overwrite a previous stage: ${stage}`);
for (const directory of ['source/src/models', 'obj', 'Release', 'tmp']) fs.mkdirSync(path.join(stage, directory), { recursive: true });
const sourceBytes = fs.readFileSync(oldSource);
const pristine = sourceBytes.toString('utf8');
const from = 'const cuda::UseTrueFp16GemmInScope use_true_fp16_gemm(false);';
const to = 'const cuda::UseTrueFp16GemmInScope use_true_fp16_gemm(cuda::use_true_fp16_gemm());';
const patches = pristine.split(/\r?\n/).flatMap((line, index) => line.includes(from) ? [{ line: index + 1, before: from, after: to }] : []);
assert(JSON.stringify(patches.map(patch => patch.line)) === '[84,241,471,592]', 'Unexpected Whisper guard locations');
const patched = onlyReplace(pristine, /const cuda::UseTrueFp16GemmInScope use_true_fp16_gemm\(false\);/g, to, 4, 'private Whisper guards');
assert(fs.readFileSync(attentionSource, 'utf8').includes(from), 'Expected attention FP32 accumulation guard absent');
fs.writeFileSync(path.join(stage, 'source/whisper.cc.pristine'), sourceBytes);
fs.writeFileSync(privateSource, patched);
fs.copyFileSync(oldDef, privateDef);

const clLines = fs.readFileSync(clTlog, 'utf16le').replace(/^\uFEFF/, '').split(/\r?\n/);
const clIndex = clLines.findIndex(line => norm(line.replace(/^\^/, '')) === norm(oldSource));
assert(clIndex >= 0 && clLines[clIndex + 1]?.startsWith('/c '), 'Original model whisper CL command absent');
let compile = clLines[clIndex + 1];
assert(!/\/(?:GL|Yu|Fp)\b/i.test(compile), 'Unexpected LTO/PCH flags require a different isolated build');
compile = onlyReplace(compile, /\/Fo"[^"]+"/g, `/Fo"${privateObject}"`, 1, 'private object output');
compile = onlyReplace(compile, /\/Fd"[^"]+"/g, `/Fd"${path.join(stage, 'obj/compiler.pdb')}"`, 1, 'private compiler PDB');
const oldSourceToken = oldSource.toUpperCase().replaceAll('/', '\\');
assert(compile.toUpperCase().endsWith(oldSourceToken), 'Expected source argument at end of CL command');
compile = compile.slice(0, -oldSourceToken.length) + `"${privateSource}"`;
fs.writeFileSync(compileRsp, `${compile}\n`);

const linkLines = fs.readFileSync(linkTlog, 'utf16le').replace(/^\uFEFF/, '').split(/\r?\n/);
assert(linkLines[0].startsWith('^'), 'Original linker input header absent');
const originalObjectInputs = linkLines[0].slice(1).split('|');
assert(originalObjectInputs.length === 180, `Expected 180 original objects, got ${originalObjectInputs.length}`);
const originalInputSet = new Set(originalObjectInputs.map(norm));
const tokens = linkLines.slice(1).join('\n').match(/(?:[^\s"]|"[^"]*")+/g);
assert(tokens?.length, 'Empty linker command');
const outputSwitches = { OUT: privateDll, PDB: path.join(stage, 'Release/ctranslate2.pdb'), IMPLIB: path.join(stage, 'Release/ctranslate2.lib'), DEF: privateDef };
const switchesSeen = new Set();
const objects = [];
const libraries = [];
let replacedObjectCount = 0;
const rewritten = tokens.map(token => {
  const flag = token.match(/^\/(OUT|PDB|IMPLIB|DEF):/i);
  if (flag) {
    const key = flag[1].toUpperCase();
    assert(!switchesSeen.has(key), `Repeated output switch ${key}`);
    switchesSeen.add(key);
    return `/${key}:"${outputSwitches[key]}"`;
  }
  const value = token.replace(/^"|"$/g, '');
  if (/\.obj$/i.test(value)) {
    const original = path.resolve(oldBuild, value);
    assert(originalInputSet.has(norm(original)), `Unexpected linker object ${original}`);
    objects.push(original);
    const replacement = norm(original) === norm(oldObject) ? privateObject : original;
    if (replacement === privateObject) replacedObjectCount++;
    return `"${replacement}"`;
  }
  if (/\.lib$/i.test(value) && /[\\/]/.test(value)) {
    const absolute = path.resolve(oldBuild, value);
    libraries.push(absolute);
    return `"${absolute}"`;
  }
  assert(!/^\/(?:LTCG|LINKREPRO|ILK|MAP|ORDER|PGD|TLBOUT|ASSEMBLYMODULE|INCREMENTAL:YES)\b/i.test(token), `Unexpected side-effect/LTO linker option ${token}`);
  return token;
});
assert(objects.length === 180 && new Set(objects.map(norm)).size === 180 && replacedObjectCount === 1, 'Must replace exactly one of 180 object inputs');
assert(switchesSeen.size === 4, 'Missing isolated output switches');
rewritten.push(`/MANIFESTFILE:"${path.join(stage, 'Release/ctranslate2.dll.manifest')}"`);
fs.writeFileSync(linkRsp, `${rewritten.join('\n')}\n`);

const originals = [...new Set([oldSource, attentionSource, oldDll, oldObject, oldDef, clTlog, linkTlog,
  path.join(nativePackage, 'ctranslate2.dll'), path.join(nativePackage, '_ext.cp311-win_amd64.pyd'),
  ...objects, ...libraries])];
const manifest = {
  version: 1, variant: 'sm75-native-fp16-accum-v1', preparedAt: new Date().toISOString(),
  sourceCommit: '7f59ae114cba0f7d5fb1fe6099142e4c3b0037c8',
  compiler: snapshot(cl), linker: snapshot(linker),
  baselineInputs: originals.map(snapshot),
  pristineSource: snapshot(path.join(stage, 'source/whisper.cc.pristine')),
  patchedSource: snapshot(privateSource), patches,
  unchangedAttentionGuard: { file: attentionSource, line: 245, source: from },
  scope: 'env 0 keeps original FP32 accumulation; env 1 enables FP16 accumulation for main Whisper GEMMs; attention QK FP32 guard stays intact',
  compile: { executable: cl, args: [`@${compileRsp}`], cwd: stage, responseFile: snapshot(compileRsp) },
  link: { executable: linker, args: [`@${linkRsp}`], cwd: stage, responseFile: snapshot(linkRsp), reusedObjectCount: 179, privateObjectCount: 1, libraries },
  process: { windowsHide: true, priority: 'BELOW_NORMAL_PRIORITY_CLASS', maxParallelCompilers: 1, temp: path.join(stage, 'tmp') },
  validation: { gpuLoaded: false, gpuTested: false, modelLoaded: false, stable: false },
};
writeJson(manifestPath, manifest);
const commandFile = path.join(stage, 'build-private.cmd');
fs.writeFileSync(commandFile, `@echo off\r\ncall "${vcvars}" -vcvars_ver=14.44 > "${path.join(stage, 'vcvars.log')}" 2>&1\r\nif errorlevel 1 exit /b %errorlevel%\r\n"${cl}" @"${compileRsp}" > "${path.join(stage, 'compile.log')}" 2>&1\r\nif errorlevel 1 exit /b %errorlevel%\r\n"${linker}" @"${linkRsp}" > "${path.join(stage, 'link.log')}" 2>&1\r\nexit /b %errorlevel%\r\n`);
const launcher = path.join(stage, 'launch-build.py');
fs.writeFileSync(launcher, `import ctypes, json, os, subprocess, sys, time\nfrom pathlib import Path\nstage = Path(__file__).parent\nk = ctypes.windll.kernel32\nk.GetCurrentProcess.restype = ctypes.c_void_p\nk.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]\nif not k.SetPriorityClass(k.GetCurrentProcess(), 0x4000):\n    raise ctypes.WinError()\nos.environ['TEMP'] = str(stage / 'tmp')\nos.environ['TMP'] = str(stage / 'tmp')\nstarted = time.time()\nargs = [os.environ.get('COMSPEC', 'C:/Windows/System32/cmd.exe'), '/d', '/c', str(stage / 'build-private.cmd')]\nresult = subprocess.run(args, cwd=stage, creationflags=subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)\n(stage / 'launcher.log').write_bytes(result.stdout)\n(stage / 'launch-result.json').write_text(json.dumps({'args': args, 'cwd': str(stage), 'exitCode': result.returncode, 'elapsedSeconds': time.time() - started, 'gpuInvoked': False}, indent=2), encoding='utf8')\nsys.exit(result.returncode)\n`);
console.log(JSON.stringify({ stage, manifest: manifestPath, privateSource: manifest.patchedSource, patches: patches.map(patch => patch.line), untouchedObjectCount: 179, gpuInvoked: false }));
if (!process.argv.includes('--build')) process.exit(0);

const python = path.join(base, '../python/Scripts/python.exe');
const log = fs.createWriteStream(path.join(stage, 'launcher-stdout.log'));
const allowed = /^(?:PATH|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|HOMEDRIVE|HOMEPATH|COMSPEC|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|NUMBER_OF_PROCESSORS)$/i;
manifest.startedAt = new Date().toISOString();
writeJson(manifestPath, manifest);
const child = spawn(python, [launcher], {
  cwd: stage, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))),
    TEMP: path.join(stage, 'tmp'), TMP: path.join(stage, 'tmp'), PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
});
child.stdout.on('data', data => log.write(data));
child.stderr.on('data', data => log.write(data));
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
await new Promise(resolve => log.end(resolve));
manifest.completedAt = new Date().toISOString();
manifest.exitCode = code;
manifest.baselineUnchanged = manifest.baselineInputs.every(file => fs.statSync(file.path).size === file.bytes && sha(file.path) === file.sha256);
manifest.outputs = [privateSource, privateObject, privateDll, path.join(stage, 'Release/ctranslate2.lib'), path.join(stage, 'Release/ctranslate2.exp')].filter(file => fs.existsSync(file)).map(snapshot);
manifest.records = ['compile.rsp', 'link.rsp', 'build-private.cmd', 'launch-build.py', 'vcvars.log', 'compile.log', 'link.log', 'launch-result.json'].map(file => path.join(stage, file)).filter(file => fs.existsSync(file)).map(snapshot);
writeJson(manifestPath, manifest);
assert(manifest.baselineUnchanged, 'Original source/build/package inputs changed during build; do not publish');
console.log(JSON.stringify({ stage, exitCode: code, baselineUnchanged: manifest.baselineUnchanged, outputs: manifest.outputs, manifest: manifestPath }));
process.exitCode = code || 0;
