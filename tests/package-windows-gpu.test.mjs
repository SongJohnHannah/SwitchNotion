import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { planWindowsGpuAssets, copyWindowsGpuAssets, assertNewWindowsStage } from '../scripts/package-windows-gpu.mjs';
import { stageWindows } from '../scripts/package-windows.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
function fixture(t, assets = { native: { 'ctranslate2/ctranslate2.dll': 'reviewed native binary' }, runtime: { 'resources/speech/python/Lib/site-packages/vendor/tests/check.py': 'reviewed vendor test code', 'resources/speech/model/model.bin': 'reviewed model fixture' } }) {
  const parent = fs.realpathSync(path.resolve('.notion-switch'));
  const root = fs.mkdtempSync(path.join(parent, 'test-windows-gpu-package-')), project = path.join(root, 'project');
  fs.mkdirSync(project);
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const canonical = { version: 1, files: [] }, roots = {};
  for (const [kind, contents] of Object.entries(assets)) {
    const relative = kind === 'native' ? 'assets/windows-gpu-native' : '.notion-switch/windows-gpu-operator';
    const source = path.join(project, relative), lock = { version: 1, files: [] }; roots[kind] = source;
    for (const [file, content] of Object.entries(contents)) {
      const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
      fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true }); fs.writeFileSync(path.join(source, file), data);
      const entry = { file, bytes: data.length, sha256: sha(data) };
      lock.files.push(entry); canonical.files.push({ root: kind, ...entry });
    }
    writeJson(path.join(source, 'asset-lock.json'), lock);
  }
  writeJson(path.join(project, 'src/speech/windows-operator/asset-lock.json'), canonical);
  return { root, project, roots, canonical };
}

test('Windows staging copies only canonical locked GPU files and reports optional runtime accurately', t => {
  const f = fixture(t);
  // Supply the existing portable-package inputs using small local fixtures;
  // this never copies the developer's actual multi-GB GPU installation.
  for (const folder of ['src', 'scripts', 'docs']) fs.cpSync(path.resolve(folder), path.join(f.project, folder), { recursive: true });
  writeJson(path.join(f.project, 'src/speech/windows-operator/asset-lock.json'), f.canonical);
  for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'WINDOWS-使用说明.md', 'MAC-使用说明.md', 'package.json', 'NotionSwitch 启动.vbs', 'NotionSwitch 配置.vbs', 'NotionSwitch 更新.vbs']) fs.copyFileSync(path.resolve(name), path.join(f.project, name));
  fs.writeFileSync(path.join(f.roots.runtime, 'private-transcript.txt'), 'unlisted private words');
  fs.writeFileSync(path.join(f.roots.runtime, 'gpu-owner.lock'), 'unlisted lease');
  fs.mkdirSync(path.join(f.project, '.notion-switch/profile')); fs.writeFileSync(path.join(f.project, '.notion-switch/profile/Cookies'), 'unlisted login');
  const binary = path.join(f.root, 'node.exe'), license = path.join(f.root, 'LICENSE'); fs.writeFileSync(binary, 'synthetic runtime'); fs.writeFileSync(license, 'synthetic license');
  const destination = path.join(f.project, 'dist/with-gpu/NotionSwitch');
  const result = stageWindows({ sourceProject: f.project, destination, nodeExecutable: binary, nodeLicense: license,
    launcherBuilder: directory => fs.writeFileSync(path.join(directory, 'NotionSwitch.exe'), 'launcher') });
  assert.equal(result.includesWindowsGpuNative, true); assert.equal(result.includesWindowsGpuRuntime, true); assert.equal(result.includesUserData, false);
  assert(result.files.some(item => item.file === '.notion-switch/windows-gpu-operator/resources/speech/model/model.bin'));
  assert(result.files.some(item => item.file.includes('/vendor/tests/check.py')));
  assert.equal(result.files.some(item => /private-transcript|gpu-owner|Cookies/.test(item.file)), false);
  assert.equal(fs.existsSync(path.join(destination, '.notion-switch/profile')), false);
  assert.equal(fs.existsSync(path.join(destination, '.notion-switch/windows-gpu-operator/gpu-owner.lock')), false);
  assert.deepEqual(fs.readFileSync(path.join(destination, 'assets/windows-gpu-native/ctranslate2/ctranslate2.dll')),
    fs.readFileSync(path.join(f.roots.native, 'ctranslate2/ctranslate2.dll')));
});

test('native-only distributions remain usable without an installed runtime and no resources are installed from elsewhere', t => {
  const f = fixture(t, { native: { 'ctranslate2/ctranslate2.dll': 'native only' } });
  const plan = planWindowsGpuAssets({ sourceProject: f.project });
  assert.equal(plan.includesWindowsGpuNative, true); assert.equal(plan.includesWindowsGpuRuntime, false);
  const output = path.join(f.root, 'output'); fs.mkdirSync(output);
  const reviewed = copyWindowsGpuAssets({ plan, destination: output });
  assert.deepEqual([...reviewed].sort(), ['assets/windows-gpu-native/asset-lock.json', 'assets/windows-gpu-native/ctranslate2/ctranslate2.dll']);
  assert.equal(fs.existsSync(path.join(output, '.notion-switch')), false);
});

test('hash tampering, local-lock additions and unsafe canonical paths never become reviewed assets', t => {
  const f = fixture(t), file = path.join(f.roots.native, 'ctranslate2/ctranslate2.dll'), original = fs.readFileSync(file);
  fs.writeFileSync(file, 'changed binary');
  assert.throws(() => planWindowsGpuAssets({ sourceProject: f.project }), /bytes\/SHA256/);
  fs.writeFileSync(file, original);
  const lockFile = path.join(f.roots.native, 'asset-lock.json'), local = JSON.parse(fs.readFileSync(lockFile));
  local.files.push({ file: 'extra.bin', bytes: 0, sha256: sha(Buffer.alloc(0)) }); writeJson(lockFile, local);
  assert.throws(() => planWindowsGpuAssets({ sourceProject: f.project }), /canonical lock/);
  local.files.pop(); writeJson(lockFile, local);
  const canonicalFile = path.join(f.project, 'src/speech/windows-operator/asset-lock.json');
  for (const unsafe of ['../outside.bin', 'a/../../outside.bin', 'C:/outside.bin', 'model.bin:stream', 'logs/private.txt', '__pycache__/code.pyc']) {
    const entry = { file: unsafe, bytes: 0, sha256: sha(Buffer.alloc(0)) };
    writeJson(lockFile, { version: 1, files: [entry] }); writeJson(canonicalFile, { version: 1, files: [{ root: 'native', ...entry }] });
    assert.throws(() => planWindowsGpuAssets({ sourceProject: f.project }), /unsafe|private|generated/);
  }
});

test('junctions in locked sources and packaging destinations are rejected', t => {
  const f = fixture(t);
  const actualDirectory = path.join(f.roots.native, 'ctranslate2'), relocated = path.join(f.root, 'outside-native');
  fs.renameSync(actualDirectory, relocated);
  try { fs.symlinkSync(relocated, actualDirectory, 'junction'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Current filesystem permissions do not allow creating a junction fixture'); return; } throw error; }
  assert.throws(() => planWindowsGpuAssets({ sourceProject: f.project }), /link|reparse/);
  fs.mkdirSync(path.join(f.project, 'dist')); fs.symlinkSync(path.join(f.root, 'outside-native'), path.join(f.project, 'dist/link'), 'junction');
  assert.throws(() => assertNewWindowsStage(f.project, path.join(f.project, 'dist/link/package')), /link|reparse/);
});

test('large locked files are scanned with bounded chunks and catch credentials crossing a chunk boundary', t => {
  const key = 'synthetic-local-private-value-927', bytes = Buffer.alloc(8 * 1024 * 1024 + 100, 0x21);
  bytes.write(key, 8 * 1024 * 1024 - 5);
  const f = fixture(t, { native: { 'large.dll': bytes } });
  assert.throws(() => planWindowsGpuAssets({ sourceProject: f.project, keys: [key] }), /凭据|私人/);
});

test('FFmpeg OpenSSH public algorithm identifiers are not API secrets, including at a chunk boundary', t => {
  const publicNames = ['ssh-ed25519-cert-v01@openssh.com', 'ecdsa-sha2-nistp256-cert-v01@openssh.com'].map(name => 'sk-' + name);
  const data = Buffer.alloc(8 * 1024 * 1024 + 150, 0);
  data.write(publicNames.join(','), 100); data.write(publicNames[1], 8 * 1024 * 1024 - 25);
  const f = fixture(t, { native: { 'ffmpeg-fixture.exe': data } });
  assert.equal(planWindowsGpuAssets({ sourceProject: f.project }).includesWindowsGpuNative, true);
  // A configured local key never receives the public-name exception.
  assert.throws(() => planWindowsGpuAssets({ sourceProject: f.project, keys: [publicNames[0]] }), /凭据|私人/);
});

test('public-name lookalikes and API secrets at EOF still stop locked-asset packaging', t => {
  for (const value of ['sk-' + 'ssh-ed25519-cert-v01@openssh.com-extra', 'sk-' + 'ecdsa-sha2-nistp256-cert-v01', 'sk-' + 'x'.repeat(30), 'ntn_' + 'y'.repeat(30), 'secret_' + 'z'.repeat(30)]) {
    const f = fixture(t, { native: { 'invalid.exe': value } });
    assert.throws(() => planWindowsGpuAssets({ sourceProject: f.project }), /凭据|私人/);
  }
});
