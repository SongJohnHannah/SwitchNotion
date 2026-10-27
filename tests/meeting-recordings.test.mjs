import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MeetingRecordings } from '../src/meeting-recordings.cjs';
import { RecordingCapture } from '../src/meeting-recording-capture.cjs';
import { MeetingAudioSession } from '../src/meeting-audio.cjs';
import { SpeechSettings } from '../src/speech/settings.cjs';
import { uploadAudio, fileUrl, targetFor } from '../src/meeting-recording-store.cjs';
import { meetingFixture, ids } from './helpers/native-meeting.mjs';
const PAGE = '33333333-3333-4333-8333-333333333333';
const FILE = '44444444-4444-4444-8444-444444444444';
const durable = `https://prod-files-secure.s3.us-west-2.amazonaws.com/${ids.space}/${FILE}/recording.mp3`;
function fixture(t, options = {}) {
  const f = meetingFixture(t), uploads = [], signed = [];
  f.records.set(PAGE, { id: PAGE, type: 'page', space_id: ids.space, alive: true, content: [ids.meeting], parent_table: 'space', parent_id: ids.space });
  const api = f.store.api;
  f.store.api = async (endpoint, payload, opts) => {
    if (endpoint === 'getUploadSpaceFileUrl') { signed.push(payload); return { type: 'PUT', url: durable, signedPutUrl: 'https://fixture.s3.us-west-2.amazonaws.com/upload?signature=fixture', putHeaders: [] }; }
    return api(endpoint, payload, opts);
  };
  f.store.uploadFetch = async (url, args) => { uploads.push({ url, args }); return new Response('', { status: 200 }); };
  const encode = async ({ directory }) => {
    const filename = 'audio-001.mp3', data = Buffer.from('fixture-encoded-audio');
    assert.ok(fs.existsSync(path.join(directory, 'microphone.pcm')));
    fs.writeFileSync(path.join(directory, filename), data);
    return [{ filename, samples: 160, bytes: data.length }];
  };
  const service = new MeetingRecordings({ root: f.root, provider: {}, storeFactory: async () => f.store, encode, ...options });
  t.after(() => service.close());
  return { ...f, service, uploads, signed, begin: () => service.begin({ blockId: ids.meeting, spaceId: ids.space, userId: ids.user }) };
}
function pcm(samples = 8000) { const data = Buffer.alloc(samples * 4); for (let at = 0; at < data.length; at += 4) data.writeFloatLE(.1, at); return data; }
test('meeting recording uploads once, reads back a playable audio block, and removes private PCM only after verification', async t => {
  const f = fixture(t), capture = f.begin();
  capture.write({ source: 'microphone', pcm: pcm() });
  await capture.finish(); await capture.finish();
  assert.equal(f.service.status().saved, 1); assert.equal(f.writes().length, 1); assert.equal(f.uploads.length, 1);
  const audio = [...f.records.values()].find(v => v.type === 'audio');
  assert.equal(audio.parent_id, PAGE); assert.equal(audio.properties.source[0][0], durable);
  assert.deepEqual(audio.file_ids, [FILE]); assert.ok(f.records.get(PAGE).content.includes(audio.id));
  assert.deepEqual(f.signed[0].record, { table: 'block', id: PAGE, spaceId: ids.space });
  assert.equal(fs.readdirSync(f.service.directory).length, 0);
  const journal = fs.readFileSync(f.service.file, 'utf8');
  assert.ok(!journal.includes('signature=')); assert.ok(!journal.includes('fixture-encoded-audio'));
  await f.service.retry(); assert.equal(f.writes().length, 1);
});
test('a lost transaction response is read back without duplicate blocks or uploads', async t => {
  const f = fixture(t); f.setWriteBehavior('after-commit-error');
  const c = f.begin(); c.write({ source: 'microphone', pcm: pcm() }); await c.finish();
  assert.equal(f.service.status().saved, 1); assert.equal(f.writes().length, 1);
  await f.service.retry(); assert.equal(f.writes().length, 1); assert.equal(f.uploads.length, 1);
});
test('unknown writes keep audio and retry by verification only, while explicit rejections allow a safe retry', async t => {
  const f = fixture(t); f.setWriteBehavior('before-commit-error');
  const c = f.begin(); c.write({ source: 'microphone', pcm: pcm() }); await c.finish();
  assert.equal(f.service.status().failed, 1); assert.equal(f.writes().length, 1);
  assert.equal(fs.readdirSync(f.service.directory).length, 1);
  f.setWriteBehavior('ok'); await f.service.retry(); assert.equal(f.writes().length, 1);
  const g = fixture(t); g.setWriteBehavior('validation-error');
  const d = g.begin(); d.write({ source: 'microphone', pcm: pcm() }); await d.finish();
  g.setWriteBehavior('ok'); await g.service.retry(); assert.equal(g.service.status().saved, 1);
  assert.equal(g.writes().length, 2); assert.equal(g.uploads.length, 1);
});
test('upload failure leaves no blank blocks and can resume after app restart', async t => {
  const f = fixture(t); f.store.uploadFetch = async () => { throw Error('Fixture network failure'); };
  const c = f.begin(); c.write({ source: 'microphone', pcm: pcm() }); await c.finish();
  assert.equal(f.writes().length, 0); assert.equal(f.service.status().failed, 1); f.service.close();
  f.store.uploadFetch = async () => new Response('');
  const next = new MeetingRecordings({ root: f.root, provider: {}, storeFactory: async () => f.store }); t.after(() => next.close());
  await next.retry(); assert.equal(next.status().saved, 1); assert.equal(f.writes().length, 1);
});
test('disabled imports do not create a directory and page moves cannot redirect an existing recording', async t => {
  const f = fixture(t, { enabled: () => false }); assert.equal(f.begin(), null); assert.equal(fs.existsSync(f.service.directory), false);
  const g = fixture(t), c = g.begin(); await delay(5);
  const other = '55555555-5555-4555-8555-555555555555';
  g.records.set(other, { ...g.records.get(PAGE), id: other }); g.records.get(ids.meeting).parent_id = other;
  c.write({ source: 'microphone', pcm: pcm() }); await c.finish();
  assert.equal(g.writes().length, 0); assert.equal(g.uploads.length, 0); assert.equal(g.service.status().failed, 1);
});
test('interrupted audio is preserved for explicit retry, not silently uploaded', async t => {
  const f = fixture(t), c = f.begin(); c.write({ source: 'microphone', pcm: pcm() }); c.abort(); await c.finishing;
  f.service.wake(); await delay(5); assert.equal(f.uploads.length, 0);
  await f.service.retry(); assert.equal(f.service.status().saved, 1);
});
test('standalone meeting pages save into their own visible notes, not their enclosing parent page', async t => {
  const f = fixture(t); f.records.get(ids.meeting).type = 'meeting_note_page';
  const c = f.begin(); c.write({ source: 'microphone', pcm: pcm() }); await c.finish();
  assert.equal(f.service.status().saved, 1);
  const audio = [...f.records.values()].find(v => v.type === 'audio');
  assert.equal(audio.parent_id, ids.notes); assert.ok(f.records.get(ids.notes).content.includes(audio.id));
  assert.ok(!f.records.get(PAGE).content.includes(audio.id));
});
test('capture conserves all accepted bytes for each source, seals tails, and rejects late frames', async t => {
  const f = meetingFixture(t); let complete = 0;
  const c = new RecordingCapture({ directory: f.root, complete: () => complete++, failed: e => assert.fail(e.message) });
  const a = pcm(111), b = pcm(17); c.write({ source: 'microphone', pcm: a }); c.write({ source: 'system_audio', pcm: b }); c.write({ source: 'microphone', pcm: b });
  const finish = c.finish(); c.write({ source: 'microphone', pcm: a }); await finish;
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'microphone.pcm')), Buffer.concat([a, b]));
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'system_audio.pcm')), b); assert.equal(complete, 1);
});
test('recording archive receives deduplicated allowed frames and cannot delay native stop or drain', async () => {
  let finished = 0, aborted = 0; const frames = [], contexts = [];
  const session = new MeetingAudioSession({ inputMode: 'microphone', provider: { transcribe: async () => '中文 English' }, emit() {},
    recordingFactory: context => { contexts.push(context); return { write: frame => frames.push(frame), finish: () => { finished++; return new Promise(() => {}); }, abort: () => aborted++ }; } });
  const send = (method, requestId, data = {}) => session.handle({ type: '/api/v1/' + method, requestId, ...data });
  await send('transcriptionInfo', 'context', { rootBlockId: ids.meeting, spaceId: ids.space });
  const audio = { blockId: ids.meeting, spaceId: ids.space, base64Audio: pcm().toString('base64') };
  await send('audioData', 'mic', audio); await send('audioData', 'mic', audio);
  await send('audioData', 'system', { ...audio, audioSource: 'system_audio' });
  await Promise.race([send('drainTranscription', 'stop'), delay(500).then(() => assert.fail('Upload delayed recording stop'))]);
  assert.equal(frames.length, 1); assert.equal(finished, 1); assert.equal(session.drained, true);
  assert.deepEqual(contexts, [{ blockId: ids.meeting, spaceId: ids.space }]); session.close(); assert.equal(aborted, 1);
});
test('audio import setting defaults on, persists off, rejects invalid values, and is separate from summaries', async t => {
  const f = meetingFixture(t), provider = { runtime: {}, status: () => ({ model: 'medium' }), close() {} };
  const s = new SpeechSettings({ root: f.root, provider }); assert.equal(s.status().autoAttachAudio, true);
  assert.equal((await s.request('speech.save', { enabled: false, autoAttachAudio: 'false' })).ok, false);
  assert.equal((await s.request('speech.save', { enabled: false, autoAttachAudio: false })).ok, true);
  const next = new SpeechSettings({ root: f.root, provider }); assert.equal(next.autoAttachAudio, false); assert.equal(next.autoSummary, true);
});
test('uploader supports native POST fields and headers and rejects credential forwarding or foreign hosts', async t => {
  const f = fixture(t), target = await targetFor(f.store, ids.meeting), filename = `meeting-${ids.meeting}-1.mp3`;
  f.store.api = async () => ({ type: 'POST', url: durable, signedUploadPostUrl: 'https://fixture.s3.amazonaws.com/post',
    fields: { key: 'fixture-key', policy: 'fixture-policy' }, postHeaders: [{ name: 'x-amz-test', value: 'fixture' }] });
  await uploadAudio(f.store, target, filename, Buffer.from('fixture'));
  const options = f.uploads[0].args;
  assert.equal(options.headers['x-amz-test'], 'fixture'); assert.match(options.headers['content-type'], /^multipart\/form-data/);
  assert.ok(options.body.includes(Buffer.from('name="file"'))); assert.equal(options.headers.cookie, undefined); assert.equal(options.headers.authorization, undefined);
  f.store.api = async () => ({ type: 'PUT', url: durable, signedPutUrl: 'https://attacker.example/upload' });
  await assert.rejects(uploadAudio(f.store, target, filename, Buffer.from('fixture')), /地址无效/);
  assert.throws(() => fileUrl(durable + '?signature=temporary'), /长期引用/);
  assert.deepEqual(fileUrl(`attachment:${FILE}:meeting-1.mp3`), { url: `attachment:${FILE}:meeting-1.mp3`, fileId: FILE });
  assert.throws(() => fileUrl(`attachment:${FILE}:../private.mp3`), /标识无效/);
});
test('current native attachment sources and object-shaped PUT headers produce a durable playable reference', async t => {
  const f = fixture(t), target = await targetFor(f.store, ids.meeting);
  const source = `attachment:${FILE}:meeting-1.mp3`;
  f.store.api = async () => ({ type: 'PUT', url: source, signedPutUrl: 'https://fixture.s3.amazonaws.com/upload', putHeaders: { 'x-amz-checksum-crc32': 'fixture-checksum', 'content-type': 'audio/mpeg' } });
  assert.deepEqual(await uploadAudio(f.store, target, `meeting-${ids.meeting}-1.mp3`, Buffer.from('fixture')), { url: source, fileId: FILE });
  assert.equal(f.uploads[0].args.headers['x-amz-checksum-crc32'], 'fixture-checksum');
  f.store.api = async () => ({ type: 'PUT', url: source, signedPutUrl: 'https://fixture.s3.amazonaws.com/upload', putHeaders: { authorization: 'must-never-forward' } });
  await assert.rejects(uploadAudio(f.store, target, `meeting-${ids.meeting}-1.mp3`, Buffer.from('fixture')), /上传头无效/);
});
