import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArguments, vendorWindowsGpuOperator } from '../scripts/vendor-windows-gpu-operator.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
async function put(root, file, data) {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, typeof data === 'object' && !Buffer.isBuffer(data) ? JSON.stringify(data, null, 2) + '\n' : data);
}
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vendor-gpu-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'original'), project = path.join(temp, 'project');
  const dll = Buffer.from('MZ-stable-native'), ready = Buffer.from('{"ready":true}\n');
  const variantRoot = 'resources/speech/gpu-v1/variants/sm75-native';
  const files = { 'worker.py': 'from pathlib import Path\nimport sys\nsys.path.insert(0, str(Path(__file__).resolve().parent))\n', 'gpu-file.cjs': 'module.exports={};\n', 'operator-session.cjs': 'module.exports={};\n', 'gpu-pipelined-file.cjs': 'module.exports={};\n' };
  const entries = Object.entries(files).map(([file, data]) => ({ file, bytes: Buffer.byteLength(data), sha256: sha(data) }));
  const revision = sha(JSON.stringify(entries));
  const snapshot = `experiments/implementations/${revision}`;
  for (const [file, data] of Object.entries(files)) await put(source, `${snapshot}/${file}`, data);
  await put(source, `${snapshot}/implementation.json`, {version:1,revision,sourceDirectory:'C:\\private',snapshotDirectory:'D:\\private',files:entries});
  const plan = { id:'stable-native',runtimeVariant:'sm75-native',runtimeRevision:sha(ready),computeType:'float16',chunkSeconds:30,beamSize:1 };
  for (const name of ['winner','native30','streaming','complete']) await put(source, `profiles/${name}.json`, plan);
  const profile = name => ({planFile:`profiles/${name}.json`,experimental:false,status:'validated-optional',entryFile:`${snapshot}/gpu-file.cjs`,implementationRevision:revision,medianSeconds:204.9925});
  const machine = { version:1,resourcesRoot:'resources',pythonExecutable:'resources/speech/python/python.exe',modelDirectory:'resources/speech/model',model:'large-v3-turbo',ffmpeg:'bin/ffmpeg.exe',ffprobe:'bin/ffprobe.exe',originalVideo:'D:\\private\\interview.mp4',nodeExecutable:'D:\\private\\node.exe',hardware:{system:'Windows x64',gpu:'NVIDIA RTX 2070',driverRequired:true,secret:'omit'},validation:{recognitionMedianSeconds:194.092,validationFile:'records/private.json'},sessionEntryFile:`${snapshot}/operator-session.cjs`,sessionImplementationRevision:revision,sessionPolicy:'stable-gpu-v1-greedy',profiles:{winner:{planFile:'profiles/winner.json',medianSeconds:194.092},native30:{planFile:'profiles/native30.json'},'native30-streaming':profile('streaming'),'native120-complete':profile('complete'),failed:{planFile:'profiles/missing.json',status:'failed'}} };
  await put(source, 'machine.json', machine);
  await put(source, 'operator.cjs', 'original wrapper\n');
  await put(source, 'licenses/LICENSE', 'project license\n');
  await put(source, 'licenses/REFERENCES.md', 'upstream component sources\n');
  await put(project, 'src/speech/file-operator.cjs', 'new portable wrapper\n');
  const worker = 'from pathlib import Path\nimport sys\nfrom faster_backend import FasterBackend\n';
  await put(source, 'module/src/speech/worker.py', worker);
  await put(source, 'module/src/speech-provider.cjs', 'SDK\n');
  await put(source, 'module/src/speech/video-transcode.cjs', 'NVENC\n');
  await put(source, 'module/package-manifest.json', {version:'test',files:[{file:'src/speech/worker.py',sha256:sha(worker)}]});
  await put(source, 'module/src/speech/__pycache__/worker.pyc', 'cache');
  await put(source, 'resources/speech/python/python.exe', 'MZ-python');
  await put(source, 'resources/speech/python/python311._pth', 'python311.zip\n.\nLib/site-packages\n../../../module/src/speech\nimport site\n');
  await put(source, 'resources/speech/python/Lib/site-packages/example/tests/fixture.py', '# library test source\n');
  await put(source, 'resources/speech/python/Lib/site-packages/example/__pycache__/foo.pyc', 'cache');
  await put(source, 'resources/speech/model/model.bin', 'model');
  await put(source, 'resources/speech/model/config.json', '{}');
  await put(source, `${variantRoot}/ctranslate2/ctranslate2.dll`, dll);
  await put(source, `${variantRoot}/ctranslate2/_ext.cp311-win_amd64.pyd`, 'MZ-pyd');
  await put(source, `${variantRoot}/ctranslate2/__init__.py`, '# native\n');
  await put(source, `${variantRoot}/gpu-libs/cudart64_13.dll`, 'MZ-cuda');
  await put(source, `${variantRoot}/licenses/LICENSE.txt`, 'license');
  await put(source, `${variantRoot}/READY.json`, ready);
  await put(source, `${variantRoot}/variant.json`, '{"variant":"sm75-native"}\n');
  await put(source, `${variantRoot}/import-check.json`, '{"private":"omit"}');
  await put(source, 'bin/ffmpeg.exe', 'MZ-ffmpeg');
  await put(source, 'bin/ffprobe.exe', 'MZ-ffprobe');
  await put(source, 'bin/node.exe', 'MZ-node');
  await put(source, 'records/user-output.txt', 'private transcript');
  return {source,project,dll,ready,revision,machine,options:{source,project,expectedNativeDllSha256:sha(dll)}};
}

test('requires an explicit absolute source and keeps import side-effect free', () => {
  assert.throws(() => parseArguments([]), /--source/);
  assert.throws(() => parseArguments(['--source','relative']), /absolute/);
  assert.throws(() => parseArguments(['--source',path.resolve('source'),'--overwrite']), /Unknown/);
});

test('vendors a closed portable payload with exact frozen files and complete asset locks', async t => {
  const f = await fixture(t);
  const result = await vendorWindowsGpuOperator(f.options);
  const code = result.codeDirectory, native = result.nativeDirectory, runtime = result.runtimeDirectory;
  const machine = JSON.parse(await fs.readFile(path.join(code,'machine.json'),'utf8'));
  assert.deepEqual(Object.keys(machine.profiles).sort(), ['native120-complete','native30','native30-streaming','winner']);
  assert.equal(machine.profiles.winner.planFile, 'plans/winner.json');
  assert.equal(machine.sessionEntryFile, `implementations/${f.revision}/operator-session.cjs`);
  assert.equal(machine.profiles['native120-complete'].entryFile, `implementations/${f.revision}/gpu-file.cjs`);
  assert.doesNotMatch(JSON.stringify(machine), /private|originalVideo|nodeExecutable|records/);
  assert.equal(await fs.readFile(path.join(code,'operator.cjs'),'utf8'), 'new portable wrapper\n');
  const worker = await fs.readFile(path.join(code,'module/src/speech/worker.py'),'utf8');
  assert.match(worker, /import sys\nsys.path.insert\(0, str\(Path\(__file__\).resolve\(\).parent\)\)/);
  assert.doesNotMatch(await fs.readFile(path.join(f.source,'module/src/speech/worker.py'),'utf8'), /sys.path/);
  assert.equal(await fs.readFile(path.join(code,`implementations/${f.revision}/worker.py`),'utf8'), await fs.readFile(path.join(f.source,`experiments/implementations/${f.revision}/worker.py`),'utf8'));
  assert.doesNotMatch(await fs.readFile(path.join(runtime,'resources/speech/python/python311._pth'),'utf8'), /module|project|windows-operator/);
  assert.deepEqual(await fs.readFile(path.join(native,'READY.json')), f.ready);
  await assert.rejects(fs.stat(path.join(native,'gpu-libs')), {code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(runtime,'bin/node.exe')), {code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(runtime,'records')), {code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(native,'import-check.json')), {code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(runtime,'licenses/REFERENCES.md'),'utf8'),'upstream component sources\n');
  const canonical = JSON.parse(await fs.readFile(path.join(code,'asset-lock.json'),'utf8'));
  for (const [root, directory] of [['native',native],['runtime',runtime]]) {
    const lock = JSON.parse(await fs.readFile(path.join(directory,'asset-lock.json'),'utf8'));
    assert.deepEqual(lock.files, canonical.files.filter(x=>x.root===root).map(({root,...entry})=>entry));
    for (const entry of lock.files) {
      const bytes = await fs.readFile(path.join(directory,entry.file));
      assert.equal(entry.bytes,bytes.length); assert.equal(entry.sha256,sha(bytes));
      assert.doesNotMatch(entry.file,/__pycache__|\.pyc$|\.log$/);
    }
  }
  const provenance = JSON.parse(await fs.readFile(path.join(code,'vendor-provenance.json'),'utf8'));
  assert.equal(provenance.nativeBaseline.sha256,sha(f.dll));
  assert.equal(provenance.adaptations.length,3);
  for (const item of provenance.adaptations) assert.notEqual(item.originalSha256,item.sha256);
  assert.doesNotMatch(JSON.stringify(provenance), /C:\\\\private|D:\\\\private/);
});

test('refuses existing destinations without changing them', async t => {
  const f = await fixture(t), destination = path.join(f.project,'src/speech/windows-operator');
  await put(destination,'operator.cjs','keep later edits');
  await assert.rejects(vendorWindowsGpuOperator(f.options), /already exists/);
  assert.equal(await fs.readFile(path.join(destination,'operator.cjs'),'utf8'),'keep later edits');
});

test('refuses escaping profile paths before creating output roots', async t => {
  const f = await fixture(t); f.machine.profiles.winner.planFile='../escape.json';
  await put(f.source,'machine.json',f.machine);
  await assert.rejects(vendorWindowsGpuOperator(f.options),/relative|escape|outside/i);
  await assert.rejects(fs.stat(path.join(f.project,'src/speech/windows-operator')),{code:'ENOENT'});
});

test('rejects a changed frozen implementation and baseline native DLL', async t => {
  const f = await fixture(t);
  await put(f.source,`experiments/implementations/${f.revision}/worker.py`,'changed');
  await assert.rejects(vendorWindowsGpuOperator(f.options),/snapshot|immutable/i);
  await put(f.source,`experiments/implementations/${f.revision}/worker.py`,'from pathlib import Path\nimport sys\nsys.path.insert(0, str(Path(__file__).resolve().parent))\n');
  await assert.rejects(vendorWindowsGpuOperator({...f.options,expectedNativeDllSha256:sha('wrong')}),/baseline/i);
});

test('refuses symlinked resource files rather than following them', async t => {
  const f = await fixture(t);
  await fs.symlink(path.join(f.source,'operator.cjs'),path.join(f.source,'resources/speech/model/linked.bin'));
  await assert.rejects(vendorWindowsGpuOperator(f.options),/symlink|junction/i);
  await assert.rejects(fs.stat(path.join(f.project,'src/speech/windows-operator')),{code:'ENOENT'});
});

test('rejects a plan that is not bound to the copied READY bytes', async t => {
  const f = await fixture(t);
  await put(f.source,'profiles/winner.json',{runtimeVariant:'sm75-native',runtimeRevision:sha('other runtime'),computeType:'float16'});
  await assert.rejects(vendorWindowsGpuOperator(f.options),/stable native FP16 runtime/);
  await assert.rejects(fs.stat(path.join(f.project,'assets/windows-gpu-native')),{code:'ENOENT'});
});

test('refuses oversized tracked PE assets before making any copies', async t => {
  const f = await fixture(t);
  const file = path.join(f.source,'resources/speech/gpu-v1/variants/sm75-native/ctranslate2/oversized.dll');
  const handle = await fs.open(file,'w');
  try { await handle.write('MZ'); await handle.truncate(100*1024*1024+1); }
  finally { await handle.close(); }
  await assert.rejects(vendorWindowsGpuOperator(f.options),/exceeds 100 MiB/);
  await assert.rejects(fs.stat(path.join(f.project,'src/speech/windows-operator')),{code:'ENOENT'});
});
