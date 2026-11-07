import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Add plans against the already frozen implementation; never edit its files.
const bundle = path.resolve(process.argv[2] || 'D:/迅雷下载/notionSwitch/GPU转写算子');
const windows = (process.argv[3] || '240').split(',').map(Number);
if (windows.some(seconds => ![30, 60, 120, 240].includes(seconds))) throw Error('Unsupported native window.');
const machineFile = path.join(bundle, 'machine.json');
const machine = JSON.parse(fs.readFileSync(machineFile));
const base = machine.profiles['bench-native-whole120'];
if (!base?.entryFile || !base.implementationRevision) throw Error('Missing frozen Native window reference.');
const basePlan = JSON.parse(fs.readFileSync(path.join(bundle, base.planFile)));
const backup = path.join(bundle, 'versions', 'before-native-window-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(backup, { recursive: true });
fs.copyFileSync(machineFile, path.join(backup, 'machine.json'));
const added = [];
for (const seconds of windows) {
  const name = 'bench-native-whole' + seconds;
  if (machine.profiles[name]) throw Error('Profile already exists; do not erase attempt history: ' + name);
  const plan = { ...basePlan, id: `gpu-native-whole${seconds}-v3`, chunkSeconds: seconds };
  const planFile = `experiments/profiles/${name}.json`;
  fs.writeFileSync(path.join(bundle, planFile), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  machine.profiles[name] = { ...base, planFile, experimental: true, status: 'candidate' };
  added.push({ name, planFile, planSha256: createHash('sha256').update(fs.readFileSync(path.join(bundle, planFile))).digest('hex') });
}
fs.writeFileSync(machineFile + '.tmp', JSON.stringify(machine, null, 2) + '\n');
fs.renameSync(machineFile + '.tmp', machineFile);
fs.writeFileSync(path.join(backup, 'ADDED.json'), JSON.stringify({ added, implementationRevision: base.implementationRevision }, null, 2));
console.log(JSON.stringify({ bundle, backup, added }));
