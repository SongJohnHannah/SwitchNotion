import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { InlineRecords } = require('../src/inline-records.cjs');
const { localRecords } = require('../src/local-records.cjs');
const SPACE = '11111111-1111-4111-8111-111111111111', THREAD = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333', OUT = '44444444-4444-4444-8444-444444444444';
const input = { threadId: THREAD, spaceId: SPACE, transcript: [
  { id: '55555555-5555-4555-8555-555555555555', type: 'config', value: { type: 'workflow', writerMode: true } },
  { id: '66666666-6666-4666-8666-666666666666', type: 'context', value: { blockId: SPACE, userEmail: 'private@example.test', clientRenderedPages: { hidden: 'full page content' } } },
  { id: USER, type: 'user', value: [['只读解释']] }
] };
const output = { id: OUT, type: 'agent-inference', traceId: THREAD, value: [{ type: 'text', content: '合成预览' }], finishedAt: Date.now() };

test('inline preview survives native temporary-step cleanup and local record reload without storing account profiles', async t => {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-inline-records-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'inline.json'), records = new InlineRecords(file);
  records.snapshot(input, null, 'running', USER);
  const frame = records.snapshot(input, output, 'completed', USER);
  assert.equal(frame.recordMap.thread[THREAD].value.value.last_turn_outcome.final_step_id, OUT);
  const restored = new InlineRecords(file);
  assert.equal(restored.record(THREAD).messages.length, 4);
  assert.deepEqual(restored.record(OUT, 'thread_message').step, output);
  assert.equal(fs.readFileSync(file, 'utf8').includes('private@example.test'), false);
  assert.equal(fs.readFileSync(file, 'utf8').includes('full page content'), false);
  let upstream = 0;
  const data = { requests: [{ pointer: { table: 'thread', id: THREAD } }, { pointer: { table: 'thread_message', id: OUT } }] };
  const request = new Request('https://app.notion.com/api/v3/syncRecordValues', { method: 'POST', headers: { 'x-notion-active-user-header': USER }, body: JSON.stringify(data) });
  const response = await localRecords(request, data, 'syncRecordValues', restored, () => { upstream++; throw Error('must not request synthetic records from Notion'); }, () => {});
  const payload = await response.json();
  assert.equal(payload.recordMap.thread_message[OUT].value.value.step.value[0].content, '合成预览');
  assert.equal(upstream, 0);
});

test('local inline records cannot be reused in another workspace', () => {
  const records = new InlineRecords(); records.snapshot(input, output, 'completed');
  assert.throws(() => records.snapshot({ ...input, spaceId: '77777777-7777-4777-8777-777777777777' }, output, 'completed'), /工作区不匹配/);
});

test('research draft storage preserves audited source config and partial output, and clears running leases after restart', t => {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-research-records-中文 空格-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, '研究记录.json'), records = new InlineRecords(file), research = structuredClone(input);
  research.transcript[0].value = { type: 'workflow', isAgentResearchRequest: true, searchScopes: [{ type: 'page', pageId: SPACE }], useWebSearch: false, privateFlag: 'must-not-store' };
  records.snapshot(research, output, 'running', USER, { source: 'researcher' });
  assert.ok(records.record(THREAD).current_inference_lease_expiration > Date.now());
  const restored = new InlineRecords(file), thread = restored.record(THREAD, 'thread', { userId: USER, spaceId: SPACE });
  assert.equal(thread.created_source, 'researcher'); assert.equal(thread.data.notion_switch_research.status, 'interrupted'); assert.equal(thread.active_inference_lease, undefined);
  assert.equal(thread.current_inference_id, undefined); assert.equal(thread.current_inference_lease_expiration, 0);
  assert.equal(restored.record(OUT, 'thread_message').step.value[0].content, '合成预览');
  assert.equal(restored.record(THREAD, 'thread', { userId: OUT, spaceId: SPACE }), undefined);
  assert.equal(restored.researchThreads().size, 1);
  const saved = fs.readFileSync(file, 'utf8'); assert.ok(!saved.includes('private@example.test')); assert.ok(!saved.includes('must-not-store'));
  const step = restored.record(research.transcript[0].id, 'thread_message').step;
  assert.deepEqual(step.value, { type: 'workflow', isAgentResearchRequest: true, useWebSearch: false, searchScopes: [{ type: 'page', pageId: SPACE }] });
});

test('research snapshot rejects a writer thread collision before changing existing messages or source', () => {
  const records = new InlineRecords(); records.snapshot(input, output, 'completed', USER);
  const before = JSON.stringify([...records.threads, ...records.messages]);
  assert.throws(() => records.snapshot(input, output, 'running', USER, { source: 'researcher' }), /类型不匹配/);
  assert.equal(JSON.stringify([...records.threads, ...records.messages]), before); assert.equal(records.researchThreads().size, 0);
});

test('research retry stores the supplied visible transcript and does not restore deleted messages from older snapshots', () => {
  const records = new InlineRecords(), research = structuredClone(input);
  research.transcript[0].value = { type: 'researcher', searchScope: { type: 'notion' }, useWebSearch: false };
  records.snapshot(research, output, 'completed', USER, { source: 'researcher' });
  const generated = { ...output, id: '77777777-7777-4777-8777-777777777777' };
  records.snapshot(research, generated, 'completed', USER, { source: 'researcher' });
  assert.ok(!records.record(THREAD).messages.includes(OUT)); assert.ok(records.record(THREAD).messages.includes(generated.id));
  assert.equal(records.record(THREAD).last_turn_outcome.final_step_id, generated.id);
});
