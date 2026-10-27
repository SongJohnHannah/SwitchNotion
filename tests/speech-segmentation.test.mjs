import test from 'node:test';
import assert from 'node:assert/strict';
import { MeetingAudioSession } from '../src/meeting-audio.cjs';

const blockId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', spaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function voice(seconds, level = .1) {
  const pcm = Buffer.alloc(Math.round(seconds * 16000) * 4);
  for (let at = 0; at < pcm.length; at += 4) pcm.writeFloatLE(level, at);
  return pcm;
}
async function record(t, sources, packetSizes, language = 'auto') {
  const calls = [], events = []; let id = 0;
  const session = new MeetingAudioSession({ emit: event => events.push(event),
    provider: { async transcribeDetailed(args) { calls.push(args); return { text: '', context: '' }; } } });
  t.after(() => session.close());
  const send = (method, input = {}) => session.handle({ type: '/api/v1/' + method, requestId: String(++id), ...input });
  await send('transcriptionInfo', { rootBlockId: blockId, spaceId });
  const length = Math.max(...Object.values(sources).map(pcm => pcm.length));
  let at = 0, packet = 0;
  while (at < length) {
    const end = at + packetSizes[packet++ % packetSizes.length];
    for (const [audioSource, pcm] of Object.entries(sources)) if (at < pcm.length) {
      await send('audioData', { blockId, spaceId, audioSource, language,
        base64Audio: pcm.subarray(at, Math.min(end, pcm.length)).toString('base64') });
    }
    at = end;
  }
  await send('drainTranscription');
  return { calls, events };
}

test('a pause between languages is detected independently of transport packet sizes without losing a sample', async t => {
  const pcm = Buffer.concat([voice(5), voice(1, 0), voice(6.137)]);
  for (const sizes of [[128000], [6400], [4, 128000, 1316, 47996]]) await t.test(sizes.join(','), async () => {
    const { calls } = await record(t, { microphone: pcm }, sizes);
    assert.deepEqual(calls.map(c => c.pcm.length), [5.8 * 64000, pcm.length - 5.8 * 64000],
      'The same 800ms pause must split the same samples even inside a large packet');
    assert.ok(Buffer.concat(calls.map(c => c.pcm)).equals(pcm));
  });
});

test('independent sources, continuous speech and short final tails preserve their exact audio offsets', async t => {
  const mic = voice(40.013), system = Buffer.concat([voice(5, .2), voice(1, 0), voice(1.017, .2)]);
  const { calls, events } = await record(t, { microphone: mic, system_audio: system }, [127996, 108, 6044]);
  for (const [source, original] of [['microphone', mic], ['system_audio', system]]) {
    const done = events.filter(e => e.audioSource === source && e.transcription?.status === 'ignore');
    assert.equal(done.reduce((sum, e) => sum + Math.round(e.transcription.audioDuration * 64000), 0), original.length);
    let offset = 0;
    for (const event of done) {
      assert.ok(Math.abs(event.segmentSortkey - offset / 64) < .001);
      offset += Math.round(event.transcription.audioDuration * 64000);
    }
    const final = events.filter(e => e.transcription?.status === 'ignore');
    const sourceCalls = calls.filter((_c, i) => final[i].audioSource === source);
    assert.ok(Buffer.concat(sourceCalls.map(c => c.pcm)).equals(original));
    assert.ok(done.every(e => e.transcription.audioDuration <= 20));
  }
});

test('native UI language preference cannot lock bilingual dictation to a single language', async t => {
  for (const language of ['zh-CN', 'en-US', 'auto']) {
    const { calls } = await record(t, { microphone: voice(2) }, [64000], language);
    assert.equal(calls[0].language, 'auto');
  }
});
