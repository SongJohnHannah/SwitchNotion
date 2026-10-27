import test from 'node:test';
import assert from 'node:assert/strict';
import { MeetingSummaryService, summaryInput } from '../src/meeting-summary.cjs';
import { NativeMeetingStore } from '../src/meeting-summary-store.cjs';
import { meetingFixture, ids } from './helpers/native-meeting.mjs';

const page = '33333333-3333-4333-8333-333333333333';
const selection = { page_id: page, space_id: ids.space };
const service = f => new MeetingSummaryService({ root: f.root, provider: f.provider, storeFactory: () => f.store });
function addTemplate(f, text = '按候选人的经历、能力证据和待确认问题整理，不编造评价。') {
  f.records.set(page, { id: page, space_id: ids.space, type: 'page', alive: true, properties: { title: [[text]] } });
  return text;
}
function request(f, endpoint, template) {
  return summaryInput(endpoint, endpoint === 'runMeetingNotesAgent' ? { ...f.input, summaryTemplateSelection: template } : {
    spaceId: ids.space, transcript: [{ type: 'config', value: { type: 'summarize-transcript',
      transcriptPointer: { id: ids.meeting, spaceId: ids.space }, summaryTabId: ids.summary, summaryTemplateSelection: template } }]
  });
}

for (const endpoint of ['runMeetingNotesAgent', 'runInferenceTranscript']) {
  test(`${endpoint}: preset/custom instructions reach the model separately from transcript data`, async t => {
    const f = meetingFixture(t), text = addTemplate(f);
    await service(f).run(request(f, endpoint, selection));
    const messages = f.generations[0].messages;
    assert.equal(messages.length, 3);
    assert.ok(messages[1].content.includes(text));
    assert.ok(messages[2].content.includes('recorded story'));
    assert.ok(!messages[1].content.includes('recorded story'));
    assert.match(messages[0].content, /应当遵循/);
    assert.equal(f.writes().length, 1);
  });
  test(`${endpoint}: omitted selection uses saved instructions, explicit Auto overrides them`, async t => {
    for (const template of [undefined, 'auto']) {
      const f = meetingFixture(t), text = addTemplate(f);
      f.records.get(ids.meeting).format.transcription_summary_template_selection = selection;
      await service(f).run(request(f, endpoint, template));
      assert.equal(f.generations[0].messages.some(message => message.content.includes(text)), template === undefined);
    }
  });
}

test('cross-workspace preset reads retain account access checks and never change the meeting write scope', async () => {
  const other = '44444444-4444-4444-8444-444444444444';
  const calls = [];
  const api = async (endpoint, payload, options) => {
    calls.push({ endpoint, payload, options });
    return { results: [{ role: 'reader', value: { id: page, space_id: other, type: 'page', properties: { title: [['客户会议：需求、决定和后续安排']] } } }] };
  };
  const store = new NativeMeetingStore({ api, spaceId: ids.space, userId: ids.user });
  assert.match((await store.template({ page_id: page, space_id: other })).text, /客户会议/);
  assert.equal(store.spaceId, ids.space);
  assert.equal(calls[0].payload.requests[0].spaceId, other);
  assert.equal(calls[0].options.spaceId, other);
  store.api = async () => ({ results: [] });
  await assert.rejects(store.template({ page_id: page, space_id: other }), /不完整/);
});

test('missing, empty, oversized and invalid instructions fail before model generation or page writes', async t => {
  for (const kind of ['missing', 'empty', 'long', 'invalid']) {
    const f = meetingFixture(t);
    if (kind !== 'missing') addTemplate(f, kind === 'long' ? 'x'.repeat(12001) : '');
    await assert.rejects(async () => service(f).run(request(f, 'runMeetingNotesAgent', kind === 'invalid' ? 'interview' : selection)));
    assert.equal(f.generations.length, 0);
    assert.equal(f.writes().length, 0);
  }
});

test('template edits invalidate an existing summary request instead of silently reusing its old output', async t => {
  const f = meetingFixture(t), s = service(f);
  addTemplate(f); const info = request(f, 'runMeetingNotesAgent', selection);
  await s.run(info);
  addTemplate(f, '改为只整理客户的需求和下一步。');
  await assert.rejects(s.run(info), /摘要指令已经变化/);
  assert.equal(f.generations.length, 1);
  assert.equal(f.writes().length, 1);
});

test('editing instructions during generation prevents stale summary writes', async t => {
  const f = meetingFixture(t); addTemplate(f);
  f.provider.generate = async function* () { addTemplate(f, '新的指令'); yield '# 摘要\n原指令生成的内容'; };
  await assert.rejects(service(f).run(request(f, 'runMeetingNotesAgent', selection)), /指令在生成期间发生变化/);
  assert.equal(f.writes().length, 0);
});
