import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const home = path.resolve(import.meta.dirname, '..');
const base = path.join(home, '.notion-switch/speech/gpu-v1');
const stage = path.join(base, 'gpuops-stage');
const original = path.join(base, 'variants/sm75-native');
const variant = path.join(stage, 'variant-staging');
const target = path.join(base, 'variants/sm75-native-gpuops');
if (fs.existsSync(target) && process.argv.includes('--archive-unvalidated')) {
  const ready = JSON.parse(fs.readFileSync(path.join(target, 'READY.json')));
  const old = JSON.parse(fs.readFileSync(path.join(target, 'variant.json')));
  if (ready.gpuValidationPending !== true || old.validation.gpuTested !== false) throw Error('Cannot archive a GPU validated variant');
  const archive = path.join(stage, 'unvalidated-build-' + new Date().toISOString().replace(/[:.]/g, '-'));
  for (const value of [target, archive]) {
    const relative = path.relative(base, path.resolve(value));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Archive target escaped private workspace');
  }
  fs.renameSync(target, archive);
}
if (fs.existsSync(target) || fs.existsSync(variant)) throw Error('GPUops target/staging already exists; preserve frozen files, use a new private variant');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pyd = path.join(stage, 'dist/_ct2_gpuops.cp311-win_amd64.pyd');
if (!fs.existsSync(pyd)) throw Error('Build GPUops first');
fs.mkdirSync(variant, { recursive: true });
fs.cpSync(path.join(original, 'ctranslate2'), path.join(variant, 'ctranslate2'), { recursive: true });
fs.cpSync(path.join(original, 'licenses'), path.join(variant, 'licenses'), { recursive: true });
fs.copyFileSync(pyd, path.join(variant, path.basename(pyd)));
const manifest = JSON.parse(fs.readFileSync(path.join(original, 'variant.json')));
manifest.variant = 'sm75-native-gpuops';
manifest.parentVariant = 'sm75-native';
manifest.builtAt = new Date().toISOString();
manifest.pythonExtension = { module: '_ct2_gpuops', pyd: path.basename(pyd), sha256: digest(pyd),
  source: 'src/speech/gpuops/concat.cpp', sourceSha256: digest(path.join(home, 'src/speech/gpuops/concat.cpp')),
  compiler: 'MSVC 14.44.35207 cp311 single CL BelowNormal',
  operations: ['existing CT2 Concat axis0; synchronize_stream'], maxBridgeBytes: 64 * 1024 ** 2 };
manifest.validation = { dependencyImportChecked: false, cpuCrossPydStorageViewAbiChecked: false, gpuTested: false, fullVideoVerified: false };
manifest.logs = [...(manifest.logs || []), path.join(stage, 'build.log'), path.join(stage, 'import.log')];
fs.writeFileSync(path.join(variant, 'variant.json'), JSON.stringify(manifest, null, 2));
const log = fs.createWriteStream(path.join(stage, 'import.log'));
const allowed = /^(?:PATH|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|HOMEDRIVE|HOMEPATH|COMSPEC|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|NUMBER_OF_PROCESSORS)$/i;
const child = spawn(path.join(base, '../python/Scripts/python.exe'), ['-B', path.join(home, 'scripts/check-native-gpuops.py'), variant], {
  cwd: stage, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
});
child.stdout.on('data', value => log.write(value)); child.stderr.on('data', value => log.write(value));
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
await new Promise(resolve => log.end(`\nImport check exit ${code}\n`, resolve));
if (code) throw Error('CPU import/ABI failed; staging preserved, see import.log');
const nativeDll = 'ctranslate2/ctranslate2.dll';
if (digest(path.join(original, nativeDll)) !== digest(path.join(variant, nativeDll))) throw Error('Original Native DLL changed during stage copy');
manifest.validation.dependencyImportChecked = true; manifest.validation.cpuCrossPydStorageViewAbiChecked = true;
fs.writeFileSync(path.join(variant, 'variant.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(variant, 'READY.json'), JSON.stringify({ version: 1, id: 'sm75-native-gpuops',
  publishedAt: new Date().toISOString(), dependencyImportChecked: true, cpuCrossPydStorageViewAbiChecked: true,
  gpuValidationPending: true, importAudit: path.join(target, 'import-check.json') }, null, 2));
fs.renameSync(variant, target); // Atomic whole-directory publication, never expose a partial package.
console.log(JSON.stringify({ target, gpuValidationPending: true, pydSha256: digest(path.join(target, path.basename(pyd))) }));
