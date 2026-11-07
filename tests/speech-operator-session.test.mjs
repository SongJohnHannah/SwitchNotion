import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSpeechSession, POLICY } = require('../src/speech/operator-session.cjs');
const { acquireGpuLease } = require('../src/speech/gpu-lease.cjs');
const { createSpeechPlatform } = require('../src/speech/platform.cjs');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const pcm = () => { const value = Buffer.alloc(64000); for (let i = 0; i < value.length; i += 4) value.writeFloatLE(.1, i); return value; };

async function fixture(t, hooks = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-session-'));
  const runtime = { pythonExecutable: path.join(root, 'python.exe'), modelDirectory: path.join(root, 'model'),
    model: 'large-v3-turbo', platform: 'win32', architecture: 'x64', device: 'cuda', computeType: 'float16' };
  await fs.writeFile(runtime.pythonExecutable, 'mock interpreter'); await fs.mkdir(runtime.modelDirectory);
  const calls = [], providers = [], sessions = [];
  const factory = options => {
    let ready = false;
    const provider = { runtime, child: { pid: 12345 + providers.length },
      status: () => ({ model: runtime.model, device: hooks.device || 'cuda', computeType: 'float16', ready, loaded: ready }),
      retain() { calls.push(['retain', provider]); },
      async configure() { calls.push(['configure', provider]); return runtime; },
      async probe({ signal }) { calls.push(['probe', provider]); signal.throwIfAborted(); ready = true; },
      async request(type, fields, signal, onResult) {
        calls.push(['request', provider, type, fields]); ready = true;
        const result = await (hooks.request?.({ provider, type, fields, signal, onResult }) ||
          { text: 'heard speech', language: fields.language, contextText: 'reliable', workerPid: provider.child.pid });
        await onResult(result); return result;
      },
      async close() { calls.push(['close-start', provider]); await hooks.close?.(provider); ready = false; calls.push(['close-end', provider]); },
    };
    providers.push(provider); calls.push(['factory', options]); return provider;
  };
  function session(extra = {}) {
    const value = createSpeechSession({ root, runtime, providerFactory: factory,
      platform: createSpeechPlatform({ id: 'win32', arch: 'x64', model: 'large-v3-turbo', computeType: 'float16' }), ...extra });
    sessions.push(value); return value;
  }
  t.after(async () => { for (const value of sessions) await value.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { root, runtime, calls, providers, session };
}

test('construction/configure use no GPU lease; Turbo-only platform supplies safe recording environment', async t => {
  const f = await fixture(t); let acquired = 0;
  const session = f.session({ acquireLease: async () => { acquired++; throw Error('should not acquire'); } });
  assert.equal(f.calls.length, 0);
  assert.equal((await session.configure()).model, 'large-v3-turbo');
  assert.equal(acquired, 0);
  assert.equal(f.calls.filter(([name]) => name === 'probe' || name === 'request').length, 0);
  assert.equal(session.platform.withModel('large-v3-turbo'), session.platform);
  assert.throws(() => session.platform.withModel('medium'), /仅支持/);
  const env = session.platform.environment(f.root);
  assert.equal(env.NOTION_SWITCH_SPEECH_COMPUTE_TYPE, 'float16');
  assert.equal(env.PYTHONUTF8, '1');
});

test('a file lease blocks probe; two sessions share the same cross-project lease and drain on release', async t => {
  const f = await fixture(t); const waitedA = deferred(), waitedB = deferred();
  const file = await acquireGpuLease({ root: f.root });
  const a = f.session({ onProgress: event => event.stage === 'waiting-gpu' && waitedA.resolve() });
  a.retain(); const probe = a.probe(); await waitedA.promise;
  assert.equal(f.providers.length, 0);
  await file.release(); await probe;
  const b = f.session({ onProgress: event => event.stage === 'waiting-gpu' && waitedB.resolve() });
  const text = b.transcribe({ pcm: pcm(), language: 'zh', context: 'must not prime the decoder' });
  await waitedB.promise;
  assert.equal(f.calls.filter(([name]) => name === 'request').length, 0);
  await a.release(); assert.equal(await text, 'heard speech');
  assert.equal(f.calls.filter(([name]) => name === 'close-end').length, 2);
  const request = f.calls.find(([name]) => name === 'request');
  assert.equal(request[3].decodingPolicy, POLICY); assert.equal(request[3].context, '');
  assert.equal(request[3].language, 'zh');
  assert.equal(f.calls.find(([name]) => name === 'factory')[1].plan.languageOverride, null);
});

test('unretained requests promptly close and return their GPU lease; retained requests reuse one worker', async t => {
  const f = await fixture(t); const session = f.session();
  await session.transcribeDetailed({ pcm: pcm() });
  assert.equal(f.providers.length, 1);
  assert.equal(session.gpuLease, null);
  session.retain();
  await session.transcribe({ pcm: pcm() }); await session.transcribe({ pcm: pcm() });
  assert.equal(f.providers.length, 2); assert(session.gpuLease);
  await session.release(); assert.equal(session.gpuLease, null);
});

test('concurrent requests in one retained session are serialized on one worker', async t => {
  let active = 0, maximum = 0;
  const f = await fixture(t, { request: async () => {
    active++; maximum = Math.max(maximum, active); await pause(15); active--;
    return { text: 'serial result', workerPid: 12345 };
  } });
  const session = f.session(); session.retain();
  assert.deepEqual(await Promise.all([1, 2, 3].map(() => session.transcribe({ pcm: pcm() }))),
    ['serial result', 'serial result', 'serial result']);
  assert.equal(maximum, 1); assert.equal(f.providers.length, 1);
  await session.release();
});

test('bad raw text is persisted before rejection and keeps the actual input PCM hash and worker PID', async t => {
  const f = await fixture(t, { request: async () => ({ text: '!'.repeat(100), workerPid: 43210 }) });
  const session = f.session(); let delivered = false;
  await assert.rejects(session.transcribeDetailed({ pcm: pcm(), onResult: () => { delivered = true; } }), { code: 'SPEECH_UNRELIABLE' });
  const events = (await fs.readFile(session.eventsFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.find(event => event.event === 'result').result.text, '!'.repeat(100));
  assert.equal(events.find(event => event.event === 'result').workerPid, 43210);
  assert.match(events.find(event => event.event === 'result').pcmSha256, /^[a-f0-9]{64}$/);
  assert.equal(events.at(-1).event, 'error'); assert.equal(delivered, false);
  assert.equal(session.gpuLease, null);
});

test('cancelling a waiter never closes another session worker or acquires a GPU lease', async t => {
  const f = await fixture(t); const owner = f.session(); owner.retain(); await owner.probe();
  const waiting = deferred(); const waiter = f.session({ onProgress: () => waiting.resolve() });
  const controller = new AbortController(); const task = waiter.transcribe({ pcm: pcm(), signal: controller.signal });
  await waiting.promise; controller.abort(Error('cancel only waiter'));
  await assert.rejects(task, /cancel only waiter/);
  assert.equal(f.calls.filter(([name]) => name === 'close-start').length, 0);
  assert(owner.gpuLease); await owner.release();
});

test('close cancels only its request and keeps lease until BOTH request drain and provider.close finish', async t => {
  const requestEntered = deferred(), finishRequest = deferred(), closeEntered = deferred(), finishClose = deferred();
  const f = await fixture(t, { request: async () => { requestEntered.resolve(); return finishRequest.promise; },
    close: async () => { closeEntered.resolve(); await finishClose.promise; } });
  const a = f.session(); a.retain(); const task = a.transcribe({ pcm: pcm() });
  // Mark rejection handled before deliberately interrupting the request.
  const rejected = assert.rejects(task, /已停止/);
  await requestEntered.promise; const closing = a.close(); await closeEntered.promise;
  let acquired = false;
  const other = acquireGpuLease({ root: f.root }).then(value => { acquired = true; return value; });
  finishClose.resolve(); await pause(35); assert.equal(acquired, false); assert(a.gpuLease);
  finishRequest.resolve({ text: 'late text', workerPid: 12345 });
  await rejected; await closing;
  const lease = await other; assert.equal(acquired, true); await lease.release();
});

test('CPU provider and unsafe plans fail closed without delivering transcripts', async t => {
  const f = await fixture(t, { device: 'cpu' }); const session = f.session();
  await assert.rejects(session.transcribe({ pcm: pcm() }), /拒绝 CPU/);
  assert.equal(f.calls.filter(([name]) => name === 'request').length, 0);
  assert.equal(session.gpuLease, null);
  assert.throws(() => f.session({ planNative: { runtimeVariant: 'pinned-cudnn' } }), /Native30/);
  assert.throws(() => f.session({ runtime: { ...f.runtime, device: 'cpu' } }), /不能回退 CPU/);
});

test('active caller cancellation closes its worker and releases only after close has completed', async t => {
  const entered = deferred(), closeEntered = deferred(), finishClose = deferred();
  const f = await fixture(t, { request: async ({ signal }) => {
    entered.resolve();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, close: async () => { closeEntered.resolve(); await finishClose.promise; } });
  const session = f.session(); session.retain(); const controller = new AbortController();
  const task = session.transcribe({ pcm: pcm(), signal: controller.signal });
  const rejected = assert.rejects(task, /user cancelled/);
  await entered.promise; controller.abort(Error('user cancelled')); await closeEntered.promise;
  assert(session.gpuLease); finishClose.resolve(); await rejected;
  assert.equal(session.gpuLease, null);
});

test('uncertain worker close fails closed and retains GPU lease until explicit successful close retry', async t => {
  let fail = true;
  const f = await fixture(t, { close: async () => { if (fail) throw Error('worker exit unconfirmed'); } });
  const session = f.session();
  await assert.rejects(session.transcribe({ pcm: pcm() }), /exit unconfirmed/);
  assert(session.gpuLease);
  const waiting = deferred(); let acquired = false;
  const other = acquireGpuLease({ root: f.root, onWait: () => waiting.resolve() }).then(value => { acquired = true; return value; });
  await waiting.promise; assert.equal(acquired, false);
  fail = false; await session.close();
  const lease = await other; assert.equal(acquired, true); await lease.release();
});

test('recording dispatch preserves greedy policy and language and archives source/decoded PCM digests', async t => {
  const f = await fixture(t, { request: async ({ fields }) => ({ text: 'recorded speech', language: fields.language,
    workerPid: 333, recordingDecode: { pcmSha256: 'a'.repeat(64), samples: 16000, sampleRate: 16000 } }) });
  const session = f.session(); const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]);
  assert.equal(await session.transcribeRecording({ audio, language: 'auto' }), 'recorded speech');
  const request = f.calls.find(([name]) => name === 'request');
  assert.equal(request[2], 'transcribe_recording'); assert.equal(request[3].language, 'auto');
  assert.equal(request[3].decodingPolicy, POLICY); assert.equal(request[3].context, '');
  const events = (await fs.readFile(session.eventsFile, 'utf8')).trim().split('\n').map(JSON.parse);
  const raw = events.find(event => event.event === 'result');
  assert.match(raw.encodedSha256, /^[a-f0-9]{64}$/); assert.equal(raw.pcmSha256, 'a'.repeat(64));
});

test('WAV uses existing decoder, preserves fractional final samples and holds one session across chunks', async t => {
  const f = await fixture(t); const session = f.session(); const samples = 16000 + 19;
  const wav = Buffer.alloc(44 + samples * 2); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40); let progress = 0;
  assert.equal(await session.transcribeWav({ wav, chunkSeconds: 1, onProgress: value => { progress = value; } }), 'heard speech\nheard speech');
  const requests = f.calls.filter(([name]) => name === 'request');
  assert.deepEqual(requests.map(call => Buffer.from(call[3].audio, 'base64').length / 4), [16000, 19]);
  assert.equal(f.providers.length, 1); assert.equal(progress, 1); assert.equal(session.gpuLease, null);
});
