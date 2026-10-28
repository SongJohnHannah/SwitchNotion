import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { autofillViewFixture } from './helpers/native-autofill-view.mjs';
import { autofillId } from './helpers/native-autofill.mjs';
const { autofillInput } = createRequire(import.meta.url)('../src/native-autofill-store.cjs');
const { AutofillExecutor } = createRequire(import.meta.url)('../src/native-autofill-executor.cjs');
const { NativeAutofillJobs } = createRequire(import.meta.url)('../src/native-autofill-jobs.cjs');

function runtime(t, f) {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-autofill-view-')), requests = [];
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const provider = { config: () => ({ mode: 'deepseek' }), async* generate(args) {
    requests.push(args); yield JSON.stringify({ summary: '合成摘要', category: '市场', tags: ['青色'] });
  } };
  return { root, provider, requests, store: f.createStore() };
}

test('viewFill replays the exact effective view query from its beginning and preserves server result order', async () => {
  const f = autofillViewFixture(), result = await f.createStore().load(autofillInput(f.input));
  assert.deepEqual(result.rows.map(row => row.pageId), [f.ids.second, f.ids.first]);
  assert.deepEqual(f.queries[0].loader.filter, f.snapshot.request.loader.filter);
  assert.deepEqual(f.queries[0].loader.sort, f.snapshot.request.loader.sort);
  assert.equal(f.queries[0].loader.searchQuery, '所选'); assert.equal(f.queries[0].loader.userTimeZone, 'Asia/Shanghai');
  assert.deepEqual(f.queries[0].loader.reducers, { results: { type: 'results', limit: 201, loadContentCover: false } });
  assert.ok(!f.calls.some(call => call.endpoint === 'getRecordValues' && call.payload.requests.some(pointer => pointer.id === f.ids.unselected)));
  assert.equal(f.writes().length, 0);
});

test('view scope cannot be borrowed from another database, view, workspace or account', async () => {
  for (const change of [f => { f.input.notionSwitchView.request.source.id = autofillId(99); },
    f => { f.input.notionSwitchView.request.collectionView.id = autofillId(99); },
    f => { f.input.notionSwitchView.request.source.spaceId = autofillId(99); },
    f => { f.input.notionSwitchView.request.loader.userId = autofillId(99); },
    f => { f.get('block', f.ids.parent).collection_id = autofillId(99); },
    f => { delete f.input.notionSwitchView; }]) {
    const f = autofillViewFixture(); change(f);
    await assert.rejects(async () => f.createStore().load(autofillInput(f.input)));
    assert.equal(f.queries.length, 0); assert.equal(f.writes().length, 0);
  }
});

test('incomplete, duplicate and oversized view results never become a partially filled view', async () => {
  for (const result of [
    { type: 'results', blockIds: ['invalid'], hasMore: false },
    { type: 'results', blockIds: [autofillId(6)], hasMore: true },
    { type: 'results', blockIds: [autofillId(6)] },
    { type: 'results', blockIds: [autofillId(6), autofillId(6)], hasMore: false },
    { type: 'results', blockIds: Array.from({ length: 201 }, (_, n) => autofillId(1000 + n)), hasMore: false }
  ]) {
    const f = autofillViewFixture(); f.setQuery(() => ({ result: { reducerResults: { results: result } } }));
    await assert.rejects(f.createStore().load(autofillInput(f.input)), /视图|范围|完整/); assert.equal(f.writes().length, 0);
  }
});

test('a queued view retains its original rows and never adds newly matching rows', async () => {
  const f = autofillViewFixture(), store = f.createStore(), first = await store.load(autofillInput(f.input));
  f.get('block', f.ids.unselected).properties = { title: [['所选 Z']], category: [['研发']] };
  const next = await store.load(first.info);
  assert.deepEqual(next.rows.map(row => row.pageId), [f.ids.second, f.ids.first]);
  assert.ok(!next.rows.some(row => row.pageId === f.ids.unselected));
});

test('a changed stored view or a pending row leaving the original filter stops stale writes', async () => {
  for (const change of [f => { f.view.query2 = { filter: { operator: 'or', filters: [] } }; },
    f => { f.get('block', f.ids.first).properties.category = [['市场']]; }]) {
    const f = autofillViewFixture(), store = f.createStore(), snapshot = await store.load(autofillInput(f.input));
    const row = snapshot.rows.find(row => row.pageId === f.ids.first), plan = store.plan(snapshot, row, { summary: '旧结果', category: '研发', tags: [] });
    change(f); await assert.rejects(store.submit(snapshot, plan), /视图|变化|范围/); assert.equal(f.writes().length, 0);
  }
});

test('an empty filtered view is represented as zero selected rows', async () => {
  const f = autofillViewFixture(); f.input.notionSwitchView.request.loader.searchQuery = '不匹配任何记录';
  const result = await f.createStore().load(autofillInput(f.input)); assert.deepEqual(result.rows, []); assert.deepEqual(result.info.rowIds, []);
});

test('own completed writes may leave the filter while pending rows still finish, without expanding the frozen set', async t => {
  const f = autofillViewFixture(), r = runtime(t, f), executor = new AutofillExecutor(r);
  const result = await executor.fill(autofillInput(f.input), r.store);
  assert.equal(result.verifiedRows, 2); assert.equal(r.requests.length, 2); assert.equal(f.writes().length, 2);
  assert.deepEqual(f.writes().map(call => call.payload.transactions[0].operations[0].pointer.id), [f.ids.second, f.ids.first]);
  assert.ok(!JSON.stringify(r.requests).includes('must-not-read-unselected'));
  const next = await new AutofillExecutor(r).fill(autofillInput(f.input), r.store);
  assert.equal(next.verifiedRows, 0); assert.equal(f.writes().length, 2); assert.equal(r.requests.length, 2);
});

test('view pagination and aggregation reducers do not cause duplicate verified writes after a restart', async t => {
  const f = autofillViewFixture(), r = runtime(t, f);
  r.provider.generate = async function* (args) { r.requests.push(args); yield '{"summary":"摘要","category":"研发","tags":[]}'; };
  assert.equal((await new AutofillExecutor(r).fill(autofillInput(f.input), r.store)).verifiedRows, 2);
  f.input.notionSwitchView.request.loader.reducers = { later_page: { type: 'results', limit: 3, startCursor: { stack: ['changed'] } } };
  const result = await new AutofillExecutor(r).fill(autofillInput(f.input), r.store);
  assert.equal(result.reusedRows, 2); assert.equal(f.writes().length, 2); assert.equal(r.requests.length, 2);
});

test('two windows using the same view retain separate transient search scopes in their queued jobs', async t => {
  const f = autofillViewFixture(), r = runtime(t, f), service = new NativeAutofillJobs(r); t.after(() => service.close());
  const first = structuredClone(f.input), second = structuredClone(f.input);
  first.notionSwitchView.request.loader.searchQuery = 'A'; second.notionSwitchView.request.loader.searchQuery = 'B';
  const meta = { store: r.store, userId: f.ids.user };
  const responses = await Promise.all([first, second].map(input => service.handle('triggerLiteAgentAutofill', input, undefined, meta)));
  const queued = await Promise.all(responses.map(response => response.json()));
  assert.equal(queued[0].totalBlocks, 1); assert.equal(queued[1].totalBlocks, 1); assert.notEqual(queued[0].groupId, queued[1].groupId);
  await Promise.all(queued.map(job => service.wait(job.groupId)));
  assert.deepEqual(service.jobs.get(queued[0].groupId).info.rowIds, [f.ids.first]);
  assert.deepEqual(service.jobs.get(queued[1].groupId).info.rowIds, [f.ids.second]);
  assert.equal(f.writes().length, 2); assert.equal(r.requests.length, 2);
});

test('empty views queue a completed zero-row job without generating or writing', async t => {
  const f = autofillViewFixture(), r = runtime(t, f), service = new NativeAutofillJobs(r); t.after(() => service.close());
  f.input.notionSwitchView.request.loader.searchQuery = 'none';
  const response = await service.handle('triggerAgentOverCollection', f.input, undefined, { store: r.store, userId: f.ids.user });
  assert.equal(response.status, 200); const queued = await response.json(); await service.wait(queued.groupId);
  const job = service.jobs.get(queued.groupId); assert.equal(job.status, 'success'); assert.equal(job.rows.length, 0);
  assert.equal(service.progress(job).value.percentageComplete, 100); assert.equal(r.requests.length, 0); assert.equal(f.writes().length, 0);
});

test('unknown query scope semantics are rejected rather than silently dropped', async () => {
  const f = autofillViewFixture(); f.input.notionSwitchView.request.loader.futureScope = { id: f.ids.unselected };
  assert.throws(() => autofillInput(f.input), /视图/); assert.equal(f.queries.length, 0);
});
