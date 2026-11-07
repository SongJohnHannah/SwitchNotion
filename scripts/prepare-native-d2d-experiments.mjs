import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadGpuImplementation } from './gpu-runtime-snapshot.mjs';
const project = path.resolve(import.meta.dirname, '..');
const bundle = path.resolve(process.argv[2] || 'D:/迅雷下载/notionSwitch/GPU转写算子');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file));
const machineFile = path.join(bundle, 'machine.json'), machine = read(machineFile);
const variant = 'sm75-native-gpuops', source = path.join(project, '.notion-switch/speech/gpu-v1/variants', variant);
const target = path.join(bundle, 'resources/speech/gpu-v1/variants', variant);
const resumeSetup = process.argv.includes('--resume-setup');
if (fs.existsSync(target) && (!resumeSetup || Object.values(machine.profiles).some(profile => profile.runtimeVariant === variant || profile.planFile && read(path.join(bundle, profile.planFile)).runtimeVariant === variant))) throw Error('Refusing to replace a runtime variant with existing attempts.');
const backup = path.join(bundle, 'versions', 'before-d2d-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(backup, { recursive: true }); fs.copyFileSync(machineFile, path.join(backup, 'machine.json'));
if (!fs.existsSync(target)) fs.cpSync(source, target, { recursive: true, filter: file => !file.includes('__pycache__') });
const parent = path.join(bundle, 'resources/speech/gpu-v1/variants/sm75-native');
for (const file of ['ctranslate2/ctranslate2.dll', 'ctranslate2/_ext.cp311-win_amd64.pyd']) {
  if (sha(path.join(parent, file)) !== sha(path.join(target, file))) throw Error('Native core changed: ' + file);
}
if (!fs.existsSync(path.join(target, 'READY.original.json'))) fs.copyFileSync(path.join(target, 'READY.json'), path.join(target, 'READY.original.json'));
if (!fs.existsSync(path.join(target, 'variant.original.json'))) fs.copyFileSync(path.join(target, 'variant.json'), path.join(target, 'variant.original.json'));
fs.mkdirSync(path.join(target, 'gpu-libs'), { recursive: true });
for (const file of fs.readdirSync(path.join(parent, 'gpu-libs'))) {
  const from = path.join(parent, 'gpu-libs', file), to = path.join(target, 'gpu-libs', file);
  if (!fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(from).size) fs.copyFileSync(from, to);
}
const manifest = read(path.join(target, 'variant.json'));
if (sha(path.join(target, manifest.pythonExtension.pyd)) !== manifest.pythonExtension.sha256) throw Error('D2D pyd hash mismatch');
manifest.dllDirectories = ['gpu-libs'];
fs.writeFileSync(path.join(target, 'variant.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(target, 'READY.json'), JSON.stringify({ ...read(path.join(target, 'READY.original.json')),
  relocation: { originalReadySha256: sha(path.join(target, 'READY.original.json')), variantManifestSha256: sha(path.join(target, 'variant.json')),
    relativeCudaLibraries: true, pythonExtensionSha256: manifest.pythonExtension.sha256 } }, null, 2));
const frozen = loadGpuImplementation({ root: path.join(bundle, 'resources'), sourceDirectory: path.join(project, 'src/speech'),
  cacheDirectory: path.join(bundle, 'experiments/implementations') });
const native = read(path.join(bundle, machine.profiles.native30.planFile));
const added = [];
for (const batchSize of [2, 4]) {
  const name = `bench-native-d2d${batchSize}x30`;
  if (machine.profiles[name]) throw Error('Do not overwrite existing attempt history.');
  const plan = frozen.normalizePlan({ ...native, id: `gpu-native-d2d${batchSize}x30-v1`, runtimeVariant: variant,
    runtimeRevision: sha(path.join(target, 'READY.json')), chunkSeconds: batchSize * 30,
    batchSize, batchClipSeconds: 30, timestampedBatch: true, gpuEncoderBridge: true });
  const planFile = `experiments/profiles/${name}.json`;
  fs.writeFileSync(path.join(bundle, planFile), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  machine.profiles[name] = { planFile, experimental: true, status: 'candidate', implementationRevision: frozen.revision,
    entryFile: path.relative(bundle, path.join(frozen.snapshotDirectory, 'gpu-file.cjs')).replaceAll('\\', '/'),
    note: 'Experimental Native B1 GPU encoders + CT2-owned D2D concat + batched decoder. Full quality/stability unverified.' };
  added.push(name);
}
fs.writeFileSync(machineFile + '.tmp', JSON.stringify(machine, null, 2) + '\n'); fs.renameSync(machineFile + '.tmp', machineFile);
fs.writeFileSync(path.join(backup, 'SETUP.json'), JSON.stringify({ createdAt: new Date().toISOString(), added,
  implementationRevision: frozen.revision, runtimeVariant: variant, originalNativeBinariesUnchanged: true,
  extension: manifest.pythonExtension, gpuTested: false }, null, 2));
console.log(JSON.stringify({ bundle, added, implementationRevision: frozen.revision, backup }));
