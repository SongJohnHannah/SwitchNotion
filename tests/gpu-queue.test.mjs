import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assessFullResult, externalJobActivity, planFingerprint, revisedPlan, runGpuQueue, runMetrics, updateMethodVerification } from '../scripts/gpu-queue-core.mjs';
import { bootstrapRunIds, migrateGpuQueue, enrichHistoricalPlans } from '../scripts/migrate-gpu-queue.mjs';
import { submitCommand } from '../scripts/gpu-queue-control.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const plan = (id, extra = {}) => ({ id, computeType: 'float32', allocator: 'cub_caching', fp16Gemm: false,
  chunkSeconds: 10, resetEveryChunks: 0, runtimeVariant: 'bundled', launchBlocking: true, beamSize: 1, ...extra });
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(condition) { const end = Date.now() + 2000; while (!condition()) { if (Date.now() > end) throw Error('Timed out waiting for queue evidence'); await delay(5); } }
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-queue-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const source = path.join(directory, 'source.wav'); fs.writeFileSync(source, 'original-source');
  const inputFile = path.join(directory, 'queue-input.json'); fs.writeFileSync(inputFile, JSON.stringify({ source, expectedDuration: 21, plans: [] }));
  return { directory, source, inputFile, root: directory, ffmpeg: path.join(directory, 'ffmpeg.exe') };
}
function completeOutput(f, outputDirectory) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const stat = fs.statSync(f.source), sourceIdentity = hash(JSON.stringify([fs.realpathSync(f.source), stat.size, stat.mtimeMs]));
  const parts = [[0, 10], [10, 10], [20, 1]].map(([start, seconds], index) => ({ index, startSample: start * 16000, samples: seconds * 16000, device: 'cuda', text: 'spoken segment ' + index }));
  const text = parts.map(part => part.text).join('\n');
  const checkpointFile = path.join(outputDirectory, 'checkpoint.json'), eventsFile = path.join(outputDirectory, 'raw-results.jsonl'), transcriptFile = path.join(outputDirectory, 'transcript.txt');
  fs.writeFileSync(path.join(outputDirectory, 'audio.s16le'), Buffer.alloc(21 * 16000 * 2));
  fs.writeFileSync(path.join(outputDirectory, 'audio-source.json'), JSON.stringify({ sourceIdentity }));
  fs.writeFileSync(checkpointFile, JSON.stringify({ parts }));
  fs.writeFileSync(eventsFile, [{ event: 'start', device: 'cuda', resumedChunks: 0 }, ...parts.map(part => ({ event: 'result', device: 'cuda', index: part.index, result: { text: part.text } }))].map(row => JSON.stringify(row)).join('\n') + '\n');
  fs.writeFileSync(transcriptFile, text + '\n');
  return { complete: true, device: 'cuda', sourceIdentity, policy: 'stable-gpu-v1', duration: 21, totalSamples: 21 * 16000, chunks: 3, recoveries: 0, nativeExits: 0, text, transcriptSha256: hash(text), checkpointFile, eventsFile, transcriptFile };
}

test('execution fingerprint ignores a renamed ID and includes every execution option', () => {
  const base = plan('base', { languageOverride: null });
  assert.equal(planFingerprint(base), planFingerprint({ ...base, id: 'renamed' }));
  for (const extra of [{ computeType: 'float16' }, { allocator: 'cuda_malloc_async' }, { fp16Gemm: true }, { chunkSeconds: 20 }, { resetEveryChunks: 6 }, { runtimeVariant: 'pinned-cudnn' }, { launchBlocking: false }, { beamSize: 5 }, { runtimeRevision: 'a'.repeat(64) }, { languageOverride: 'en' }]) assert.notEqual(planFingerprint(base), planFingerprint({ ...base, ...extra }));
  assert.equal(revisedPlan(plan('failed', { beamSize: 5 })).beamSize, 1);
  assert.equal(revisedPlan(base).runtimeVariant, 'pinned-cudnn');
  const batch = plan('batch', { computeType: 'float16', chunkSeconds: 120, batchSize: 4, batchClipSeconds: 30 });
  assert.notEqual(planFingerprint(batch), planFingerprint({ ...batch, encoderMicrobatchSize: 1 }));
  assert.notEqual(planFingerprint({ ...batch, encoderMicrobatchSize: 1 }), planFingerprint({ ...batch, encoderMicrobatchSize: 2 }));
});

test('legacy plan enrichment records original choices independently of the current winning default', () => {
  const original = { id: 'legacy-fp32', computeType: 'float32', allocator: 'cub_caching', fp16Gemm: false, chunkSeconds: 10, resetEveryChunks: 0 };
  const explicit = plan('known-greedy', { runtimeVariant: 'pinned-cudnn', beamSize: 1, launchBlocking: true, runtimeRevision: 'a'.repeat(64), languageOverride: 'en' });
  const state = { runs: [{ plan: structuredClone(original), passed: false, error: 'actual native failure' }, { plan: structuredClone(explicit) }], queue: [structuredClone(original)], pendingRevisions: [] };
  enrichHistoricalPlans(state);
  assert.deepEqual(state.runs[0].originalPlan, original); assert.equal(state.runs[0].plan.runtimeVariant, 'bundled'); assert.equal(state.runs[0].plan.beamSize, 5);
  assert.equal(state.runs[0].plan.launchBlocking, false); assert.equal(state.runs[0].plan.runtimeRevision, ''); assert.equal(state.runs[0].plan.languageOverride, null);
  assert.equal(state.runs[0].error, 'actual native failure'); assert.deepEqual(state.runs[1].plan, explicit); assert.equal(state.runs[1].originalPlan, undefined);
  assert.equal(state.queue[0].beamSize, 5); assert.deepEqual(state.originalQueuedPlans[0].originalPlan, original);
  assert.equal(enrichHistoricalPlans(state).length, 0);
});

test('complete, repeat verification, and measured GPU superiority are separate claims', () => {
  const run = index => ({ complete: true, passed: true, outputDirectory: '/independent/' + index, assessment: { passed: true, independent: true } });
  const method = { plan: plan('method'), sourceIdentity: 'a'.repeat(64), verifiedRuns: [run(1)] };
  updateMethodVerification(method);
  assert.equal(method.complete, true); assert.equal(method.repeatVerified, false);
  assert.equal(method.performanceVerified, false); assert.equal(method.performance.status, 'not-measured');
  method.verifiedRuns.push(run(2)); updateMethodVerification(method);
  assert.equal(method.repeatVerified, true); assert.equal(method.performanceVerified, false);
  method.performance = { fairComparisonVerified: true, sourceIdentity: method.sourceIdentity, planFingerprint: planFingerprint(method.plan), cpuComplete: true, gpuComplete: true, cpuWallSeconds: 100, gpuWallSeconds: 50 };
  updateMethodVerification(method); assert.equal(method.performanceVerified, true);
  method.performance.sourceIdentity = 'b'.repeat(64); updateMethodVerification(method); assert.equal(method.performanceVerified, false);
});

function migrationFixture(t) {
  const f = fixture(t);
  const runs = bootstrapRunIds.map((id, index) => {
    const outputDirectory = path.join(f.directory, 'runs', id + '-1'); fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, 'raw-results.jsonl'), JSON.stringify({ event: 'failed', error: 'dependency setup' }) + '\n');
    return { plan: plan(id, { runtimeVariant: 'sm75-native', beamSize: index ? 1 : 5 }), outputDirectory, complete: false, passed: false, error: 'generic old error',
      failureDetails: [{ kind: 'configure', errorType: index ? 'RuntimeError' : 'AttributeError', detail: index ? 'Invalid private CTranslate2 module directory' : "module 'ctranslate2' has no attribute 'get_supported_compute_types'" }] };
  });
  const realOutput = path.join(f.directory, 'runs', 'actual-gpu-failure'); fs.mkdirSync(realOutput, { recursive: true });
  fs.writeFileSync(path.join(realOutput, 'raw-results.jsonl'), JSON.stringify({ event: 'result', device: 'cuda', result: { text: 'real data' } }) + '\n');
  const actualFailure = { ...runs[0], outputDirectory: realOutput, error: 'cudaErrorIllegalAddress', failureDetails: [{ kind: 'transcribe', detail: 'cudaErrorIllegalAddress' }] };
  const state = { version: 2, queue: [runs[0].plan], runs: [...runs, actualFailure], current: null };
  fs.writeFileSync(path.join(f.directory, 'queue-state.json'), JSON.stringify(state));
  return { ...f, runs, actualFailure, state };
}

test('stopped-queue migration preserves all original records and defers only zero-result dependency failures', t => {
  const f = migrationFixture(t), stateFile = path.join(f.directory, 'queue-state.json'), original = fs.readFileSync(stateFile, 'utf8');
  const preview = migrateGpuQueue({ inputFile: f.inputFile }); assert.equal(preview.changed, 2); assert.equal(fs.readFileSync(stateFile, 'utf8'), original);
  const result = migrateGpuQueue({ inputFile: f.inputFile, apply: true }); assert.equal(result.applied, true);
  const after = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(after.pendingRevisions.length, 2); assert.equal(after.queue.length, 0);
  for (const run of after.runs.slice(0, 2)) { assert.equal(run.testStatus, 'not-tested'); assert.equal(run.operatorFailure, false); assert.equal(run.error, 'generic old error'); }
  const { originalPlan, ...enrichedActual } = after.runs[2];
  assert.deepEqual(originalPlan, f.actualFailure.plan);
  assert.deepEqual(enrichedActual, { ...f.actualFailure, plan: { ...f.actualFailure.plan, runtimeRevision: '', languageOverride: null } });
  assert.equal(fs.readFileSync(path.join(result.backup, 'queue-state.before.json'), 'utf8'), original);
  assert.equal(migrateGpuQueue({ inputFile: f.inputFile, apply: true }).changed, 0);
});

test('migration refuses a live coordinator or current task without modifying state', t => {
  const f = migrationFixture(t), stateFile = path.join(f.directory, 'queue-state.json');
  fs.writeFileSync(path.join(f.directory, '.queue.lock'), JSON.stringify({ pid: process.pid }));
  const before = fs.readFileSync(stateFile, 'utf8');
  assert.throws(() => migrateGpuQueue({ inputFile: f.inputFile, apply: true }), /仍在运行/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  fs.unlinkSync(path.join(f.directory, '.queue.lock'));
  fs.writeFileSync(stateFile, JSON.stringify({ ...f.state, current: { plan: plan('real-current') } }));
  const current = fs.readFileSync(stateFile, 'utf8');
  assert.throws(() => migrateGpuQueue({ inputFile: f.inputFile, apply: true }), /current/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), current);
});

test('coordinator cannot start while an active migration owns the state', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.directory, '.queue-migration.lock'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(runGpuQueue({ ...f, log() {}, transcribe: async () => assert.fail('GPU must not start') }), /正在安全迁移/);
  assert.equal(fs.existsSync(path.join(f.directory, '.queue.lock')), false);
});

test('a requested runtime revision waits for its own READY hash without starting the wrong GPU library', async t => {
  const f = fixture(t), variant = path.join(f.root, 'speech/gpu-v1/variants/pinned-cudnn'); fs.mkdirSync(path.join(variant, 'ctranslate2'), { recursive: true });
  fs.writeFileSync(path.join(variant, 'ctranslate2/__init__.py'), ''); fs.writeFileSync(path.join(variant, 'variant.json'), '{}'); fs.writeFileSync(path.join(variant, 'READY.json'), '{}');
  const controller = new AbortController(); let gpuCalls = 0;
  const task = runGpuQueue({ ...f, waitMs: 5, signal: controller.signal, log() {}, transcribe: async () => { gpuCalls++; assert.fail('Wrong revision must not run'); } });
  submitCommand(f.directory, { action: 'submit', plan: plan('future-runtime', { runtimeVariant: 'pinned-cudnn', runtimeRevision: 'a'.repeat(64) }) });
  await until(() => JSON.parse(fs.readFileSync(path.join(f.directory, 'queue-state.json'))).pendingRevisions.length === 1);
  assert.equal(gpuCalls, 0); controller.abort(); await task;
});

test('failure timing separates accepted audio position, wall time, stall gap, and unverified driver evidence', t => {
  const f = fixture(t), output = path.join(f.directory, 'failed'); fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'checkpoint.json'), JSON.stringify({ parts: [{ index: 0, startSample: 0, samples: 160000, text: 'first accepted segment', device: 'cuda' }] }));
  const events = [{ event: 'start', at: '2026-11-06T12:00:00.000Z' },
    { event: 'result', at: '2026-11-06T12:00:03.000Z', index: 0, result: { elapsedMs: 3000, text: 'first accepted segment' } },
    { event: 'error', at: '2026-11-06T12:02:03.000Z', startSample: 160000, workerExit: { hexCode: '0xc0000409' } }];
  fs.writeFileSync(path.join(output, 'raw-results.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const metrics = runMetrics({ outputDirectory: output, passed: false, startedAt: '2026-11-06T11:59:59.000Z', at: '2026-11-06T12:02:04.000Z' });
  assert.equal(metrics.wallSeconds, 125); assert.equal(metrics.wallToFirstFailureSeconds, 124);
  assert.equal(metrics.completedAudioSeconds, 10); assert.equal(metrics.failingAudioSeconds, 10);
  assert.equal(metrics.maxChunkElapsedMs, 3000); assert.equal(metrics.maxRawEventGapSeconds, 120);
  assert.equal(metrics.nativeExitCount, 1); assert.equal(metrics.tdr, 'not-checked-in-windows-log');
});

test('full-video audit rejects missing samples, CPU, resumed audio, and corrupt output', t => {
  const f = fixture(t), output = path.join(f.directory, 'run'); const result = completeOutput(f, output);
  assert.equal(assessFullResult(result, output, { source: f.source, expectedDuration: 21 }).passed, true);
  assert.equal(assessFullResult({ ...result, device: 'cpu' }, output).passed, false);
  assert.equal(assessFullResult({ ...result, totalSamples: result.totalSamples - 1 }, output).passed, false);
  assert.equal(assessFullResult(result, output, { expectedDuration: 2806 }).passed, false);
  fs.appendFileSync(result.eventsFile, JSON.stringify({ event: 'start', device: 'cuda', resumedChunks: 1 }) + '\n');
  assert.equal(assessFullResult(result, output).independent, false);
  fs.appendFileSync(result.eventsFile, JSON.stringify({ event: 'error', error: 'cudaErrorIllegalAddress' }) + '\n');
  assert.ok(assessFullResult(result, output).issues.some(issue => issue.includes('错误')));
});

test('idle queue consumes live inbox, avoids a renamed failed plan, and independently repeats a good full run', async t => {
  const f = fixture(t), calls = [], controller = new AbortController();
  t.after(() => controller.abort());
  const rejected = plan('renamed-failed'), good = plan('good', { computeType: 'float16' });
  const task = runGpuQueue({ ...f, waitMs: 5, signal: controller.signal, stopWhenVerified: true,
    log: event => {
      if (event.stage === 'plan-finished' && event.run.plan.id === 'failed') {
        submitCommand(f.directory, { action: 'submit', plan: rejected, reason: 'renaming must not bypass failure' });
        submitCommand(f.directory, { action: 'submit', plan: good, reason: 'different execution route' });
      }
    },
    transcribe: async options => { calls.push(options.plan.id); options.onProgress({ stage: 'transcribing', index: 0 });
      if (options.plan.id === 'failed') throw Error('cudaErrorIllegalAddress');
      return completeOutput(f, options.outputDirectory);
    } });
  await until(() => fs.existsSync(path.join(f.directory, 'queue-state.json')));
  submitCommand(f.directory, { action: 'submit', plan: plan('failed'), reason: 'new route' });
  const { state, registry } = await task;
  assert.deepEqual(calls, ['failed', 'good', 'good']);
  assert.ok(state.commands.some(command => !command.accepted && command.reason.includes('已经失败')));
  assert.equal(registry.methods.length, 1); assert.equal(registry.methods[0].repeatVerified, true);
  assert.equal(registry.methods[0].complete, true); assert.equal(registry.methods[0].performanceVerified, false);
  assert.equal(registry.methods[0].performance.status, 'not-measured'); assert.equal(registry.performanceReference.status, 'not-measured');
  assert.notEqual(registry.methods[0].verifiedRuns[0].outputDirectory, registry.methods[0].verifiedRuns[1].outputDirectory);
  assert.equal(state.pendingRevisions[0].plan.runtimeVariant, 'pinned-cudnn');
});

test('external PID, lock owner, raw worker, and recent output prevent concurrent GPU work', async t => {
  const f = fixture(t), outputDirectory = path.join(f.directory, 'external'); fs.mkdirSync(outputDirectory);
  const external = { plan: 'external', pid: process.pid, outputDirectory, startedAt: new Date().toISOString() };
  assert.equal(externalJobActivity(external).active, true);
  fs.writeFileSync(path.join(outputDirectory, 'raw-results.jsonl'), JSON.stringify({ event: 'result', index: 2 }) + '\n');
  assert.equal(externalJobActivity({ ...external, pid: 2147483646 }).active, true);
  fs.writeFileSync(path.join(outputDirectory, '.transcription.lock'), JSON.stringify({ pid: process.pid }));
  const ancient = new Date(0); fs.utimesSync(path.join(outputDirectory, 'raw-results.jsonl'), ancient, ancient);
  assert.equal(externalJobActivity({ ...external, pid: 2147483646 }).active, true);
  fs.unlinkSync(path.join(outputDirectory, '.transcription.lock'));
  assert.equal(externalJobActivity({ ...external, pid: 2147483646 }).active, false);
  fs.writeFileSync(path.join(f.directory, 'active-external-job.json'), JSON.stringify(external));
  const controller = new AbortController(); let calls = 0;
  const task = runGpuQueue({ ...f, waitMs: 5, signal: controller.signal, log() {}, transcribe: async () => { calls++; throw Error('must not start'); } });
  await delay(30); submitCommand(f.directory, { action: 'submit', plan: plan('queued') });
  await until(() => JSON.parse(fs.readFileSync(path.join(f.directory, 'queue-state.json'))).queue.length === 1);
  assert.equal(calls, 0); controller.abort(); await task;
});

test('rejecting an invalid replacement preserves the old queued draft', async t => {
  const f = fixture(t), old = plan('old'), bad = plan('bad', { computeType: 'float16' });
  fs.writeFileSync(path.join(f.directory, 'queue-state.json'), JSON.stringify({ version: 2, queue: [old], runs: [{ plan: bad, passed: false, error: 'known failure' }], current: null }));
  const outputDirectory = path.join(f.directory, 'external'); fs.mkdirSync(outputDirectory);
  fs.writeFileSync(path.join(f.directory, 'active-external-job.json'), JSON.stringify({ plan: 'external', pid: process.pid, outputDirectory }));
  const controller = new AbortController();
  const task = runGpuQueue({ ...f, waitMs: 5, signal: controller.signal, log() {}, transcribe: async () => assert.fail('no GPU expected') });
  submitCommand(f.directory, { action: 'revise', replaces: 'old', plan: bad });
  await until(() => JSON.parse(fs.readFileSync(path.join(f.directory, 'queue-state.json'))).commands.length === 1);
  const state = JSON.parse(fs.readFileSync(path.join(f.directory, 'queue-state.json'))); assert.deepEqual(state.queue.map(plan => plan.id), ['old']);
  controller.abort(); await task;
});

test('prioritize changes only queued order while the active run remains untouched', async t => {
  const f = fixture(t), plans = [plan('active'), plan('slow'), plan('fast-repeat')];
  fs.writeFileSync(f.inputFile, JSON.stringify({ source: f.source, plans }));
  const controller = new AbortController();
  const task = runGpuQueue({ ...f, waitMs: 5, signal: controller.signal, log() {}, transcribe: async options => {
    assert.equal(options.plan.id, 'active'); options.onProgress({ stage: 'transcribing', index: 0 });
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  await until(() => JSON.parse(fs.readFileSync(path.join(f.directory, 'queue-state.json'))).current?.plan.id === 'active');
  submitCommand(f.directory, { action: 'prioritize', planId: 'fast-repeat', reason: 'repeat the quickest complete candidate first' });
  await until(() => JSON.parse(fs.readFileSync(path.join(f.directory, 'queue-state.json'))).queue[0]?.id === 'fast-repeat');
  const state = JSON.parse(fs.readFileSync(path.join(f.directory, 'queue-state.json')));
  assert.equal(state.current.plan.id, 'active'); assert.deepEqual(state.queue.map(plan => plan.id), ['fast-repeat', 'slow']);
  controller.abort(Error('test stop')); await task;
});

test('a boundary restart adopts an already completed run without appending to its raw proof', async t => {
  const f = fixture(t), execution = plan('boundary-completed'), first = path.join(f.directory, 'runs', 'boundary-completed-1');
  const complete = directory => {
    const result = completeOutput(f, directory);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result));
    fs.appendFileSync(result.eventsFile, JSON.stringify({ event: 'complete', totalSamples: result.totalSamples, totalChunks: result.chunks, transcriptSha256: result.transcriptSha256 }) + '\n');
    return result;
  };
  const firstResult = complete(first), rawBefore = fs.readFileSync(firstResult.eventsFile, 'utf8');
  fs.writeFileSync(path.join(f.directory, 'queue-state.json'), JSON.stringify({ version: 2, queue: [], runs: [], current: { plan: execution, outputDirectory: first, startedAt: new Date().toISOString() } }));
  let calls = 0;
  const { state } = await runGpuQueue({ ...f, waitMs: 5, stopWhenVerified: true, log() {}, transcribe: async options => {
    calls++; assert.notEqual(options.outputDirectory, first); return complete(options.outputDirectory);
  } });
  assert.equal(calls, 1); assert.equal(state.runs.length, 2);
  assert.equal(fs.readFileSync(firstResult.eventsFile, 'utf8'), rawBefore);
});
