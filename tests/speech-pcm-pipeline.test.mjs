import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { openPcmPipeline } = require('../src/speech/pcm-pipeline.cjs');

function setup(t, script) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-pipeline-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const source = path.join(directory, 'source.webm'); fs.writeFileSync(source, 'original-video');
  const executable = path.join(directory, 'fake-decoder.cjs'); fs.writeFileSync(executable, script);
  let child;
  const options = { source, cacheFile: path.join(directory, 'audio.s16le'), ffmpeg: process.execPath,
    sourceIdentity: 'source-one', chunkSamples: 4, spawnImpl: (_file, _args, opts) => (child = spawn(process.execPath, [executable], opts)) };
  return { directory, options, child: () => child };
}

test('consumer starts before decode completes; irregular byte writes preserve samples and exact tail', async t => {
  const f = setup(t, "process.stdout.write(Buffer.from([0,1,2]));setTimeout(()=>process.stdout.write(Buffer.from([3,4,5,6,7,8])),15);setTimeout(()=>process.stdout.write(Buffer.from([9,10,11,12,13])),180);");
  const pipeline = await openPcmPipeline(f.options), chunks = [], iterator = pipeline[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false); assert.equal(pipeline.status().decoded, false);
  chunks.push(first.value);
  for (;;) { const next = await iterator.next(); if (next.done) break; chunks.push(next.value); }
  const prepared = await pipeline.completion;
  assert.deepEqual(chunks.map(x => [x.index, x.startSample, x.samples]), [[0, 0, 4], [1, 4, 3]]);
  assert.deepEqual(Buffer.concat(chunks.map(x => x.pcm16)), Buffer.from(Array.from({ length: 14 }, (_, n) => n)));
  assert.deepEqual(fs.readFileSync(f.options.cacheFile), Buffer.concat(chunks.map(x => x.pcm16)));
  assert.equal(prepared.totalSamples, 7); assert.equal(prepared.complete, true);
  assert.equal(JSON.parse(fs.readFileSync(f.options.cacheFile + '.source.json')).sourceIdentity, 'source-one');
});

test('slow consumers use disk spool without accumulating audio chunks in RAM', async t => {
  const f = setup(t, "for(let n=0;n<128;n++)process.stdout.write(Buffer.alloc(8192,n));");
  f.options.chunkSamples = 4096;
  const pipeline = await openPcmPipeline(f.options), iterator = pipeline[Symbol.asyncIterator]();
  const first = await iterator.next();
  const prepared = await pipeline.completion;
  assert.equal(prepared.bytes, 128 * 8192); assert.equal(pipeline.status().bufferedChunks, 0);
  const chunks = [first.value];
  for (;;) { const next = await iterator.next(); if (next.done) break; chunks.push(next.value); }
  assert.equal(chunks.length, 128);
  assert.ok(chunks.every((chunk, n) => chunk.startSample === n * 4096 && chunk.pcm16[0] === n));
});

test('nonzero decoder exit cannot publish a complete audio cache even after usable chunks', async t => {
  const f = setup(t, "process.stdout.write(Buffer.alloc(10,1));setTimeout(()=>{process.stderr.write('bad packet');process.exitCode=3;},50);");
  const pipeline = await openPcmPipeline(f.options);
  await assert.rejects(async () => { for await (const chunk of pipeline) {} }, /bad packet/);
  await assert.rejects(pipeline.completion, /bad packet/);
  assert.equal(fs.existsSync(f.options.cacheFile), false);
  assert.equal(fs.existsSync(f.options.cacheFile + '.source.json'), false);
  assert.ok(fs.readdirSync(f.directory).some(file => file.endsWith('.partial')));
});

test('odd final byte count and cancellation both preserve partials without a complete marker', async t => {
  const odd = setup(t, "process.stdout.write(Buffer.alloc(9));");
  const decoder = await openPcmPipeline(odd.options);
  await assert.rejects(async () => { for await (const chunk of decoder) {} }, /样本/);
  assert.equal(fs.existsSync(odd.options.cacheFile + '.source.json'), false);
  const aborted = setup(t, "process.stdout.write(Buffer.alloc(8));setInterval(()=>process.stdout.write(Buffer.alloc(8)),50);");
  const controller = new AbortController();
  const pipeline = await openPcmPipeline({ ...aborted.options, signal: controller.signal });
  const iterator = pipeline[Symbol.asyncIterator](); await iterator.next(); controller.abort(Error('test cancellation'));
  await assert.rejects(iterator.next(), /test cancellation/);
  await pipeline.close();
  assert.equal(fs.existsSync(aborted.options.cacheFile + '.source.json'), false);
  assert.ok(aborted.child().exitCode !== null || aborted.child().signalCode !== null);
});

test('valid complete cache is reused only for the same source and matching PCM bytes', async t => {
  const f = setup(t, "process.stdout.write(Buffer.from([0,1,2,3,4,5]));");
  const first = await openPcmPipeline(f.options); for await (const _ of first) {}
  let spawns = 0;
  const cached = await openPcmPipeline({ ...f.options, spawnImpl: () => { spawns++; throw Error('must reuse'); } });
  const chunks = []; for await (const chunk of cached) chunks.push(chunk);
  assert.equal(spawns, 0); assert.equal((await cached.completion).cacheReused, true);
  fs.writeFileSync(f.options.cacheFile, Buffer.from([9,9,9,9,9,9]));
  const repaired = await openPcmPipeline(f.options); for await (const _ of repaired) {}
  assert.deepEqual(fs.readFileSync(f.options.cacheFile), Buffer.from([0,1,2,3,4,5]));
});

test('failed replacement preserves the previous complete cache and source marker', async t => {
  const f = setup(t, "process.stdout.write(Buffer.from([1,2,3,4,5,6]));");
  const first = await openPcmPipeline(f.options); for await (const _ of first) {}
  const previous = fs.readFileSync(f.options.cacheFile + '.source.json', 'utf8');
  const replacement = await openPcmPipeline({ ...f.options, sourceIdentity: 'different-source', spawnImpl: (_file, _args, opts) => spawn(process.execPath, ['-e', "process.stdout.write(Buffer.from([9,9,9,9]));process.exitCode=8"], opts) });
  await assert.rejects(async () => { for await (const _ of replacement) {} }, /解码失败/);
  assert.deepEqual(fs.readFileSync(f.options.cacheFile), Buffer.from([1,2,3,4,5,6]));
  assert.equal(fs.readFileSync(f.options.cacheFile + '.source.json', 'utf8'), previous);
});

test('cache replacement waits for the active consumer, and an early return releases its unique lease', async t => {
  const f = setup(t, "process.stdout.write(Buffer.alloc(32,7));");
  const first = await openPcmPipeline(f.options), iterator = first[Symbol.asyncIterator]();
  await iterator.next(); await first.completion;
  let acquired = false;
  const waiting = openPcmPipeline({ ...f.options, spawnImpl: () => { throw Error('valid cache should be reused'); } }).then(value => { acquired = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(acquired, false);
  await iterator.return();
  const second = await waiting; for await (const _ of second) {}
  assert.equal((await second.completion).cacheReused, true);
});
