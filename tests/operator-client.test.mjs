import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { GpuOperatorClient, defaultOperatorDirectory } = require('../src/speech/operator-client.cjs');

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'operator-client-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, 'input.wav'); fs.writeFileSync(source, 'audio');
  return { root, source, bundle: path.join(root, 'bundle') };
}

test('adapter lazily loads an explicit test package and forwards cancellation and explicit auto', async t => {
  const { root, source, bundle } = fixture(t), loaded = [], calls = [], controller = new AbortController();
  const client = new GpuOperatorClient({ root, directory: bundle, loader: entry => {
    loaded.push(entry); return { transcribeFile: async options => { calls.push(options); return { text: 'text', complete: true, device: 'cuda', sourceIdentity: 'package-identity' }; } };
  } });
  assert.equal(loaded.length, 0);
  const onProgress = () => {}, first = await client.transcribeFile({ source, signal: controller.signal, onProgress });
  assert.equal(loaded[0], path.join(bundle, 'operator.cjs')); assert.equal(calls[0].language, 'auto');
  assert.equal(calls[0].allowExperimental, false);
  assert.equal(calls[0].signal, controller.signal); assert.equal(calls[0].onProgress, onProgress);
  assert.equal(first.sourceIdentity, 'package-identity'); assert.ok(first.outputDirectory.startsWith(path.join(root, 'collection', 'transcriptions') + path.sep));
  await client.transcribeFile({ source, language: 'en' }); assert.equal(loaded.length, 1); assert.equal(calls[1].language, 'en');
  assert.notEqual(calls[0].outputDirectory, calls[1].outputDirectory);
  await client.transcribeFile({ source }); assert.equal(calls[2].outputDirectory, calls[0].outputDirectory);
  assert.equal(new GpuOperatorClient({ env: {} }).directory, defaultOperatorDirectory);
});

test('the application binds project-owned operator code to project-local assets and ignores the former external environment override', async t => {
  const { root, source, bundle } = fixture(t), bindings = [], calls = [];
  const client = new GpuOperatorClient({ root, env: { NOTION_SWITCH_GPU_OPERATOR_DIRECTORY: bundle }, loader: entry => {
    assert.equal(entry, path.join(defaultOperatorDirectory, 'operator.cjs'));
    return { createFileOperator: binding => {
      bindings.push(binding);
      return { transcribeFile: async options => { calls.push(options); return { text: 'Local operator output', complete: true, device: 'cuda' }; } };
    } };
  } });
  assert.equal(client.directory, defaultOperatorDirectory);
  assert.equal(defaultOperatorDirectory, path.resolve(import.meta.dirname, '../src/speech/windows-operator'));
  await client.transcribeFile({ source });
  assert.deepEqual(bindings, [{ home: defaultOperatorDirectory, assetHome: path.join(root, 'windows-gpu-operator') }]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].outputDirectory.startsWith(path.join(root, 'collection/transcriptions') + path.sep));
});

test('experimental admission is explicit and cannot leak into the following ordinary call', async t => {
  const { root, source, bundle } = fixture(t), calls = [];
  const client = new GpuOperatorClient({ root, directory: bundle, loader: () => ({ transcribeFile: async options => {
    calls.push(options); return { text: 'text', complete: true, device: 'cuda' };
  } }) });
  const ordinaryDirectory = client.outputDirectoryFor(source);
  await client.transcribeFile({ source, profile: 'candidate', allowExperimental: true });
  await client.transcribeFile({ source });
  assert.equal(calls[0].profile, 'candidate'); assert.equal(calls[0].allowExperimental, true);
  assert.equal(calls[1].profile, 'winner'); assert.equal(calls[1].allowExperimental, false);
  assert.equal(calls[1].outputDirectory, ordinaryDirectory);
  await assert.rejects(client.transcribeFile({ source, allowExperimental: 'true' }), /boolean|布尔/);
  assert.equal(calls.length, 2);
});

test('profile entry source and immutable entry path are part of the checkpoint directory fingerprint', t => {
  const { root, source, bundle } = fixture(t); fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, 'candidate.cjs'), 'exports.revision = 1');
  const selected = { entryFile: 'candidate.cjs' };
  const client = new GpuOperatorClient({ root, directory: bundle, loader: () => ({ transcribeFile() {}, describe: () => ({ profiles: { candidate: selected } }) }) });
  const first = client.outputDirectoryFor(source, { profile: 'candidate' });
  fs.writeFileSync(path.join(bundle, 'candidate.cjs'), 'exports.revision = 2');
  const second = client.outputDirectoryFor(source, { profile: 'candidate' }); assert.notEqual(first, second);
  fs.writeFileSync(path.join(bundle, 'candidate-v2.cjs'), 'exports.revision = 2'); selected.entryFile = 'candidate-v2.cjs';
  assert.notEqual(second, client.outputDirectoryFor(source, { profile: 'candidate' }));
  selected.entryFile = '../escape.cjs'; assert.throws(() => client.profileIdentity({ profile: 'candidate' }), /路径无效/);
});

test('profile changes route to new output while identical source and profile safely reuse the operator checkpoint', t => {
  const { root, source, bundle } = fixture(t); fs.mkdirSync(bundle); fs.writeFileSync(path.join(bundle, 'winner.json'), '{"chunkSeconds":30}');
  const client = new GpuOperatorClient({ root, directory: bundle, loader: () => ({ transcribeFile() {}, describe: () => ({ model: 'large-v3-turbo', profiles: { winner: { planFile: 'winner.json' } } }) }) });
  const first = client.outputDirectoryFor(source); assert.equal(first, client.outputDirectoryFor(source));
  fs.writeFileSync(path.join(bundle, 'winner.json'), '{"chunkSeconds":20}'); assert.notEqual(first, client.outputDirectoryFor(source));
});

test('GPU errors and cancellation are propagated, and invalid results never trigger fallback or return stale success', async t => {
  const { root, source, bundle } = fixture(t), failure = Object.assign(Error('CUDA out of memory'), { code: 'CUDA_ERROR' });
  let calls = 0;
  const client = new GpuOperatorClient({ root, directory: bundle, loader: () => ({ transcribeFile: async () => { calls++; throw failure; } }) });
  await assert.rejects(client.transcribeFile({ source }), error => error === failure); assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.transcribeFile({ source, signal: controller.signal }), error => error.name === 'AbortError'); assert.equal(calls, 1);
  for (const result of [{ text: 'old', complete: false, device: 'cuda' }, { text: 'cpu', complete: true, device: 'cpu' }, { text: '!'.repeat(224), complete: true, device: 'cuda' }]) {
    const invalid = new GpuOperatorClient({ root, directory: bundle, loader: () => ({ transcribeFile: async () => result }) });
    await assert.rejects(invalid.transcribeFile({ source }), /AI 总结已暂停/);
  }
});

test('an abort received as an operator finishes cannot turn into successful collection content', async t => {
  const { root, source, bundle } = fixture(t), controller = new AbortController();
  const client = new GpuOperatorClient({ root, directory: bundle, loader: () => ({ transcribeFile: async () => {
    controller.abort(); return { text: 'text', complete: true, device: 'cuda' };
  } }) });
  await assert.rejects(client.transcribeFile({ source, signal: controller.signal }), error => error.name === 'AbortError');
});
