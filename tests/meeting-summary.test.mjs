import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MeetingSummaryService, summaryInput } from '../src/meeting-summary.cjs';
import { meetingFixture, ids } from './helpers/native-meeting.mjs';
const service = f => new MeetingSummaryService({ root: f.root, provider: f.provider, storeFactory: () => f.store });
const events = async response => (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const info = f => summaryInput('runMeetingNotesAgent', f.input);

test('summary writes only new summary blocks and its native pointer, reads them back, and sends the model data without tools or session headers', async t => {
  const f = meetingFixture(t), s = service(f), before = structuredClone(f.records.get(ids.transcriptText));
  const result = await s.run(info(f), new AbortController().signal);
  assert.equal(result.ok, true); assert.equal(f.writes().length, 1); assert.deepEqual(f.records.get(ids.transcriptText), before);
  const payload = f.writes()[0].payload;
  assert.equal(payload.transactions[0].spaceId, ids.space);
  assert.equal(payload.transactions[0].inSudoMode, undefined);
  assert.ok(f.calls.filter(c => c.endpoint === 'getRecordValues').every(c => c.payload.requests.every(p => p.spaceId === ids.space)), 'New record IDs also require the explicit workspace');
  assert.ok(payload.transactions[0].operations.every(o => o.pointer.spaceId === ids.space));
  assert.equal(f.generations[0].tools, undefined);
  assert.ok(!JSON.stringify(f.generations[0].messages).includes(ids.user));
  assert.match(JSON.stringify(f.generations[0].messages), /recorded story/);
  assert.equal(JSON.parse(fs.readFileSync(s.file)).jobs[0].status, 'verified');
  assert.ok(result.recordMap.block[ids.summary].value.value.content.length > 0);
});

test('an explicitly rejected transaction can reuse its prepared draft after correction without another model generation', async t => {
  const f = meetingFixture(t), s = service(f); f.setWriteBehavior('validation-error');
  await assert.rejects(s.run(info(f), new AbortController().signal), /schema rejection/);
  assert.equal(s.status().uncertain, 0);
  f.setWriteBehavior('ok');
  assert.equal((await s.run(info(f), new AbortController().signal)).ok, true);
  assert.equal(f.generations.length, 1);
});

test('duplicate summary requests are serialized and remain idempotent after restarting the adapter', async t => {
  const f = meetingFixture(t), s = service(f), input = info(f), signal = new AbortController().signal;
  const results = await Promise.all([s.run(input, signal), s.run(input, signal)]);
  assert.equal(results[1].reused, true); assert.equal(f.generations.length, 1); assert.equal(f.writes().length, 1);
  assert.equal((await service(f).run(input, signal)).reused, true); assert.equal(f.writes().length, 1);
});

test('a lost write response is reconciled by server records instead of replaying the transaction', async t => {
  const f = meetingFixture(t); f.setWriteBehavior('after-commit-error');
  assert.equal((await service(f).run(info(f), new AbortController().signal)).ok, true);
  assert.equal(f.writes().length, 1);
});

test('an unconfirmed write prevents a new summary transaction and never reports a fabricated completion', async t => {
  const f = meetingFixture(t), s = service(f); f.setWriteBehavior('before-commit-error');
  await assert.rejects(s.run(info(f), new AbortController().signal), /尚未确认/);
  await assert.rejects(s.run({ ...info(f), tabId: '99999999-9999-4999-8999-999999999999' }, new AbortController().signal), /此前会议/);
  assert.equal(f.writes().length, 1); assert.equal(f.generations.length, 1);
  assert.equal(f.records.get(ids.meeting).format.transcription_summary_id, undefined);
});

test('model failure, read-only permission, changed source and cancellation preserve the notes and transcript', async t => {
  for (const failure of ['model', 'permission', 'changed', 'cancel']) {
    const f = meetingFixture(t), abort = new AbortController();
    if (failure === 'permission') f.setRole('reader');
    f.provider.generate = async function* () {
      if (failure === 'model') throw Error('fixture private upstream error');
      if (failure === 'changed') f.records.get(ids.transcriptText).properties.title[0][0] = 'A newer recording segment arrived.';
      if (failure === 'cancel') abort.abort();
      yield '# Summary\nSome content';
    };
    const s = service(f);
    await assert.rejects(s.run(info(f), abort.signal));
    assert.equal(f.writes().length, 0); assert.equal(f.records.get(ids.notes).content[0], ids.noteText);
  }
});

test('legacy summary requests use the same generator and failures are explicit stream errors, not empty success', async t => {
  const f = meetingFixture(t), s = service(f), input = { spaceId: ids.space, transcript: [{ type: 'config', value: {
    type: 'summarize-transcript', transcriptPointer: { id: ids.meeting, spaceId: ids.space }, summaryTabId: ids.summary
  } }] };
  const result = await events(s.handle('runInferenceTranscript', input));
  assert.ok(result.some(e => e.type === 'record-map')); assert.ok(result.some(e => e.status === 'completed' && e.verified));
  const invalid = await events(s.handle('runMeetingNotesAgent', { ...f.input, spaceId: 'invalid' }));
  assert.ok(invalid.some(e => e.type === 'error')); assert.equal(invalid.some(e => e.status === 'completed'), false);
});
