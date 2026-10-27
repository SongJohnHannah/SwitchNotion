import test from 'node:test';
import assert from 'node:assert/strict';
import audio from '../src/meeting-audio.cjs';

const blockId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const spaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const voiced = Buffer.alloc(16000 * 4 * 2);
for (let at = 0; at < voiced.length; at += 4) voiced.writeFloatLE(.1, at);

test('slow recognition preserves every accepted audio sample through stopping', async t => {
  const calls = [], events = []; let release;
  const ready = new Promise(resolve => { release = resolve; });
  const provider = { async transcribe({ pcm }) { await ready; calls.push(pcm); return '真实发言'; } };
  const session = new audio.MeetingAudioSession({ provider, emit: event => events.push(event) });
  t.after(() => session.close());
  let id = 0;
  const send = (method, input = {}) => session.handle({ type: '/api/v1/' + method, requestId: String(++id), ...input });
  await send('transcriptionInfo', { rootBlockId: blockId, spaceId });
  let accepted = 0; const rejected = [];
  for (let n = 0; n < 80; n++) {
    try {
      await send('audioData', { blockId, spaceId, base64Audio: voiced.toString('base64') });
      accepted += voiced.length;
    } catch (error) { rejected.push(error.message); }
  }
  release();
  await send('drainTranscription');
  assert.equal(rejected.length, 0, 'Ordinary recording must not lose later speech while recognition catches up');
  assert.equal(calls.reduce((sum, pcm) => sum + pcm.length, 0), accepted,
    'Every audio sample acknowledged to the native recorder must reach recognition');
  assert.equal(events.filter(event => event.transcription?.status === 'complete').reduce((sum, event) => sum + event.transcription.audioDuration, 0), 160);
});

test('overload rejects only the new frame and stopping still transcribes all previously acknowledged audio', async t => {
  let release; const ready = new Promise(resolve => { release = resolve; });
  let processed = 0, id = 0, accepted = 0;
  const session = new audio.MeetingAudioSession({ provider: { async transcribe({ pcm }) { await ready; processed += pcm.length; return '真实发言'; } }, emit() {} });
  t.after(() => session.close());
  const send = (method, input = {}) => session.handle({ type: '/api/v1/' + method, requestId: String(++id), ...input });
  await send('transcriptionInfo', { rootBlockId: blockId, spaceId });
  let rejected = 0;
  for (let n = 0; n < 310; n++) {
    try { await send('audioData', { blockId, spaceId, base64Audio: voiced.toString('base64') }); accepted += voiced.length; }
    catch (error) { assert.match(error.message, /积压/); rejected++; }
  }
  release(); await send('drainTranscription');
  assert.equal(rejected, 10); assert.equal(accepted, 600 * 16000 * 4); assert.equal(processed, accepted);
});
