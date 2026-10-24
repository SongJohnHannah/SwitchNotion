import test from 'node:test';
import assert from 'node:assert/strict';
import audio from '../src/meeting-audio.cjs';
import speech from '../src/speech-provider.cjs';
import settings from '../src/speech/settings.cjs';
import fs from 'node:fs';
import path from 'node:path';

const blockId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', spaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('all native recording segments preserve requested language and bounded reliable context, separately for each audio source', async () => {
  const calls = []; let id = 0;
  const provider = { async transcribe({ ...args }) { calls.push(args); return 'previous meeting sentence'; },
    async transcribeDetailed(args) { calls.push(args); return { text: 'previous meeting sentence', context: 'previous meeting sentence' }; } };
  const session = new audio.MeetingAudioSession({ provider, emit() {} });
  const send = (method, input = {}) => session.handle({ type: '/api/v1/' + method, requestId: String(++id), ...input });
  await send('transcriptionInfo', { rootBlockId: blockId, spaceId });
  const voiced = Buffer.alloc(16000 * 4); for (let at = 0; at < voiced.length; at += 4) voiced.writeFloatLE(.1, at);
  const silence = Buffer.alloc(voiced.length);
  const segment = async (source, language) => {
    for (let n = 0; n < 4; n++) await send('audioData', { blockId, spaceId, language, audioSource: source, base64Audio: voiced.toString('base64') });
    await send('audioData', { blockId, spaceId, language, audioSource: source, base64Audio: silence.toString('base64') });
    await session.jobs;
  };
  await segment('microphone', 'zh-CN');
  await segment('microphone', 'en-US');
  await segment('system_audio', 'auto');
  assert.equal(calls[0].language, 'zh');
  assert.equal(calls[1].language, 'en');
  assert.equal(calls[0].context, '');
  assert.equal(calls[1].context, 'previous meeting sentence');
  assert.equal(calls[2].context, '', 'System audio must not inherit microphone text');
  await send('drainTranscription'); session.close();
});

test('configuration switches the actual recognition model and restores the previous model if preparation fails', async t => {
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-speech-quality-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const runtime = model => ({ pythonExecutable: path.join(root, 'python.exe'), modelDirectory: path.join(root, model), model,
    platform: 'win32', architecture: 'x64', device: 'cuda', computeType: 'float16' });
  const provider = new speech.SpeechProvider({ root, runtime: runtime('medium'), discoverImpl: async (_root, { platform }) => runtime(platform.profile.model) });
  provider.probe = async () => provider.status();
  const service = new settings.SpeechSettings({ root, provider, runtimeExists: () => true });
  assert.equal((await service.request('speech.save', { enabled: true, model: 'large-v3-turbo' })).ok, true);
  assert.equal(provider.status().model, 'large-v3-turbo');
  assert.equal(JSON.parse(fs.readFileSync(service.file)).runtime.model, 'large-v3-turbo');
  assert.match(service.status().modelName, /Turbo/);
  provider.probe = async () => { throw Error('fixture preparation failed'); };
  assert.equal((await service.request('speech.save', { enabled: true, model: 'medium' })).ok, false);
  assert.equal(provider.status().model, 'large-v3-turbo');
  assert.equal(provider.runtime.model, 'large-v3-turbo');
  assert.equal(JSON.parse(fs.readFileSync(service.file)).model, 'large-v3-turbo');
  assert.equal((await service.request('speech.save', { enabled: true, model: 'arbitrary/model' })).ok, false);
  provider.close();
});
