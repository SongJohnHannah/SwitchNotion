import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadGpuImplementation } from './gpu-runtime-snapshot.mjs';
const project = path.resolve(import.meta.dirname, '..');
const bundle = path.resolve(process.argv[2] || 'D:/迅雷下载/notionSwitch/GPU转写算子');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const machineFile = path.join(bundle, 'machine.json'), machine = read(machineFile);
const version = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(bundle, 'versions', 'before-unified-integration-' + version);
fs.mkdirSync(backup, { recursive: true });
for (const file of ['operator.cjs', 'bridge.mjs', 'machine.json', 'PACKAGE-MANIFEST.json']) {
  if (fs.existsSync(path.join(bundle, file))) fs.copyFileSync(path.join(bundle, file), path.join(backup, file));
}
fs.writeFileSync(path.join(backup, 'ROLLBACK.txt'), '保留的V1入口与配置。恢复时将这些文件复制回算子根目录；现有module及Native GPU资源未改动。不要直接从本备份目录启动。\n');
fs.copyFileSync(path.join(project, 'src/speech/file-operator.cjs'), path.join(bundle, 'operator.cjs'));
fs.copyFileSync(path.join(project, 'src/speech/operator-bridge.mjs'), path.join(bundle, 'bridge.mjs'));
const pinnedFrom = path.join(project, '.notion-switch/speech/gpu-v1/variants/pinned-cudnn');
const pinnedTo = path.join(bundle, 'resources/speech/gpu-v1/variants/pinned-cudnn');
if (!fs.existsSync(pinnedTo)) fs.cpSync(pinnedFrom, pinnedTo, { recursive: true, filter: file => !file.includes('__pycache__') });
if (sha(path.join(pinnedFrom, 'READY.json')) !== sha(path.join(pinnedTo, 'READY.json'))) throw Error('固定GPU实验库与原记录不一致。');
const frozen = loadGpuImplementation({ root: path.join(bundle, 'resources'), sourceDirectory: path.join(project, 'src/speech'),
  cacheDirectory: path.join(bundle, 'experiments/implementations') });
const native = read(path.join(bundle, machine.profiles.native30.planFile));
const plans = [
  ['bench-native-async', { ...native, id: 'gpu-native30-async-v2', launchBlocking: false }, 'gpu-file.cjs'],
  ['bench-pinned-ts2', { ...native, id: 'gpu-pinned-ts2x30-v2', runtimeVariant: 'pinned-cudnn',
    runtimeRevision: sha(path.join(pinnedTo, 'READY.json')), batchSize: 2, chunkSeconds: 60, batchClipSeconds: 30,
    timestampedBatch: true }, 'gpu-file.cjs'],
  ['bench-pinned-ts4', { ...native, id: 'gpu-pinned-ts4x15-v2', runtimeVariant: 'pinned-cudnn',
    runtimeRevision: sha(path.join(pinnedTo, 'READY.json')), batchSize: 4, chunkSeconds: 60, batchClipSeconds: 15,
    timestampedBatch: true }, 'gpu-file.cjs'],
  ['bench-native-pipeline', { ...native, id: 'gpu-native-pcm-pipeline-v1' }, 'gpu-pipelined-file.cjs'],
];
fs.mkdirSync(path.join(bundle, 'experiments/profiles'), { recursive: true });
for (const [name, draft, entry] of plans) {
  const plan = frozen.normalizePlan(draft), planFile = 'experiments/profiles/' + name + '.json';
  fs.writeFileSync(path.join(bundle, planFile), JSON.stringify(plan, null, 2) + '\n');
  machine.profiles[name] = { planFile, experimental: true, status: 'candidate',
    entryFile: path.relative(bundle, path.join(frozen.snapshotDirectory, entry)).replaceAll('\\', '/'),
    implementationRevision: frozen.revision, note: '未验收，仅显式实验调用；默认winner仍保留已验证Native30。' };
}
machine.operatorProtocol = 1;
machine.integrationUpdatedAt = new Date().toISOString();
fs.writeFileSync(machineFile + '.tmp', JSON.stringify(machine, null, 2) + '\n');
fs.renameSync(machineFile + '.tmp', machineFile);
fs.writeFileSync(path.join(bundle, 'experiments/SETUP.json'), JSON.stringify({ createdAt: machine.integrationUpdatedAt,
  backup: path.relative(bundle, backup), defaultWinnerUnchanged: true, productionModuleUnchanged: true,
  implementation: frozen.manifest, candidates: plans.map(([name]) => name) }, null, 2));
console.log(JSON.stringify({ bundle, backup, revision: frozen.revision, candidates: plans.map(([name]) => name) }));
