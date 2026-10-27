import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import recording from '../src/speech/recording-test.cjs';
import permissions from '../src/speech/microphone-permission.cjs';

function provider() {
  return { runtime: {}, leases: 0, probe: async () => {}, status: () => ({ busy: false }),
    retain() { this.leases++; }, release() { this.leases--; },
    transcribeRecording: async ({ audio, signal }) => { signal.throwIfAborted(); assert.equal(audio.readUInt32BE(), 0x1a45dfa3); return '中文 English'; } };
}
test('microphone test authorizes one recording, transcribes it locally and releases its engine lease', async () => {
  const p = provider(), service = new recording.RecordingTest({ provider: p });
  const session = await service.start(); assert.equal(service.active, true); assert.equal(p.leases, 1);
  const result = await service.finish({ ...session, audio: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), mimeType: 'audio/webm;codecs=opus' });
  assert.equal(result.text, '中文 English'); assert.equal(service.active, false); assert.equal(p.leases, 0);
  await assert.rejects(service.finish({ ...session, audio: new Uint8Array(4), mimeType: 'audio/webm' }), /已结束/);
});
test('recording cancellation and invalid identifiers cannot submit another recording', async () => {
  const p = provider(), service = new recording.RecordingTest({ provider: p });
  const session = await service.start();
  await assert.rejects(service.finish({ recordingId: 'foreign', audio: new Uint8Array(4), mimeType: 'audio/webm' }), /已结束/);
  assert.equal(service.active, true); service.cancel(session.recordingId); assert.equal(p.leases, 0); assert.equal(service.active, false);
});
test('microphone permission is limited to the active test in the exact configuration main window', () => {
  const url = 'file:///project/settings/index.html', expected = { getURL: () => url };
  const args = { contents: expected, expected, url, permission: 'media', active: true, details: { mediaTypes: ['audio'], requestingUrl: url, isMainFrame: true } };
  assert.equal(permissions.microphonePermission(args), true);
  assert.equal(permissions.microphonePermission({ ...args, details: { mediaType: 'audio' } }), true);
  for (const value of [{ active: false }, { contents: { getURL: () => url } }, { permission: 'display-capture' },
    { details: { mediaTypes: ['video'] } }, { details: { mediaTypes: ['audio', 'video'] } },
    { details: { mediaType: 'audio', isMainFrame: false } }, { details: { mediaType: 'audio', requestingUrl: 'https://example.com' } }]) {
    assert.equal(permissions.microphonePermission({ ...args, ...value }), false);
  }
});
function renderer(t, getMedia) {
  let stops = 0, recorded = 0; const events = [], calls = [], revoked = [], blobs = [];
  const stream = { getTracks: () => [{ stop: () => stops++ }] };
  class MediaRecorder {
    constructor() { this.state = 'inactive'; recorded++; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])]) }); queueMicrotask(() => this.onstop()); }
  }
  const api = { startSpeechRecording: async () => ({ ok: true, result: { recordingId: 'test-id', maxSeconds: 60 } }),
    cancelSpeechRecording: async value => { calls.push({ type: 'cancel', ...value }); return { ok: true }; },
    finishSpeechRecording: async value => { calls.push({ type: 'finish', ...value }); return { ok: true, result: { text: 'real test transcript', elapsedMs: 5 } }; } };
  const context = { window: {}, navigator: { mediaDevices: { getUserMedia: getMedia || (async constraints => { assert.equal(constraints.video, false); return stream; }) } },
    URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:local-test-' + blobs.length; }, revokeObjectURL(url) { revoked.push(url); } },
    MediaRecorder, Blob, Uint8Array, Date, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask };
  vm.runInNewContext(fs.readFileSync(new URL('../src/settings/speech-recorder.js', import.meta.url), 'utf8'), context);
  const recorder = new context.window.SpeechRecorder(api, value => events.push(value)); t.after(() => { recorder.clearPlayback(); return recorder.cancel(); });
  return { recorder, events, calls, stream, blobs, revoked, stops: () => stops, recorded: () => recorded };
}
test('configuration recording captures the microphone directly and stops every track before local transcription', async t => {
  const f = renderer(t); await f.recorder.start(); assert.equal(f.recorder.state, 'recording');
  f.recorder.stop(); await delay(10);
  assert.ok(f.stops() > 0); assert.equal(f.calls.filter(c => c.type === 'finish').length, 1);
  assert.equal(f.events.find(e => e.state === 'complete').result.text, 'real test transcript'); assert.equal(f.recorder.state, 'idle');
});
test('late microphone permission after cancellation cannot start a hidden recording', async t => {
  let release; const f = renderer(t, () => new Promise(resolve => { release = resolve; }));
  const starting = f.recorder.start(); await delay(0); await f.recorder.cancel(); release(f.stream); await starting;
  assert.equal(f.recorded(), 0); assert.equal(f.stops(), 1); assert.equal(f.calls.some(c => c.type === 'finish'), false);
});

test('test audio can be replayed locally, is not sent as a URL, and is released before the next recording', async t => {
  const f = renderer(t); await f.recorder.start(); f.recorder.stop(); await delay(10);
  assert.equal(f.blobs.length, 1); assert.match(f.events.find(e => e.state === 'complete').playbackUrl, /^blob:local-test-/);
  assert.ok(!JSON.stringify(f.calls).includes('blob:'));
  assert.equal(f.revoked.length, 0, 'Finishing keeps a replay of this test in window memory');
  await f.recorder.start(); assert.deepEqual(f.revoked, ['blob:local-test-1']);
});
