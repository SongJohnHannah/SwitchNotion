import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { startOperatorBridge } from '../src/speech/operator-bridge.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function fixture(operator, checkpoint = { parts: [{ index: 0, startSample: 0, samples: 16000, device: 'cuda', text: 'Complete speech', segments: [{ start: 0, end: 1, text: 'Complete speech' }] }] }) {
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', data => { text += data; });
  const task = startOperatorBridge({ input, output, operator, readCheckpoint: () => checkpoint });
  return { input, task, events: () => text.trim().split('\n').filter(Boolean).map(JSON.parse) };
}
test('one JSON bridge uses the standalone operator and retains all timestamped segments', async () => {
  let options;
  const f = fixture({ describe: () => ({ model: 'large-v3-turbo' }), transcribeFile: async value => {
    options = value; value.onProgress({ stage: 'transcribing', index: 0, totalChunks: 1 });
    return { complete: true, device: 'cuda', totalSamples: 16000, duration: 1, text: 'Complete speech', checkpointFile: '/checkpoint.json' };
  } });
  f.input.write(JSON.stringify({ type: 'transcribe', source: '/source.wav', outputDirectory: '/output', language: 'en' }) + '\n');
  assert.equal(await f.task, 0);
  assert.equal(options.language, 'en');
  assert.equal(options.source, '/source.wav');
  assert.equal(f.events()[0].event, 'progress');
  const result = f.events().find(event => event.event === 'result').result;
  assert.equal(result.model, 'large-v3-turbo'); assert.equal(result.segments[0].end, 1);
  assert.equal(result.text, 'Complete speech'); assert.equal(result.device, 'cuda');
});
test('describe never starts a model, and CPU or incomplete results cannot be labelled successful', async () => {
  const describe = fixture({ describe: () => ({ model: 'large-v3-turbo' }), transcribeFile: () => { throw Error('model started'); } });
  describe.input.write('{"type":"describe"}\n'); assert.equal(await describe.task, 0);
  assert.equal(describe.events()[0].event, 'description');
  for (const result of [{ complete: true, device: 'cpu' }, { complete: false, device: 'cuda' }, { complete: true, device: 'cuda', totalSamples: 32000 }]) {
    const f = fixture({ describe: () => ({}), transcribeFile: async () => result });
    f.input.write('{"type":"transcribe","source":"/source.wav","outputDirectory":"/out"}\n');
    assert.equal(await f.task, 1); assert.ok(f.events().some(event => event.event === 'error'));
    assert.equal(f.events().some(event => event.event === 'result'), false);
  }
});
test('cancellation reaches the operator AbortSignal and does not return a partial transcript', async () => {
  let began;
  const ready = new Promise(resolve => { began = resolve; });
  const f = fixture({ describe: () => ({}), transcribeFile: options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); began();
  }) });
  f.input.write('{"type":"transcribe","source":"/source.wav","outputDirectory":"/out"}\n');
  await ready; f.input.write('{"type":"cancel"}\n');
  assert.equal(await f.task, 2); assert.equal(f.events().at(-1).code, 'CANCELLED');
});

test('caller pipe closure aborts an active worker rather than leaving GPU work orphaned', async () => {
  let began;
  const ready = new Promise(resolve => { began = resolve; });
  const f = fixture({ describe: () => ({}), transcribeFile: options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); began();
  }) });
  f.input.write('{"type":"transcribe","source":"/source.wav","outputDirectory":"/out"}\n');
  await ready; f.input.end();
  assert.equal(await f.task, 2);
  assert.match(f.events().at(-1).message, /断开/);
});

test('CLI returns its final JSON and exits while its parent keeps stdin open', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-bridge-pipe-'));
  let child;
  try {
    await fs.copyFile(new URL('../src/speech/operator-bridge.mjs', import.meta.url), path.join(directory, 'bridge.mjs'));
    await fs.writeFile(path.join(directory, 'operator.cjs'), 'exports.describe=()=>({model:"large-v3-turbo",gpuProbePerformed:false});');
    child = spawn(process.execPath, [path.join(directory, 'bridge.mjs')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', data => { output += data; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { stderr += data; });
    const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    child.stdin.on('error', () => {});
    child.stdin.write('{"type":"describe"}\n'); // Deliberately no EOF.
    let timer;
    try {
      assert.equal(await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Bridge did not exit with open parent stdin')), 5000); })]), 0, stderr);
    } finally { clearTimeout(timer); }
    assert.deepEqual(JSON.parse(output), { event: 'description', result: { model: 'large-v3-turbo', gpuProbePerformed: false } });
  } finally {
    if (child && child.exitCode === null) child.kill();
    const absolute = await fs.realpath(directory), parent = await fs.realpath(os.tmpdir());
    if (path.dirname(absolute) !== parent || !path.basename(absolute).startsWith('operator-bridge-pipe-')) throw Error('Refusing cleanup outside the owned temporary directory');
    await fs.rm(absolute, { recursive: true, force: true });
  }
});
