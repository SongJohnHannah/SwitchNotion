import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadGpuImplementation } from './gpu-runtime-snapshot.mjs';

const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const id = 'sm75-native-fp16-accum-v1';
const profile = 'bench-native30-fp16-accum-v1';
const json = value => JSON.stringify(value, null, 2) + '\n';
function filesBelow(directory, relative = '') {
  const items = [];
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    const file = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw Error('Refusing linked runtime input: ' + file);
    if (entry.isDirectory()) items.push(...filesBelow(directory, file));
    else if (entry.isFile()) items.push({ file: file.replaceAll('\\', '/'), sha256: digest(path.join(directory, file)) });
  }
  return items.sort((a, b) => a.file.localeCompare(b.file));
}

/** Publish one new experimental runtime. Original binaries and winner never change. */
export function prepareNativeFp16Experiment({ bundle, stage } = {}) {
  bundle = fs.realpathSync(bundle || 'D:/迅雷下载/notionSwitch/GPU转写算子');
  stage = fs.realpathSync(stage || path.resolve(import.meta.dirname, '../.notion-switch/speech/gpu-v1/fp16-accum-v1-stage'));
  const build = read(path.join(stage, 'build-manifest.json'));
  const comparison = read(path.join(stage, 'exports-comparison.json'));
  const dll = path.join(stage, 'Release/ctranslate2.dll');
  if (build.exitCode !== 0 || build.baselineUnchanged !== true || build.variant !== id ||
      JSON.stringify(build.patches?.map(item => item.line)) !== '[84,241,471,592]' || comparison.sameExports !== true ||
      build.link?.privateObjectCount !== 1 || build.link?.reusedObjectCount !== 179 || build.validation?.gpuTested !== false) {
    throw Error('Private runtime build/ABI evidence is incomplete');
  }
  const candidateSha = digest(dll);
  if (comparison.candidateDll?.sha256 !== candidateSha || !build.outputs?.some(item => path.resolve(item.path) === path.resolve(dll) && item.sha256 === candidateSha)) {
    throw Error('Private DLL does not match the build and export audits');
  }
  const machineFile = path.join(bundle, 'machine.json'), machine = read(machineFile);
  const variantRoot = path.resolve(bundle, machine.resourcesRoot, 'speech/gpu-v1/variants');
  if (!variantRoot.startsWith(bundle + path.sep)) throw Error('Runtime root must remain in bundle');
  const baseline = path.join(variantRoot, 'sm75-native'), target = path.join(variantRoot, id);
  const baselineSha = digest(path.join(baseline, 'ctranslate2/ctranslate2.dll'));
  if (comparison.originalDll?.sha256 !== baselineSha || candidateSha === baselineSha) throw Error('Private DLL baseline mismatch or no binary change');
  const planFile = `experiments/profiles/${profile}.json`;
  if (machine.profiles[profile] || fs.existsSync(target) || fs.existsSync(path.join(bundle, planFile))) throw Error('Never overwrite a runtime or prior candidate');
  const backup = path.join(bundle, 'versions', 'before-native-fp16-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backup, { recursive: true }); fs.copyFileSync(machineFile, path.join(backup, 'machine.json'), fs.constants.COPYFILE_EXCL);
  fs.mkdirSync(target);
  for (const directory of ['ctranslate2', 'licenses']) {
    if (fs.existsSync(path.join(baseline, directory))) {
      filesBelow(path.join(baseline, directory)); // Reject links before recursive copy.
      fs.cpSync(path.join(baseline, directory), path.join(target, directory), { recursive: true, filter: file => !file.split(path.sep).includes('__pycache__') });
    }
  }
  fs.copyFileSync(dll, path.join(target, 'ctranslate2/ctranslate2.dll'));
  const binding = 'ctranslate2/_ext.cp311-win_amd64.pyd';
  if (digest(path.join(target, binding)) !== digest(path.join(baseline, binding))) throw Error('Python binding must remain identical to Native baseline');
  const metadata = { ...read(path.join(baseline, 'variant.json')), variant: id,
    dllDirectories: ['../sm75-native/gpu-libs'],
    kernelChanges: ['Four Whisper top-level FP32 accumulation guards now respect the existing CT2_CUDA_TRUE_FP16_GEMM flag. Attention FP32 guard unchanged.'],
    files: [{ file: 'ctranslate2.dll', sha256: candidateSha }, { file: path.basename(binding), sha256: digest(path.join(target, binding)) }],
    validation: { nativeBuild: true, pythonBindingReused: true, sameExports: true, gpuTested: false, fullVideoVerified: false },
    privateBuildEvidence: 'build-manifest.json', publishedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(target, 'variant.json'), json(metadata));
  for (const file of ['build-manifest.json', 'exports-comparison.json']) fs.copyFileSync(path.join(stage, file), path.join(target, file));
  const ready = { version: 1, id, experimental: true, builtAt: build.completedAt, publishedAt: new Date().toISOString(),
    gpuValidationPending: true, baselineDllSha256: baselineSha, candidateDllSha256: candidateSha,
    dependencyDirectory: '../sm75-native/gpu-libs', files: filesBelow(target) };
  fs.writeFileSync(path.join(target, 'READY.json'), json(ready), { flag: 'wx' });
  const frozen = loadGpuImplementation({ root: path.join(bundle, machine.resourcesRoot), cacheDirectory: path.join(bundle, 'experiments/implementations') });
  const native = read(path.join(bundle, machine.profiles.native30.planFile));
  const plan = frozen.normalizePlan({ ...native, id: 'gpu-native30-fp16-accum-v1', runtimeVariant: id, runtimeRevision: digest(path.join(target, 'READY.json')), fp16Gemm: true });
  fs.writeFileSync(path.join(bundle, planFile), json(plan), { flag: 'wx' });
  machine.profiles[profile] = { planFile, experimental: true, status: 'candidate', implementationRevision: frozen.revision,
    entryFile: path.relative(bundle, path.join(frozen.snapshotDirectory, 'gpu-file.cjs')).replaceAll('\\', '/'),
    note: 'Private actual FP16 accumulation experiment. Native30 FP16 storage/B1/sync/default CUB/original segmentation unchanged. Requires same-interview GPU canary and fresh whole-run quality/stability/speed checks; never production by build success alone.' };
  fs.writeFileSync(machineFile + '.tmp', json(machine)); fs.renameSync(machineFile + '.tmp', machineFile);
  return { profile, variant: id, candidateSha, implementationRevision: frozen.revision, backup, gpuTested: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(prepareNativeFp16Experiment({ bundle: process.argv[2], stage: process.argv[3] })));
}
