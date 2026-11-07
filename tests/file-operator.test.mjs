import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { createFileOperator } = require('../src/speech/file-operator.cjs');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'file-operator-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'profiles'));
  fs.writeFileSync(path.join(home, 'source.wav'), 'source');
  fs.writeFileSync(path.join(home, 'profiles/native.json'), JSON.stringify({ id: 'native', computeType: 'float16' }));
  const machine = { resourcesRoot: 'resources', pythonExecutable: 'python/python.exe', modelDirectory: 'model', model: 'large-v3-turbo',
    ffmpeg: 'bin/ffmpeg.exe', originalVideo: path.join(home, 'source.wav'), profiles: { winner: { planFile: 'profiles/native.json' } } };
  const save = () => fs.writeFileSync(path.join(home, 'machine.json'), JSON.stringify(machine)); save();
  let last;
  const api = createFileOperator({ home, loader: entry => ({ transcribeGpuFile: async options => { last = { entry, ...options }; return { complete: true, device: 'cuda' }; } }) });
  return { home, machine, save, api, last: () => last };
}
test('default profile remains Native GPU and explicit auto clears the English override', async t => {
  const f = fixture(t); await f.api.transcribeFile(); assert.equal(f.last().language, 'en');
  assert.equal(f.last().runtime.device, 'cuda');
  await f.api.transcribeFile({ language: 'auto' }); assert.equal(f.last().plan.languageOverride, null);
});
test('experimental and rejected profiles cannot silently enter production, and entry paths stay inside the bundle', async t => {
  const f = fixture(t); f.machine.profiles.test = { planFile: 'profiles/native.json', experimental: true, entryFile: 'experiments/frozen/gpu-file.cjs' }; f.save();
  await assert.rejects(f.api.transcribeFile({ profile: 'test' }), /实验/);
  await f.api.transcribeFile({ profile: 'test', allowExperimental: true }); assert.match(f.last().entry, /experiments/);
  f.machine.profiles.test.status = 'content-review-needed'; f.save();
  await assert.rejects(f.api.transcribeFile({ profile: 'test', allowExperimental: true }), /待复核/);
  f.machine.profiles.test = { planFile: '../outside.json' }; f.save();
  await assert.rejects(f.api.transcribeFile({ profile: 'test' }), /越界/);
});
test('newly validated profiles are observed per call without rewriting an active implementation', async t => {
  const f = fixture(t); await f.api.transcribeFile(); assert.equal(f.last().plan.id, 'native');
  fs.writeFileSync(path.join(f.home, 'profiles/new.json'), JSON.stringify({ id: 'new-validated', computeType: 'float16' }));
  f.machine.profiles.winner = { planFile: 'profiles/new.json', entryFile: 'experiments/frozen/gpu-file.cjs' }; f.save();
  await f.api.transcribeFile(); assert.equal(f.last().plan.id, 'new-validated');
});

test('application-owned code uses only the explicitly bound asset root for Python, model, FFmpeg, leases and default outputs', async t => {
  const f = fixture(t), assetHome = path.join(f.home, 'local-assets');
  for (const file of ['python/python.exe', 'model/model.bin', 'bin/ffmpeg.exe']) {
    fs.mkdirSync(path.dirname(path.join(assetHome, file)), { recursive: true });
    fs.writeFileSync(path.join(assetHome, file), 'fixture runtime');
  }
  let called;
  const operator = createFileOperator({ home: f.home, assetHome, loader: entry => ({ transcribeGpuFile: async options => {
    called = { entry, ...options }; return { complete: true, device: 'cuda' };
  } }) });
  assert.equal(operator.describe().resourcesReady, true);
  await operator.transcribeFile();
  assert.equal(called.entry, path.join(f.home, 'module/src/speech-provider.cjs'));
  assert.equal(called.runtime.pythonExecutable, path.join(assetHome, 'python/python.exe'));
  assert.equal(called.runtime.modelDirectory, path.join(assetHome, 'model'));
  assert.equal(called.ffmpeg, path.join(assetHome, 'bin/ffmpeg.exe'));
  assert.equal(called.root, path.join(assetHome, 'resources'));
  assert.ok(called.outputDirectory.startsWith(path.join(assetHome, 'outputs') + path.sep));
  f.machine.pythonExecutable = '../outside/python.exe'; f.save();
  assert.throws(() => operator.describe(), /越界/);
});
