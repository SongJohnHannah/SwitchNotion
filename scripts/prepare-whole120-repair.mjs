import fs from 'node:fs';
import path from 'node:path';
import { loadGpuImplementation } from './gpu-runtime-snapshot.mjs';
const bundle = path.resolve(process.argv[2] || 'D:/迅雷下载/notionSwitch/GPU转写算子');
const modes = (process.argv[3] || 'coverage-clips30').split(',');
const names = { 'coverage-clips30': 'clips30', 'coverage-no-ts': 'no-ts', stable30: 'stable30' };
if (modes.some(mode => !names[mode])) throw Error('Unknown quality mode.');
const project = path.resolve(import.meta.dirname, '..');
if (!fs.existsSync(path.join(project, 'src/speech/complete_window_recognition.py'))) throw Error('Complete-window implementation is not ready.');
const file = path.join(bundle, 'machine.json'), machine = JSON.parse(fs.readFileSync(file));
const frozen = loadGpuImplementation({ root: path.join(bundle, machine.resourcesRoot),
  cacheDirectory: path.join(bundle, 'experiments/implementations') });
const native = JSON.parse(fs.readFileSync(path.join(bundle, machine.profiles.native30.planFile)));
const backup = path.join(bundle, 'versions', 'before-whole120-repair-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(backup, { recursive: true }); fs.copyFileSync(file, path.join(backup, 'machine.json'));
const added = [];
for (const mode of modes) {
  const name = `bench-native120-${names[mode]}-v1`;
  if (machine.profiles[name]) throw Error('Existing candidate history cannot be replaced: ' + name);
  const plan = frozen.normalizePlan({ ...native, id: `gpu-native120-${names[mode]}-v1`, chunkSeconds: 120,
    nativeWholeWindow: true, windowMode: mode });
  const planFile = `experiments/profiles/${name}.json`;
  fs.writeFileSync(path.join(bundle, planFile), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  machine.profiles[name] = { planFile, experimental: true, status: 'candidate',
    implementationRevision: frozen.revision,
    entryFile: path.relative(bundle, path.join(frozen.snapshotDirectory, 'gpu-file.cjs')).replaceAll('\\', '/'),
    note: 'Quality repair first. Fixed Native GPU FP16/sync/B1/3000; no reference text inserted. Requires fresh whole-video validation.' };
  added.push(name);
}
fs.writeFileSync(file + '.tmp', JSON.stringify(machine, null, 2) + '\n'); fs.renameSync(file + '.tmp', file);
fs.writeFileSync(path.join(backup, 'SETUP.json'), JSON.stringify({ added, implementationRevision: frozen.revision, stableProfilesUnchanged: true }, null, 2));
console.log(JSON.stringify({ bundle, added, implementationRevision: frozen.revision, backup }));
