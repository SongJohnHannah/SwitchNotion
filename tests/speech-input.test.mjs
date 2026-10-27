import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import audio from '../src/meeting-audio.cjs';
import settings from '../src/speech/settings.cjs';
import compatibility from '../src/client-compat.cjs';

const blockId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', spaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const pcm = Buffer.alloc(16000 * 4);
for (let at = 0; at < pcm.length; at += 4) pcm.writeFloatLE(.1, at);
async function fixture(inputMode) {
  const calls = [], events = [];
  const session = new audio.MeetingAudioSession({ inputMode, emit: event => events.push(event),
    provider: { async transcribe({ pcm }) { calls.push(pcm); return 'This is computer playback, not the user speaking.'; } } });
  let id = 0;
  const send = (method, input = {}) => session.handle({ type: '/api/v1/' + method, requestId: String(++id), ...input });
  await send('transcriptionInfo', { rootBlockId: blockId, spaceId });
  return { session, calls, events, send };
}

test('microphone-only dictation never turns computer playback into words the user did not say', async t => {
  const f = await fixture('microphone'); t.after(() => f.session.close());
  await f.send('audioData', { blockId, spaceId, audioSource: 'system_audio', base64Audio: pcm.toString('base64') });
  await f.send('drainTranscription');
  assert.equal(f.calls.length, 0, 'Computer playback must not reach ASR in microphone-only mode');
  assert.equal(f.events.some(event => event.transcription?.status === 'complete'), false);
});

test('microphone-only mode still transcribes real microphone frames and legacy untagged microphone frames', async t => {
  const f = await fixture('microphone'); t.after(() => f.session.close());
  await f.send('audioData', { blockId, spaceId, base64Audio: pcm.toString('base64') });
  await f.send('audioData', { blockId, spaceId, audioSource: 'microphone', base64Audio: pcm.toString('base64') });
  await f.send('drainTranscription');
  assert.equal(f.calls.reduce((sum, bytes) => sum + bytes.length, 0), pcm.length * 2);
});

test('meeting mode continues to keep microphone and system audio in separate transcripts', async t => {
  const f = await fixture('meeting'); t.after(() => f.session.close());
  for (const audioSource of ['microphone', 'system_audio']) await f.send('audioData', { blockId, spaceId, audioSource, base64Audio: pcm.toString('base64') });
  await f.send('drainTranscription');
  assert.deepEqual(f.events.filter(event => event.transcription?.status === 'complete').map(event => event.audioSource), ['microphone', 'system_audio']);
});

test('system audio is enabled by default, can be turned off in settings, and survives reopening', async t => {
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-speech-input-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const provider = { runtime: {}, leases: 0, status: () => ({ model: 'medium' }) };
  const service = new settings.SpeechSettings({ root, provider }); service.native = { lifecycleReady: true, status: () => ({ available: true }) };
  assert.equal(service.status().inputMode, 'meeting');
  assert.equal((await service.request('speech.save', { enabled: true, inputMode: 'microphone' })).ok, true);
  assert.equal(service.native.lifecycleReady, false, 'Capture must be reloaded before claiming microphone-only mode');
  assert.equal(new settings.SpeechSettings({ root, provider }).status().inputMode, 'microphone');
  assert.equal((await service.request('speech.save', { enabled: true, inputMode: 'meeting' })).ok, true);
  assert.equal(new settings.SpeechSettings({ root, provider }).status().inputMode, 'meeting');
  const saved = fs.readFileSync(service.file, 'utf8');
  assert.equal((await service.request('speech.save', { enabled: true, inputMode: 'invalid' })).ok, false);
  assert.equal(fs.readFileSync(service.file, 'utf8'), saved);
  provider.leases = 1;
  assert.equal((await service.request('speech.save', { enabled: true, inputMode: 'microphone' })).ok, false);
});

test('verified native capture disables system audio before mixing when the configuration switch is off', async t => {
  const name = '89269-f5f20fe25f8eec19.js', file = path.resolve('research/.public-assets', name);
  if (!fs.existsSync(file)) return t.skip('Official native capture fixture unavailable');
  const original = fs.readFileSync(file, 'utf8');
  const capture = async source => {
    const start = source.indexOf('static async getDictationAudioRecorder(e){');
    const end = source.indexOf('static generateOnDataReceivedForEnvironmentAndBlockStore', start);
    assert.ok(start >= 0 && end > start);
    let actual;
    const module = id => id === 136768 ? { Xq: () => false } : id === 392719 ? { wr: async () => ({}) }
      : id === 548087 ? { AudioRecorder: class { constructor(options) { actual = options; } } } : {};
    const Probe = vm.runInNewContext('class Probe{' + source.slice(start, end) + '};Probe', { i: module, y: () => ({ Ay: { state: {} } }) });
    await Probe.getDictationAudioRecorder({ includeSystemAudio: false, blockStore: { isMeetingNoteBlock: () => true }, environment: { device: { isWindows: true, isElectron: true } } });
    return actual.includeSystemAudio;
  };
  const personal = compatibility.adaptClient(original, name, { localSpeechEnabled: true, inputMode: 'microphone' });
  const meeting = compatibility.adaptClient(original, name, { localSpeechEnabled: true, inputMode: 'meeting' });
  assert.equal(await capture(original), false);
  assert.equal(await capture(meeting), true);
  assert.equal(await capture(personal), false, 'Disable computer playback at the actual recorder boundary, not only after a mixed frame arrives');
  new vm.Script(personal); new vm.Script(meeting);
});
