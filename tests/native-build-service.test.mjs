import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { databaseBuildStoreFixture } from './helpers/native-database-build-store.mjs';
import { databaseBuildInput, buildId } from './helpers/native-database-build.mjs';
const { NativeBuildService, createNativeBuildService } = createRequire(import.meta.url)('../src/native-build-service.cjs');
function fixture(t) {
  const f = databaseBuildStoreFixture(), parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-native-builder-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const requests = [], provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek' }),
    async* generate(args) { requests.push(args); yield JSON.stringify(f.draft); } };
  const options = { root, provider, storeFactory: () => f.store }, service = new NativeBuildService(options);
  t.after(async () => { service.close(); await service.whenIdle(); });
  return { ...f, root, requests, provider, options, service, input: databaseBuildInput(), meta: { userId: f.ids.user },
    scope: { userId: f.ids.user, spaceId: f.ids.space } };
}
async function preview(f) {
  const response = await f.service.stream(f.input, undefined, f.meta); assert.equal(response.status, 200);
  const frames = (await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);
  const step = frames.flatMap(frame => frame.data?.s || []).find(value => value.type === 'agent-tool-result');
  assert.ok(step, 'Native preview must contain a tool confirmation step'); return { frames, step };
}
const transaction = (f, step, state = 'confirmation:confirmed') => ({ requestId: buildId(300), transactions: [{ id: buildId(301), spaceId: f.ids.space, operations: [{
  pointer: { table: 'thread_message', id: step.id, spaceId: f.ids.space }, command: 'update', path: ['step'], args: { ...step, state }
}] }] });

test('native build preview persists owned thread records, restores history and leaves remote records unchanged', async t => {
  const f = fixture(t), { step } = await preview(f);
  assert.equal(step.state, 'confirmation:requested'); assert.equal(f.writes().length, 0); assert.equal(f.requests.length, 1);
  const thread = f.service.record(f.input.threadId, 'thread', f.scope);
  assert.ok(thread.messages.includes(step.id)); assert.equal(f.service.record(step.id, 'thread_message', f.scope).step.state, step.state);
  const restored = new NativeBuildService(f.options); t.after(() => restored.close());
  assert.equal(restored.record(step.id, 'thread_message', f.scope).step.state, 'confirmation:requested');
  assert.equal(restored.record(step.id, 'thread_message', { ...f.scope, userId: buildId(90) }), undefined);
  assert.equal(restored.record(step.id, 'thread_message', { ...f.scope, spaceId: buildId(91) }), undefined);
  assert.ok(!fs.readFileSync(path.join(f.root, 'native-builds.local.json'), 'utf8').includes('must-not-forward-profile'));
});

test('the original confirmation update commits the stored preview once and returns verified native records', async t => {
  const f = fixture(t), { step } = await preview(f), input = transaction(f, step);
  const response = await f.service.transactions(input, undefined, f.meta), data = await response.json();
  assert.equal(response.status, 200); assert.equal(f.writes().length, 1);
  assert.equal(data.recordMap.thread_message[step.id].value.value.step.state, 'applied');
  const id = step.result.collectionViewBlockId;
  assert.equal(data.recordMap.block[id].value.value.collection_id, step.result.collectionId);
  assert.equal(f.service.record(step.id, 'thread_message', f.scope).step.done, true);
  assert.equal((await f.service.transactions(input, undefined, f.meta)).status, 200); assert.equal(f.writes().length, 1);
});

test('concurrent native confirmations serialize to one transaction and stale source edits cannot authorize a saved plan', async t => {
  const f = fixture(t), { step } = await preview(f), input = transaction(f, step);
  const responses = await Promise.all([f.service.transactions(input, undefined, f.meta), f.service.transactions(input, undefined, f.meta)]);
  assert.deepEqual(responses.map(value => value.status), [200, 200]); assert.equal(f.writes().length, 1);
  const other = fixture(t), result = await preview(other), user = other.input.transcript.find(step => step.type === 'user');
  const update = transaction(other, result.step); update.transactions[0].operations = [{ pointer: { table: 'thread_message', id: user.id, spaceId: other.ids.space },
    command: 'update', path: ['step'], args: { ...user, value: [['更改目的地和字段']] } }];
  assert.equal((await other.service.transactions(update, undefined, other.meta)).status, 200);
  assert.equal((await other.service.transactions(transaction(other, result.step), undefined, other.meta)).status, 409); assert.equal(other.writes().length, 0);
});

test('inference confirmation lists apply only a matching saved preview and do not rerun the model', async t => {
  const f = fixture(t), { step } = await preview(f);
  const response = await f.service.stream({ ...f.input, createThread: false, isPartialTranscript: true, transcript: [], confirmToolStepIds: [step.id] }, undefined, f.meta);
  assert.match(await response.text(), /数据库已创建/); assert.equal(f.writes().length, 1); assert.equal(f.requests.length, 1);
  const other = fixture(t); await preview(other);
  const invalid = await other.service.stream({ ...other.input, createThread: false, isPartialTranscript: true, transcript: [], confirmToolStepIds: [buildId(999)] }, undefined, other.meta);
  assert.match(await invalid.text(), /确认.*不存在|未找到/); assert.equal(other.writes().length, 0); assert.equal(other.requests.length, 1);
});

test('pending preview reads have reader role, reject foreign query scopes and stop serving virtual records after rejection', async t => {
  const f = fixture(t), { step } = await preview(f), plan = f.service.threads.get(f.input.threadId).plans[0].plan;
  assert.equal(f.service.recordRole(plan.collectionId, 'collection', f.scope), 'reader');
  const query = { source: { id: plan.collectionId, spaceId: f.ids.space }, collectionView: { id: plan.viewId }, loader: { reducers: { results: { type: 'results' } } } };
  assert.equal(f.service.previewQuery(query, { userId: buildId(90) }).status, 403);
  assert.equal(f.service.previewQuery({ ...query, collectionView: { ...query.collectionView, spaceId: buildId(91) } }, f.meta).status, 403);
  assert.equal(f.service.previewQuery({ ...query, loader: { reducers: { count: { type: 'aggregation', aggregation: { aggregator: 'unknown' } } } } }, f.meta).status, 400);
  await f.service.transactions(transaction(f, step, 'confirmation:rejected'), undefined, f.meta);
  assert.equal(f.service.record(plan.collectionId, 'collection', f.scope), undefined); assert.equal(f.service.previewQuery(query, f.meta).status, 409);
});

test('every selected layout is readable in the native preview and the confirmation displays and verifies all layouts', async t => {
  const f = fixture(t), draft = { ...f.draft, views: [{ type: 'board', name: '状态看板', groupBy: '状态' },
    { type: 'calendar', name: '截止日历', dateBy: '截止日期' }, { type: 'timeline', name: '项目时间轴', dateBy: '截止日期' }] };
  f.provider.generate = async function* (args) { f.requests.push(args); yield JSON.stringify(draft); };
  const { step, frames } = await preview(f), plan = f.service.threads.get(f.input.threadId).plans[0].plan;
  assert.match(JSON.stringify(frames), /状态看板/); assert.match(JSON.stringify(frames), /截止日历/); assert.match(JSON.stringify(frames), /项目时间轴/);
  for (const viewId of plan.viewIds) {
    assert.equal(f.service.record(viewId, 'collection_view', f.scope).id, viewId);
    const result = await f.service.previewQuery({ source: { id: plan.collectionId, spaceId: f.ids.space },
      collectionView: { id: viewId, spaceId: f.ids.space }, loader: { reducers: { results: { type: 'results', limit: 50 } } } }, f.meta);
    assert.equal(result.status, 200); assert.equal(Object.keys((await result.json()).recordMap.collection_view).length, 3);
  }
  const schema = f.service.record(plan.collectionId, 'collection', f.scope).schema, statusId = Object.keys(schema).find(id => schema[id].type === 'status');
  const grouped = await f.service.previewQuery({ source: { id: plan.collectionId, spaceId: f.ids.space }, collectionView: { id: plan.viewId, spaceId: f.ids.space },
    loader: { reducers: { groups: { type: 'groups', groupBy: { property: statusId, type: 'status', groupBy: 'option', sort: { type: 'ascending' } },
      groupSortPreference: [], limit: 100, blockResults: { type: 'independent', defaultLimit: 50 },
      aggregation: { type: 'independent', groupAggregation: { aggregator: 'count' } } } } } }, f.meta);
  assert.equal(grouped.status, 200); const groupResult = (await grouped.json()).result.reducerResults.groups;
  assert.equal(groupResult.type, 'groups'); assert.equal(groupResult.version, 'v2'); assert.equal(groupResult.hasMore, false);
  assert.equal(groupResult.results.length, 4); assert.equal(Object.values(groupResult.blockResults).flatMap(value => value.blockIds).length, 0);
  assert.ok(Object.values(groupResult.aggregationResults).every(value => value.aggregationResult.value === 0)); assert.equal(f.writes().length, 0);
  assert.equal((await f.service.transactions(transaction(f, step), undefined, f.meta)).status, 200); assert.equal(f.writes().length, 1);
  assert.equal((await f.store.verify(plan)).ok, true);
});

test('native reject, wrong account, altered schema and mixed local/remote updates cannot create a database', async t => {
  for (const variant of ['reject', 'account', 'tamper', 'mixed']) {
    const f = fixture(t), { step } = await preview(f), input = transaction(f, step), meta = { ...f.meta };
    if (variant === 'reject') input.transactions[0].operations[0].args.state = 'confirmation:rejected';
    if (variant === 'account') meta.userId = buildId(90);
    if (variant === 'tamper') input.transactions[0].operations[0].args.input.columns[0].name = 'tampered';
    if (variant === 'mixed') input.transactions[0].operations.push({ pointer: { table: 'block', id: f.ids.parent, spaceId: f.ids.space }, command: 'update', path: [], args: { alive: false } });
    const response = await f.service.transactions(input, undefined, meta);
    assert.ok(response); assert.equal(response.status, variant === 'reject' ? 200 : variant === 'account' ? 403 : variant === 'mixed' ? 409 : 400);
    assert.equal(f.writes().length, 0);
    if (variant === 'reject') assert.equal(f.service.record(step.id, 'thread_message', f.scope).step.state, 'confirmation:rejected');
  }
});

test('an unknown write is retained across restart and repeated confirmation only reads; a lost successful reply is recovered', async t => {
  for (const behavior of ['before-error', 'after-error']) {
    const f = fixture(t), { step } = await preview(f), input = transaction(f, step); f.setBehavior(behavior);
    const first = await f.service.transactions(input, undefined, f.meta);
    assert.equal(first.status, behavior === 'after-error' ? 200 : 409); assert.equal(f.writes().length, 1);
    const restored = new NativeBuildService(f.options); t.after(() => restored.close());
    const repeated = await restored.transactions(input, undefined, f.meta);
    assert.equal(repeated.status, behavior === 'after-error' ? 200 : 409); assert.equal(f.writes().length, 1);
  }
});

test('a partial native transcript continues from owned saved history and supersedes its old unconfirmed preview', async t => {
  const f = fixture(t), { step } = await preview(f), next = { ...f.input, createThread: false, isPartialTranscript: true,
    transcript: [{ id: buildId(60), type: 'user', value: [['把名称改成“合成跟踪二”']] }] };
  f.provider.generate = async function* (args) { f.requests.push(args); yield JSON.stringify({ ...f.draft, title: '合成跟踪二' }); };
  const response = await f.service.stream(next, undefined, f.meta); assert.equal(response.status, 200); await response.text();
  assert.match(JSON.stringify(f.requests.at(-1).messages), /合成项目跟踪/);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /合成跟踪二/);
  assert.equal(f.service.record(step.id, 'thread_message', f.scope).step.state, 'confirmation:rejected');
  assert.equal((await f.service.transactions(transaction(f, step), undefined, f.meta)).status, 409); assert.equal(f.writes().length, 0);
});

test('native follow-up message creation and list insertion are kept local before an empty partial inference request', async t => {
  const f = fixture(t), { step } = await preview(f), id = buildId(80), record = { id, space_id: f.ids.space, parent_id: f.input.threadId,
    parent_table: 'thread', step: { id, type: 'user', value: [['把数据库改名为“追踪三”']] } };
  const body = { transactions: [{ id: buildId(81), spaceId: f.ids.space, operations: [
    { pointer: { table: 'thread_message', id, spaceId: f.ids.space }, command: 'set', path: [], args: record },
    { pointer: { table: 'thread', id: f.input.threadId, spaceId: f.ids.space }, command: 'listAfter', path: ['messages'], args: { id, after: step.id } }
  ] }] };
  const saved = await f.service.transactions(body, undefined, f.meta); assert.ok(saved); assert.equal(saved.status, 200);
  assert.equal(f.service.record(id, 'thread_message', f.scope).step.value[0][0], '把数据库改名为“追踪三”');
  f.provider.generate = async function* (args) { f.requests.push(args); yield JSON.stringify({ ...f.draft, title: '追踪三' }); };
  const response = await f.service.stream({ ...f.input, createThread: false, isPartialTranscript: true, transcript: [] }, undefined, f.meta); await response.text();
  assert.match(JSON.stringify(f.requests.at(-1).messages), /追踪三/); assert.equal(f.writes().length, 0);
});

test('failed model generation is persisted as failure rather than a successful inference outcome', async t => {
  const f = fixture(t); f.provider.generate = async function* () { throw Error('synthetic model failure'); };
  const response = await f.service.stream(f.input, undefined, f.meta); await response.text();
  const thread = f.service.record(f.input.threadId, 'thread', f.scope);
  assert.equal(thread.data.last_turn_outcome.status, 'failure'); assert.equal(f.writes().length, 0);
});

test('the native patch snapshot consumer accepts generated builder previews using the original v2 frame shape', async t => {
  const f = fixture(t), { frames, step } = await preview(f);
  const file = new URL('../research/.public-assets/42968-3f44bc15b3fbb9a7.js', import.meta.url);
  if (!fs.existsSync(file)) return t.skip('Reviewed public frontend sample is not installed');
  const source = fs.readFileSync(file, 'utf8'), at = source.indexOf('function eF(e)'), end = source.indexOf('function eO(', at);
  const process = vm.runInNewContext('(' + source.slice(at, end) + ')', {});
  const frame = frames.find(frame => frame.type === 'patch-start');
  const result = process({ environment: {}, threadId: f.input.threadId, value: frame, patchState: { s: [] }, spaceId: f.ids.space });
  assert.equal(result.find(value => value.type === 'agent-tool-result').id, step.id);
});

test('stopping native build generation aborts the model, releases busy state and emits no preview to confirm', async t => {
  const f = fixture(t); let began; const started = new Promise(resolve => { began = resolve; });
  f.provider.generate = async function* ({ signal }) { began(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted(); };
  const response = await f.service.stream(f.input, undefined, f.meta); await started; assert.equal(f.service.active, 1);
  assert.equal((await f.service.stop(f.input, f.meta)).status, 200); const text = await response.text(); await f.service.whenIdle();
  assert.equal(f.service.active, 0); assert.ok(!text.includes('"toolType":"create-database"')); assert.equal(f.writes().length, 0);
});

test('ordinary native transactions pass through and a corrupt builder file is preserved while this feature fails closed', async t => {
  const f = fixture(t); assert.equal(await f.service.transactions({ transactions: [] }, undefined, f.meta), null);
  const file = path.join(f.root, 'native-builds.local.json'); fs.writeFileSync(file, 'broken journal');
  const unavailable = createNativeBuildService(f.options); assert.equal(unavailable.available, false);
  assert.equal((await unavailable.stream(f.input, undefined, f.meta)).status, 503); assert.equal(fs.readFileSync(file, 'utf8'), 'broken journal');
});

for (const filename of ['22299-15b5c35dcfff26f6.js', '22299-32a207982513c662.js']) {
const sample = new URL('../research/.public-assets/' + filename, import.meta.url);
test('reviewed native confirmation producer reaches the builder service: ' + filename, { skip: !fs.existsSync(sample) && 'Reviewed public frontend sample is not installed' }, async t => {
  const f = fixture(t), { step } = await preview(f), source = fs.readFileSync(sample, 'utf8'), start = source.indexOf('752104('), at = source.indexOf('async function i(e)', start), end = source.indexOf('n.d(t,{j:', at);
  assert.ok(at > 0 && end > at); let response;
  const run = vm.runInNewContext('(' + source.slice(at, end) + ')', {
    n: id => {
      if (id === 851062) return { ey: value => value.filter(step => step.type === 'agent-tool-result') };
      if (id === 323517) return { createAndCommit: ({ perform }) => { const operations = []; perform(operations);
        const input = transaction(f, step); input.transactions[0].operations = operations;
        return { serverCommitResult: f.service.transactions(input, undefined, f.meta).then(value => { response = value; }) }; } };
      assert.fail('Unexpected native dependency: ' + id);
    },
    r: () => ({ y: ({ operation, transaction }) => transaction.push(operation) }),
    a: () => ({ oA: (step, state) => ({ ...step, state }) }),
    s: () => ({ op: { shallowMerge: value => ({ ...value, command: 'update' }) } }), o: () => ({ mSw: 'thread_message' })
  });
  await run({ environment: {}, threadStore: { getSpaceId: () => f.ids.space, getMessages: () => [step.id], getMessageStoreAt: () => ({ getStep: () => step }) }, confirmToolStepIds: [step.id] });
  assert.equal(response.status, 200); assert.equal(f.writes().length, 1); assert.equal(f.service.record(step.id, 'thread_message', f.scope).step.state, 'applied');
});
}
