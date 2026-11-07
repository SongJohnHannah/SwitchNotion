import fs from 'node:fs';
import path from 'node:path';
import { loadGpuImplementation } from './gpu-runtime-snapshot.mjs';
const project = path.resolve(import.meta.dirname, '..');
const bundle = path.resolve(process.argv[2] || 'D:/迅雷下载/notionSwitch/GPU转写算子');
const machineFile = path.join(bundle, 'machine.json'), machine = JSON.parse(fs.readFileSync(machineFile));
const version = process.argv[3] || 'v1';
if (!/^v\d+$/.test(version)) throw Error('Invalid revision name.');
const name = 'bench-native-short-' + version;
if (machine.profiles[name]) throw Error('Do not overwrite prior attempts.');
if (!fs.existsSync(path.join(project, 'src/speech/short_encoder_recognition.py'))) throw Error('Missing implementation.');
const frozen = loadGpuImplementation({ root: path.join(bundle, 'resources'), sourceDirectory: path.join(project, 'src/speech'),
  cacheDirectory: path.join(bundle, 'experiments/implementations') });
const native = JSON.parse(fs.readFileSync(path.join(bundle, machine.profiles.native30.planFile)));
const plan = frozen.normalizePlan({ ...native, id: 'gpu-native-short-encoder-' + version, shortEncoder: true });
const backup = path.join(bundle, 'versions', 'before-short-encoder-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(backup, { recursive: true }); fs.copyFileSync(machineFile, path.join(backup, 'machine.json'));
const planFile = `experiments/profiles/${name}.json`;
fs.writeFileSync(path.join(bundle, planFile), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
machine.profiles[name] = { planFile, experimental: true, status: 'candidate', implementationRevision: frozen.revision,
  entryFile: path.relative(bundle, path.join(frozen.snapshotDirectory, 'gpu-file.cjs')).replaceAll('\\', '/'),
  note: 'Native B1 dynamic encoder time length; only proven np.pad zero tail may be trimmed, changes attention math and needs full quality/stability validation.' };
fs.writeFileSync(machineFile + '.tmp', JSON.stringify(machine, null, 2) + '\n'); fs.renameSync(machineFile + '.tmp', machineFile);
console.log(JSON.stringify({ bundle, name, implementationRevision: frozen.revision, backup }));
