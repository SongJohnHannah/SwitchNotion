import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { transcribeGpuFile, normalizePlan } = require('../src/speech/gpu-pipelined-file.cjs');
const { openPcmPipeline } = require('../src/speech/pcm-pipeline.cjs');

function fixture(t, body, customize = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-pipeline-file-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const source = path.join(directory, 'original.webm'), fake = path.join(directory, 'decode.cjs');
  fs.writeFileSync(source, 'video-source'); fs.writeFileSync(fake, body);
  let audio, requests = 0, firstWhileDecoding, closed = false;
  const speech = { status: () => ({ device: 'cuda' }), retain() {}, probe: async () => {}, close: async () => { closed = true; },
    request: async (_kind, fields, signal, observer) => {
      requests++; firstWhileDecoding ??= audio.status().decoded === false;
      const result = { workerPid: 1234, text: 'complete GPU speech ' + requests, segments: [{ start: 0, end: 1, text: 'complete GPU speech ' + requests }] };
      observer(result); return result;
    }, ...customize };
  const options = { source, outputDirectory: path.join(directory, 'output'), root: directory, ffmpeg: process.execPath,
    runtime: { model: 'large-v3-turbo', pythonExecutable: process.execPath, modelDirectory: directory },
    plan: { chunkSeconds: 10 }, providerFactory: () => speech,
    audioFactory: async opts => (audio = await openPcmPipeline({ ...opts, spawnImpl: (_file, _args, config) => spawn(process.execPath, [fake], config) })) };
  return { directory, options, speech, requests: () => requests, firstWhileDecoding: () => firstWhileDecoding, closed: () => closed };
}
test('CUDA work starts before whole decode completion and preserves every tail sample', async t => {
  const f = fixture(t, "process.stdout.write(Buffer.alloc(10*16000*2,1));setTimeout(()=>process.stdout.write(Buffer.alloc(11*16000*2,2)),220);");
  const result = await transcribeGpuFile(f.options);
  assert.equal(f.firstWhileDecoding(), true); assert.equal(f.requests(), 3);
  assert.equal(result.totalSamples, 21 * 16000); assert.equal(result.chunks, 3); assert.equal(result.complete, true);
  const checkpoint = JSON.parse(fs.readFileSync(result.checkpointFile));
  assert.deepEqual(checkpoint.parts.map(p => [p.startSample / 16000, p.samples / 16000]), [[0,10],[10,10],[20,1]]);
  assert.ok(Date.parse(result.timing.firstChunkReady) < Date.parse(result.timing.audioComplete));
  assert.ok(result.timing.endToEndSeconds > 0); assert.equal(f.closed(), true);
  assert.ok(fs.existsSync(path.join(f.options.outputDirectory, 'metrics.json')));
});
test('decoder failure after CUDA accepted a prefix cannot produce a completed transcript', async t => {
  const f = fixture(t, "process.stdout.write(Buffer.alloc(10*16000*2,1));setTimeout(()=>{process.stderr.write('broken source');process.exitCode=6},150);");
  await assert.rejects(transcribeGpuFile(f.options), /broken source/);
  assert.equal(fs.existsSync(path.join(f.options.outputDirectory, 'result.json')), false);
  assert.equal(fs.existsSync(path.join(f.options.outputDirectory, '.transcription.lock')), false);
  assert.equal(f.closed(), true);
});
test('cancellation cleans both workers and never returns a partial successful result', async t => {
  let began; const ready = new Promise(resolve => { began = resolve; });
  const f = fixture(t, "process.stdout.write(Buffer.alloc(10*16000*2,1));setInterval(()=>process.stdout.write(Buffer.alloc(32)),40);", {
    request: (_kind, _fields, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }); began();
    }),
  });
  const controller = new AbortController(), task = transcribeGpuFile({ ...f.options, signal: controller.signal });
  await ready; controller.abort(Error('test cancelled')); await assert.rejects(task, /test cancelled/);
  assert.equal(fs.existsSync(path.join(f.options.outputDirectory, 'result.json')), false);
  assert.equal(f.closed(), true);
  assert.deepEqual(fs.readdirSync(path.join(f.directory, 'speech/gpu-leases')), []);
});
test('pipelined experimental entry refuses another model execution route or CPU provider', async t => {
  for (const plan of [{ batchSize: 2, chunkSeconds: 60 }, { beamSize: 5 }, { computeType: 'float32' }, { runtimeVariant: 'bundled' }]) assert.throws(() => normalizePlan(plan), /Native|流水线/);
  const f = fixture(t, "process.stdout.write(Buffer.alloc(10*16000*2));", { status: () => ({ device: 'cpu' }) });
  await assert.rejects(transcribeGpuFile(f.options), /CPU/); assert.equal(f.requests(), 0);
});
