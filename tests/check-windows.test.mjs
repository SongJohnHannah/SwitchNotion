import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkWindows } from '../scripts/check-windows.mjs';
import desktop from '../src/platform/index.cjs';
import speech from '../src/speech/platform.cjs';

function fixture(arch = 'x64') {
  const root = path.resolve('fixture-state'), project = path.resolve('fixture-project'), files = new Map();
  const fsImpl = {
    readFileSync(file) { if (!files.has(file)) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return files.get(file); },
    existsSync: file => files.has(file),
    statSync(file) { if (!files.has(file)) throw Error('missing'); return { isFile: () => true }; }
  };
  const native = desktop.createDesktopPlatform({ id: 'win32', arch, fs: fsImpl });
  const source = native.installationLayout(path.resolve('fixture-Notion'));
  const platform = { ...native, discoverInstallation: () => source };
  files.set(source.archive, Buffer.from('synthetic archive'));
  const options = { root, platform, speechPlatform: speech.createSpeechPlatform({ id: 'win32', arch }), nodeVersion: '22.0.0',
    fsImpl, inspect: () => ({ version: '7.41.0', compatibility: 'structural' }) };
  const json = (file, value) => files.set(path.join(root, file), JSON.stringify(value));
  const prepared = () => {
    json('prepared.json', { platform: 'win32', pendingValidation: false });
    const layout = native.runtimeLayout(path.join(root, 'runtime'));
    files.set(layout.archive, 'fixture'); files.set(layout.executable, 'fixture');
    const node = path.join(project, 'node.exe'); files.set(node, 'fixture');
    for (const name of ['login-helper.cjs', 'open-settings.mjs']) files.set(path.join(project, 'scripts', name), 'fixture');
    json('launcher.local.json', { nodeExecutable: node, projectDirectory: project });
  };
  return { options, files, root, json, prepared };
}

test('Windows detection reports the installation and helper paths without changing files or exposing private paths', () => {
  const f = fixture(); f.prepared(); const before = [...f.files];
  const result = checkWindows(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.checks.find(c => c.id === 'login-helper').status, 'pass');
  assert.equal(result.checks.find(c => c.id === 'speech').status, 'info');
  assert.deepEqual([...f.files], before);
  assert.ok(!JSON.stringify(result).includes(f.root));
});

test('copied runtime and speech configuration from another OS fail Windows detection without exposing their values', () => {
  const f = fixture(); f.json('prepared.json', { platform: 'darwin' });
  f.json('speech.local.json', { enabled: true, runtime: { platform: 'darwin', pythonExecutable: '/private/python3',
    modelDirectory: '/private/models', apiKey: 'fixture-private-value' } });
  const result = checkWindows(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(c => c.id === 'runtime').status, 'fail');
  assert.equal(result.checks.find(c => c.id === 'speech').status, 'fail');
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('Windows detection distinguishes CUDA configuration files from verified inference and reports missing files', () => {
  const f = fixture(), runtime = { platform: 'win32', architecture: 'x64', device: 'cuda', computeType: 'float16',
    pythonExecutable: 'C:\\fixture\\asr\\python.exe', modelDirectory: 'C:\\fixture\\models\\medium' };
  f.json('speech.local.json', { enabled: true, runtime });
  assert.equal(checkWindows(f.options).checks.find(c => c.id === 'speech').status, 'fail');
  f.files.set(runtime.pythonExecutable, 'fixture'); f.files.set(path.join(runtime.modelDirectory, 'model.bin'), 'fixture');
  const result = checkWindows(f.options);
  assert.equal(result.checks.find(c => c.id === 'speech').status, 'pass');
  assert.match(result.checks.find(c => c.id === 'speech').message, /实际引擎仍需/);
});

test('old Node, unsupported Windows architectures and damaged state cannot produce a successful report', () => {
  const f = fixture(); f.options.nodeVersion = '20.19.0';
  assert.equal(checkWindows(f.options).checks.find(c => c.id === 'node').status, 'fail');
  assert.equal(checkWindows(fixture('arm64').options).checks.find(c => c.id === 'desktop-platform').status, 'fail');
  f.options.platform.discoverInstallation = () => null;
  f.files.set(path.join(f.root, 'prepared.json'), '{broken');
  const result = checkWindows(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(c => c.id === 'installation').status, 'fail');
  assert.equal(result.checks.find(c => c.id === 'runtime').status, 'fail');
});

test('the Windows detector rejects macOS before accessing the filesystem or application', () => {
  assert.throws(() => checkWindows({ platform: { id: 'darwin' }, fsImpl: {} }), /仅用于 Windows/);
});
