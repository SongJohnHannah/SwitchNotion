import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGpuImplementation } from './gpu-runtime-snapshot.mjs';

export function parseNativeCacheArgs(args) {
  const options = {}; let variantSet = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--variant' && args[index + 1] && !variantSet) { options.variant = args[++index]; variantSet = true; }
    else if (value === '--bundle' && args[index + 1] && !options.bundle) options.bundle = args[++index];
    else if (['large', 'compact'].includes(value) && !variantSet) { options.variant = value; variantSet = true; }
    else if (!value.startsWith('--') && !options.bundle) options.bundle = value;
    else throw Error('Usage: [BUNDLE] [--variant large|compact] (or BUNDLE compact)');
  }
  return options;
}

export function prepareNativeCacheExperiment({ bundle, variant = 'large' } = {}) {
  if (!['large', 'compact'].includes(variant)) throw Error('Cache variant must be large or compact');
  bundle = path.resolve(bundle || 'D:/迅雷下载/notionSwitch/GPU转写算子');
  const machineFile = path.join(bundle, 'machine.json'), machine = JSON.parse(fs.readFileSync(machineFile));
  const name = variant === 'compact' ? 'bench-native30-cachecompact-v1' : 'bench-native30-cache1g-v1';
  const planFile = `experiments/profiles/${name}.json`;
  if (machine.profiles[name] || fs.existsSync(path.join(bundle, planFile))) throw Error('Do not overwrite prior candidate attempts or plans.');
  const frozen = loadGpuImplementation({ root: path.join(bundle, machine.resourcesRoot),
    cacheDirectory: path.join(bundle, 'experiments/implementations') });
  const native = JSON.parse(fs.readFileSync(path.join(bundle, machine.profiles.native30.planFile)));
  const id = variant === 'compact' ? 'gpu-native30-cachecompact-v1' : 'gpu-native30-cache1g-v1';
  const plan = frozen.normalizePlan({ ...native, id, allocatorCache: variant });
  const config = frozen.allocatorConfigFor(plan);
  const backup = path.join(bundle, 'versions', 'before-native-cache-' + variant + '-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.mkdirSync(backup);
  fs.copyFileSync(machineFile, path.join(backup, 'machine.json'), fs.constants.COPYFILE_EXCL);
  fs.mkdirSync(path.dirname(path.join(bundle, planFile)), { recursive: true });
  fs.writeFileSync(path.join(bundle, planFile), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  machine.profiles[name] = { planFile, experimental: true, status: 'candidate',
    implementationRevision: frozen.revision,
    entryFile: path.relative(bundle, path.join(frozen.snapshotDirectory, 'gpu-file.cjs')).replaceAll('\\', '/'),
    note: `Single change from fastest Native30: CUB config ${config}. FP16/sync/B1/3000 and original recognition unchanged. Cache cap is per allocator/device, not total VRAM. Speed and complete text must both pass.` };
  fs.writeFileSync(machineFile + '.tmp', JSON.stringify(machine, null, 2) + '\n'); fs.renameSync(machineFile + '.tmp', machineFile);
  return { name, variant, implementationRevision: frozen.revision, backup, config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(prepareNativeCacheExperiment(parseNativeCacheArgs(process.argv.slice(2)))));
}
