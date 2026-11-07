import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseNativeCacheArgs, prepareNativeCacheExperiment } from '../scripts/prepare-native-cache-experiment.mjs';
const require = createRequire(import.meta.url);
const { transcribeGpuFile, normalizePlan, providerFor } = require('../src/speech/gpu-file.cjs');
const { createSpeechPlatform } = require('../src/speech/platform.cjs');

function fixture(t, customize = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-file-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.wav'); fs.writeFileSync(source, 'source-media');
  const outputDirectory = path.join(directory, 'result'); let requests = 0;
  const speech = { status: () => ({ device: 'cuda' }), retain() {}, close() {}, probe: async () => {},
    request: async (_type, fields, _signal, record) => {
      requests++;
      const result = { text: 'Real speech ' + requests, segments: [{ start: 0, end: 1, text: 'Real speech ' + requests }] };
      await record(result); return result;
    }, ...customize };
  return { directory, speech, requests: () => requests, options: { source, outputDirectory, root: directory,
    ffmpeg: path.join(directory, 'ffmpeg.exe'), runtime: { model: 'large-v3-turbo', pythonExecutable: path.join(directory, 'python.exe'), modelDirectory: path.join(directory, 'model') },
    plan: { chunkSeconds: 10, runtimeVariant: 'bundled', languageOverride: null },
    providerFactory: () => speech, executeImpl: async (_file, args) => fs.writeFileSync(args.at(-1), Buffer.alloc(21 * 16000 * 2, 1)) } };
}

test('independent GPU file transcription covers every sample and resumes without repeating accepted audio', async t => {
  const f = fixture(t);
  const result = await transcribeGpuFile(f.options);
  assert.equal(result.device, 'cuda'); assert.equal(result.complete, true); assert.equal(result.chunks, 3);
  assert.equal(result.totalSamples, 21 * 16000); assert.equal(result.recoveries, 0);
  const checkpoint = JSON.parse(fs.readFileSync(result.checkpointFile));
  assert.deepEqual(checkpoint.parts.map(p => [p.startSample / 16000, p.samples / 16000]), [[0, 10], [10, 10], [20, 1]]);
  assert.deepEqual(checkpoint.parts.map(p => p.segments[0].start), [0, 10, 20]);
  assert.equal(fs.readFileSync(result.eventsFile, 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.event === 'result').length, 3);
  const again = await transcribeGpuFile(f.options); assert.equal(again.transcriptSha256, result.transcriptSha256); assert.equal(f.requests(), 3);
});

test('independent method refuses a CPU provider and never labels its output as GPU', async t => {
  const f = fixture(t, { status: () => ({ device: 'cpu' }) });
  await assert.rejects(transcribeGpuFile(f.options), /拒绝使用 CPU/);
  assert.equal(f.requests(), 0);
});

test('failure records retain the original bad output and do not save it as a completed transcript', async t => {
  const f = fixture(t, { request: async (_type, _fields, _signal, record) => {
    await record({ text: '!'.repeat(224) });
    throw Object.assign(Error('异常重复标点'), { code: 'SPEECH_UNRELIABLE' });
  } });
  await assert.rejects(transcribeGpuFile(f.options), /异常重复标点/);
  assert.equal(fs.existsSync(path.join(f.options.outputDirectory, 'result.json')), false);
  const events = fs.readFileSync(path.join(f.options.outputDirectory, 'raw-results.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.event === 'result' && e.result.text === '!'.repeat(224)).length, 1);
  assert.equal(events.filter(e => e.event === 'error').length, 1);
});

test('GPU precision is explicit, survives model selection, and is passed to the actual worker environment', () => {
  const platform = createSpeechPlatform({ id: 'win32', arch: 'x64', computeType: 'float32' });
  assert.equal(platform.profile.device, 'cuda'); assert.equal(platform.profile.computeType, 'float32');
  assert.equal(platform.withModel('large-v3-turbo').profile.computeType, 'float32');
  assert.equal(platform.environment('C:\\state').NOTION_SWITCH_SPEECH_COMPUTE_TYPE, 'float32');
  assert.throws(() => normalizePlan({ computeType: 'int8' }), /无效/);
  assert.throws(() => normalizePlan({ device: 'cpu' }), /无效/);
});

test('encoder microbatch is opt-in and reaches only the batched worker request', async t => {
  let request;
  const f = fixture(t, { request: async (_type, fields, _signal, record) => {
    request = fields;
    const result = { text: 'Complete microbatched speech', segments: [] };
    record(result); return result;
  } });
  f.options.plan = { ...f.options.plan, chunkSeconds: 120, batchSize: 4, batchClipSeconds: 30, encoderMicrobatchSize: 1 };
  await transcribeGpuFile(f.options);
  assert.equal(request.encoderMicrobatchSize, 1);
  assert.equal(request.batchSize, 4);
  assert.equal(request.clipSeconds, 30);
  assert.throws(() => normalizePlan({ batchSize: 2, chunkSeconds: 60, encoderMicrobatchSize: 1 }), /无效/);
});

test('generated timestamps are an explicit independent batched policy', () => {
  assert.equal(normalizePlan({ batchSize: 2, chunkSeconds: 60, timestampedBatch: true }).timestampedBatch, true);
  assert.throws(() => normalizePlan({ timestampedBatch: true }), /无效/);
});

test('Native whole-window is explicit, scalar and does not expand default request limits', () => {
  const plan = normalizePlan({ nativeWholeWindow: true, chunkSeconds: 120 });
  assert.equal(plan.nativeWholeWindow, true);
  assert.throws(() => normalizePlan({ chunkSeconds: 120 }), /无效/);
  assert.throws(() => normalizePlan({ nativeWholeWindow: true, chunkSeconds: 120, runtimeVariant: 'pinned-cudnn' }), /无效/);
});

test('nondefault CUDA allocation caches are explicit single-variable Native30 speed trials', () => {
  assert.equal(normalizePlan({ allocatorCache: 'large' }).allocatorCache, 'large');
  assert.equal(normalizePlan({ allocatorCache: 'compact' }).allocatorCache, 'compact');
  assert.equal(normalizePlan().allocatorCache, 'default');
  for (const allocatorCache of [null, {}, ['compact'], { toString: () => 'compact' }]) assert.throws(() => normalizePlan({ allocatorCache }), /无效/);
  for (const value of [{ allocatorCache: 'unknown' }, { allocatorCache: 'large', allocator: 'cuda_malloc_async' },
    { allocatorCache: 'large', runtimeVariant: 'pinned-cudnn' }, { allocatorCache: 'large', chunkSeconds: 20 },
    { allocatorCache: 'large', launchBlocking: false }, { allocatorCache: 'large', computeType: 'int8_float16' }]) {
    assert.throws(() => normalizePlan(value), /无效/);
  }
  for (const allocatorCache of ['large', 'compact']) for (const changes of [{ allocator: 'cuda_malloc_async' },
    { runtimeVariant: 'pinned-cudnn' }, { chunkSeconds: 20 }, { launchBlocking: false }, { computeType: 'int8_float16' },
    { beamSize: 5 }, { fp16Gemm: true }, { resetEveryChunks: 1 }, { nativeWholeWindow: true }, { shortEncoder: true },
    { batchSize: 2, chunkSeconds: 60 }]) assert.throws(() => normalizePlan({ allocatorCache, ...changes }), /无效/);
});

test('private FP16 accumulation requires its frozen runtime and keeps every Native30 safety boundary', () => {
  const good = { runtimeVariant: 'sm75-native-fp16-accum-v1', runtimeRevision: 'a'.repeat(64), fp16Gemm: true };
  assert.equal(normalizePlan(good).runtimeVariant, good.runtimeVariant);
  assert.equal(normalizePlan({ ...good, fp16Gemm: false }).fp16Gemm, false);
  for (const changes of [{ runtimeRevision: '' }, { computeType: 'int8_float16' }, { chunkSeconds: 20 },
    { allocator: 'cuda_malloc_async' }, { allocatorCache: 'compact' }, { launchBlocking: false }, { beamSize: 5 },
    { batchSize: 2, chunkSeconds: 60 }, { timestampedBatch: true }, { nativeWholeWindow: true },
    { shortEncoder: true }, { gpuEncoderBridge: true }, { resetEveryChunks: 1 }]) {
    assert.throws(() => normalizePlan({ ...good, ...changes }), /无效/);
  }
  assert.equal(normalizePlan().runtimeVariant, 'sm75-native');
  assert.equal(normalizePlan().fp16Gemm, false);
});

test('the private runtime and its accumulation switch reach the actual worker spawn together', async t => {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'gpu-private-env-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const directory = path.join(root, 'speech/gpu-v1/variants/sm75-native-fp16-accum-v1');
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'READY.json'), '{}');
  const runtimeRevision = createHash('sha256').update('{}').digest('hex');
  const platform = createSpeechPlatform({ id: 'win32', arch: 'x64', model: 'large-v3-turbo', computeType: 'float16' });
  const runtime = { ...platform.profile, pythonExecutable: path.join(root, 'python.exe'), modelDirectory: path.join(root, 'model'), dllDirectories: [] };
  for (const fp16Gemm of [false, true]) {
    let environment;
    const plan = normalizePlan({ runtimeVariant: 'sm75-native-fp16-accum-v1', runtimeRevision, fp16Gemm });
    const provider = providerFor({ root, runtime, plan, spawnImpl: (_file, _args, options) => { environment = options.env; throw Error('captured-before-process'); } });
    await assert.rejects(provider.start(), /captured-before-process/);
    assert.equal(environment.NOTION_SWITCH_CT2_MODULE_PATH, directory);
    assert.equal(environment.CT2_CUDA_TRUE_FP16_GEMM, fp16Gemm ? '1' : '0');
    assert.equal(environment.CUDA_LAUNCH_BLOCKING, '1');
    assert.equal(environment.CT2_CUDA_CACHING_ALLOCATOR_CONFIG, '4,3,12,209715200');
    await provider.close();
  }
});

test('the selected CUDA cache reaches the actual child environment without changing inference precision', async t => {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'gpu-cache-env-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const ready = path.join(root, 'speech/gpu-v1/variants/sm75-native/READY.json');
  fs.mkdirSync(path.dirname(ready), { recursive: true }); fs.writeFileSync(ready, '{}');
  const platform = createSpeechPlatform({ id: 'win32', arch: 'x64', model: 'large-v3-turbo', computeType: 'float16' });
  const runtime = { ...platform.profile, pythonExecutable: path.join(root, 'python.exe'), modelDirectory: path.join(root, 'model'), dllDirectories: [] };
  for (const [allocatorCache, expected] of [['default', '4,3,12,209715200'], ['large', '4,3,14,1073741824'], ['compact', '2,6,28,1073741824']]) {
    let environment;
    const provider = providerFor({ root, runtime, plan: normalizePlan({ allocatorCache }),
      spawnImpl: (_file, _args, options) => { environment = options.env; throw Error('captured-before-process'); } });
    await assert.rejects(provider.start(), /captured-before-process/);
    assert.equal(environment.CT2_CUDA_CACHING_ALLOCATOR_CONFIG, expected);
    assert.equal(environment.CUDA_LAUNCH_BLOCKING, '1'); assert.equal(environment.CT2_CUDA_TRUE_FP16_GEMM, '0');
    assert.equal(environment.NOTION_SWITCH_SPEECH_COMPUTE_TYPE, 'float16');
    await provider.close();
  }
});

test('the raw start record uses the exact same CUDA cache configuration as the child', async t => {
  for (const [allocatorCache, expected] of [['default', '4,3,12,209715200'], ['large', '4,3,14,1073741824'], ['compact', '2,6,28,1073741824']]) {
    const f = fixture(t); f.options.plan = { allocatorCache };
    const result = await transcribeGpuFile(f.options);
    const start = fs.readFileSync(result.eventsFile, 'utf8').trim().split('\n').map(JSON.parse).find(event => event.event === 'start');
    assert.equal(start.allocatorCache, allocatorCache);
    assert.equal(start.allocatorConfig, expected);
    assert.equal(result.plan.computeType, 'float16');
  }
});

test('cache candidate CLI supports flag and clean positional compact while retaining the large default', () => {
  assert.deepEqual(parseNativeCacheArgs([]), {});
  assert.deepEqual(parseNativeCacheArgs(['C:/bundle']), { bundle: 'C:/bundle' });
  assert.deepEqual(parseNativeCacheArgs(['C:/bundle', '--variant', 'compact']), { bundle: 'C:/bundle', variant: 'compact' });
  assert.deepEqual(parseNativeCacheArgs(['--variant', 'compact', '--bundle', 'C:/bundle']), { variant: 'compact', bundle: 'C:/bundle' });
  assert.deepEqual(parseNativeCacheArgs(['C:/bundle', 'compact']), { bundle: 'C:/bundle', variant: 'compact' });
  assert.deepEqual(parseNativeCacheArgs(['compact']), { variant: 'compact' });
  assert.throws(() => parseNativeCacheArgs(['--variant']), /Usage/);
  assert.throws(() => prepareNativeCacheExperiment({ variant: 'unknown' }), /variant/);
});

test('preparing compact publishes a separate immutable candidate and never overwrites large or defaults', t => {
  const parent = fs.realpathSync(os.tmpdir()), bundle = fs.mkdtempSync(path.join(parent, 'cache-preparation-fixture-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(bundle)), parent); fs.rmSync(bundle, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(bundle, 'profiles'));
  fs.writeFileSync(path.join(bundle, 'profiles/native30.json'), JSON.stringify(normalizePlan()));
  const machineFile = path.join(bundle, 'machine.json');
  const native30 = { planFile: 'profiles/native30.json', medianSeconds: 194.092 };
  fs.writeFileSync(machineFile, JSON.stringify({ resourcesRoot: 'resources', profiles: { native30, winner: native30 } }));
  const large = prepareNativeCacheExperiment({ bundle });
  assert.equal(large.name, 'bench-native30-cache1g-v1'); assert.equal(large.config, '4,3,14,1073741824');
  const before = JSON.parse(fs.readFileSync(machineFile)), largeProfile = before.profiles[large.name];
  const largePlan = fs.readFileSync(path.join(bundle, largeProfile.planFile));
  const largeEntry = fs.readFileSync(path.join(bundle, largeProfile.entryFile));
  const compact = prepareNativeCacheExperiment({ bundle, variant: 'compact' });
  const after = JSON.parse(fs.readFileSync(machineFile)), compactProfile = after.profiles[compact.name];
  assert.equal(compact.name, 'bench-native30-cachecompact-v1'); assert.equal(compact.config, '2,6,28,1073741824');
  assert.equal(JSON.parse(fs.readFileSync(path.join(bundle, compactProfile.planFile))).allocatorCache, 'compact');
  assert.equal(compactProfile.experimental, true); assert.equal(compactProfile.status, 'candidate');
  assert.deepEqual(after.profiles[large.name], largeProfile); assert.deepEqual(after.profiles.native30, before.profiles.native30);
  assert.deepEqual(after.profiles.winner, before.profiles.winner);
  assert.deepEqual(fs.readFileSync(path.join(bundle, largeProfile.planFile)), largePlan);
  assert.deepEqual(fs.readFileSync(path.join(bundle, largeProfile.entryFile)), largeEntry);
  const saved = fs.readFileSync(machineFile);
  assert.throws(() => prepareNativeCacheExperiment({ bundle, variant: 'compact' }), /overwrite/);
  assert.throws(() => prepareNativeCacheExperiment({ bundle }), /overwrite/);
  assert.deepEqual(fs.readFileSync(machineFile), saved);
});

test('complete 120-second windows select an explicit quality policy and preserve the stable defaults', async t => {
  const good = { nativeWholeWindow: true, chunkSeconds: 120, windowMode: 'coverage-clips30' };
  assert.equal(normalizePlan(good).windowMode, 'coverage-clips30');
  assert.equal(normalizePlan().windowMode, 'legacy');
  for (const changes of [{ nativeWholeWindow: false }, { chunkSeconds: 30 }, { launchBlocking: false },
    { runtimeVariant: 'pinned-cudnn' }, { batchSize: 2 }, { windowMode: 'unknown' }, { fp16Gemm: true },
    { resetEveryChunks: 1 }]) assert.throws(() => normalizePlan({ ...good, ...changes }), /无效/);
  let fields;
  const f = fixture(t, { request: async (_type, input, _signal, record) => {
    fields = input; const result = { text: 'Complete GPU window', segments: [] }; await record(result); return result;
  } });
  f.options.plan = good;
  await transcribeGpuFile(f.options);
  assert.equal(fields.decodingPolicy, 'stable-gpu-v1-complete-window');
  assert.equal(fields.nativeWindowSeconds, 120); assert.equal(fields.windowMode, 'coverage-clips30');
});

test('short encoder is an isolated Native B1 policy and cannot alter a live or batched profile', async t => {
  assert.equal(normalizePlan({ shortEncoder: true }).shortEncoder, true);
  assert.equal(normalizePlan().shortEncoder, false);
  for (const changes of [{ shortEncoder: 1 }, { chunkSeconds: 20 }, { runtimeVariant: 'pinned-cudnn' },
    { computeType: 'int8_float16' }, { launchBlocking: false }, { beamSize: 5 }, { fp16Gemm: true },
    { allocator: 'cuda_malloc_async' }, { resetEveryChunks: 1 }, { nativeWholeWindow: true },
    { batchSize: 2, chunkSeconds: 60, timestampedBatch: true }]) {
    assert.throws(() => normalizePlan({ shortEncoder: true, ...changes }), /无效/);
  }
  let fields;
  const f = fixture(t, { request: async (_type, input, _signal, record) => {
    fields = input; const result = { text: 'Short encoder candidate', segments: [] }; await record(result); return result;
  } });
  f.options.plan = { shortEncoder: true };
  await transcribeGpuFile(f.options);
  assert.equal(fields.decodingPolicy, 'stable-gpu-v1-short-encoder');
});

test('GPU-only encoder concat is explicit and requires native GPUops synchronous FP16 timestamped B2/B4', async t => {
  const good = { runtimeVariant: 'sm75-native-gpuops', gpuEncoderBridge: true, timestampedBatch: true,
    batchSize: 4, chunkSeconds: 120, batchClipSeconds: 30 };
  assert.equal(normalizePlan(good).gpuEncoderBridge, true);
  for (const changes of [{ gpuEncoderBridge: 1 }, { gpuEncoderBridge: false }, { runtimeVariant: 'sm75-native' },
    { runtimeVariant: 'pinned-cudnn' }, { timestampedBatch: false }, { batchSize: 8 }, { computeType: 'int8_float16' },
    { launchBlocking: false }, { beamSize: 5 }, { fp16Gemm: true }, { allocator: 'cuda_malloc_async' },
    { resetEveryChunks: 1 }, { encoderMicrobatchSize: 1 }, { nativeWholeWindow: true }]) {
    assert.throws(() => normalizePlan({ ...good, ...changes }), /无效/);
  }
  let fields;
  const f = fixture(t, { request: async (_type, input, _signal, record) => {
    fields = input; const result = { text: 'GPU concatenation candidate', segments: [] }; await record(result); return result;
  } });
  f.options.plan = good;
  const result = await transcribeGpuFile(f.options);
  assert.equal(fields.gpuEncoderBridge, true); assert.equal(fields.decodingPolicy, 'stable-gpu-v1-batched-timestamps');
  assert.equal(fields.batchSize, 4); assert.equal(result.plan.gpuEncoderBridge, true);
});
