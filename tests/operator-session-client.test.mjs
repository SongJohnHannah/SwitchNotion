import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url), { OperatorSessionClient } = require('../src/speech/operator-session-client.cjs'), { RecordingTest } = require('../src/speech/recording-test.cjs');

function fixture(customize = {}) {
  const calls = [], loaded = [], state = { configured: true, loaded: false, ready: false, busy: false, device: 'cuda', model: 'large-v3-turbo' };
  const platform = { environment: root => ({ root }), withModel: model => { if (model !== 'large-v3-turbo') throw Error('Turbo only'); return platform; } };
  const session = { runtime: { model: 'large-v3-turbo', pythonExecutable: 'package-python', modelDirectory: 'package-model' }, leases: 0, platform,
    status: () => ({ ...state }), configure: async options => { calls.push(['configure', options]); return session.runtime; },
    probe: async options => { calls.push(['probe', options]); state.loaded = state.ready = true; return { ready: true }; },
    transcribeDetailed: async options => { calls.push(['detailed', options]); return { text: '中文 English', segments: [] }; },
    transcribe: async options => { calls.push(['pcm', options]); return '中文 English'; },
    transcribeWav: async options => { calls.push(['wav', options]); return 'WAV words'; },
    transcribeRecording: async options => { calls.push(['recording', options]); return 'Recorded words'; },
    retain() { this.leases++; calls.push(['retain']); }, release() { this.leases--; calls.push(['release']); },
    close() { state.loaded = state.ready = false; calls.push(['close']); }, ...customize };
  const directory = path.resolve('fixture-package'), factoryOptions = [];
  const provider = new OperatorSessionClient({ root: path.resolve('fixture-state'), directory, idleMs: 10, timeoutMs: 300,
    loader: entry => { loaded.push(entry); return { transcribeFile() {}, createSpeechSession: options => { factoryOptions.push(options); return session; } }; } });
  return { calls, loaded, state, session, provider, directory, factoryOptions };
}

test('live facade loads the shared package lazily, never warms GPU from status, and keeps package runtime/platform/leases', async () => {
  const f = fixture(); assert.equal(f.loaded.length, 0); assert.equal(f.calls.length, 0);
  const status = f.provider.status(); assert.equal(f.loaded[0], path.join(f.directory, 'operator.cjs'));
  assert.deepEqual(f.factoryOptions, [{ idleMs: 10, timeoutMs: 300 }]); assert.equal(f.calls.length, 0);
  assert.equal(status.device, 'cuda'); assert.equal(status.model, 'large-v3-turbo'); assert.equal(status.resourcesReady, true);
  assert.equal(status.ready, false); assert.equal(status.loaded, false); assert.equal(f.provider.runtime, f.session.runtime); assert.equal(f.provider.platform, f.session.platform);
  f.provider.retain(); assert.equal(f.provider.leases, 1); f.provider.release(); assert.equal(f.provider.leases, 0);
  const controller = new AbortController(); await f.provider.configure({ signal: controller.signal }); await f.provider.probe({ signal: controller.signal });
  assert.equal(f.calls.find(call => call[0] === 'configure')[1].signal, controller.signal); assert.equal(f.provider.status().loaded, true);
  f.provider.close(); assert.equal(f.provider.status().loaded, false); assert.equal(f.loaded.length, 1);
});

test('PCM, WAV and recording operations delegate unchanged with their signals and result callbacks', async () => {
  const f = fixture(), controller = new AbortController(), onResult = () => {};
  const options = { language: 'auto', signal: controller.signal, onResult, pcm: Buffer.alloc(16), audio: Buffer.alloc(8), wav: Buffer.alloc(12) };
  assert.equal((await f.provider.transcribeDetailed(options)).text, '中文 English');
  assert.equal(await f.provider.transcribe(options), '中文 English'); assert.equal(await f.provider.transcribeWav(options), 'WAV words');
  assert.equal(await f.provider.transcribeRecording(options), 'Recorded words'); assert.ok(f.calls.every(call => call[1] === options));
});

test('missing or incompatible packages never create an old provider or report a loaded CPU model', async () => {
  const failure = Object.assign(Error('missing operator'), { code: 'MODULE_NOT_FOUND' }); let loads = 0;
  const provider = new OperatorSessionClient({ root: path.resolve('fixture-state'), directory: path.resolve('missing-package'), loader: () => { loads++; throw failure; } });
  const status = provider.status(); assert.equal(status.device, 'cuda'); assert.equal(status.configured, false); assert.equal(status.loaded, false); assert.match(status.lastFailure, /项目内置 GPU.*无法加载/);
  await assert.rejects(provider.probe(), error => error.code === 'GPU_OPERATOR_UNAVAILABLE'); assert.ok(loads >= 1);
  const cpu = fixture({ status: () => ({ model: 'large-v3-turbo', device: 'cpu' }) });
  await assert.rejects(cpu.provider.probe(), /必须使用 NVIDIA GPU/); assert.equal(cpu.calls.length, 0); assert.equal(cpu.provider.status().configured, false);
  const changed = fixture(); changed.provider.status(); changed.state.device = 'cpu';
  await assert.rejects(changed.provider.transcribe({ pcm: Buffer.alloc(16) }), /必须使用 NVIDIA GPU/);
  assert.equal(changed.calls.length, 0); assert.equal(changed.provider.status().loaded, false);
});

test('recording warmup completes before transcription and cancellation aborts the same shared session while releasing its lease', async () => {
  let finishWarmup, warmSignal;
  const f = fixture({ probe: options => { warmSignal = options.signal; return new Promise(resolve => { finishWarmup = resolve; }); } });
  const recording = new RecordingTest({ provider: f.provider }); const session = await recording.start(); assert.equal(f.provider.leases, 1);
  const finishing = recording.finish({ ...session, audio: Uint8Array.from([1, 2]), mimeType: 'audio/webm' });
  await Promise.resolve(); assert.equal(f.calls.some(call => call[0] === 'recording'), false); finishWarmup({ ready: true });
  assert.equal((await finishing).text, 'Recorded words'); assert.equal(f.provider.leases, 0); assert.equal(warmSignal.aborted, false);
  const next = await recording.start(); recording.cancel(next.recordingId); finishWarmup({ ready: true });
  assert.equal(warmSignal.aborted, true); assert.equal(f.provider.leases, 0); assert.equal(recording.active, false);
  await assert.rejects(recording.finish({ ...next, audio: Uint8Array.from([1]), mimeType: 'audio/webm' }), /已结束/);
});
