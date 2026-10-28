import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { databaseBuildStoreFixture } from './helpers/native-database-build-store.mjs';
import { databaseBuildInput, buildId } from './helpers/native-database-build.mjs';
const require = createRequire(import.meta.url), { NativeBuildService } = require('../src/native-build-service.cjs');
const { NativeMock, json } = require('../src/native-mock.cjs'), { localRecords } = require('../src/local-records.cjs');
function fixture(t) {
  const f = databaseBuildStoreFixture(), parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-build-route-'));
  const modelCalls = [], provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek' }),
    async* generate(args) { modelCalls.push(args); yield JSON.stringify(f.draft); } };
  const databaseBuild = new NativeBuildService({ root, provider, storeFactory: () => f.store }), mock = new NativeMock({ provider });
  t.after(async () => { databaseBuild.close(); await databaseBuild.whenIdle(); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const forwarded = [], source = fs.readFileSync(new URL('../src/desktop-hook.cjs', import.meta.url), 'utf8');
  const context = { Request, Response, Headers, URL, databaseBuild, provider, localRecords, mock, json, createNativeImageAdapter: () => undefined,
    settings: { speech: { enabled: false }, isLoginSyncing: () => false }, nativeSpeech: { enabled: false },
    meetingBridge: { observe() {} }, recordings: { wake() {} }, log() {}, localUploadPrefix: '/notion-switch-local-upload/',
    isNotion: host => host === 'app.notion.com', endpoints: new Set(['runInferenceTranscript', 'stopWorkflowAutomationRunThread']),
    aiRecords: { record: (id, table, scope) => databaseBuild.record(id, table, scope) || mock.record(id, table),
      recordRole: (id, table, scope) => databaseBuild.recordRole(id, table, scope) } };
  const route = vm.runInNewContext(source.slice(source.indexOf('async function route('), source.indexOf('\nfunction install(ses)')) + '\nroute', context);
  const call = (endpoint, input, userId = f.ids.user) => route(new Request('https://app.notion.com/api/v3/' + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-notion-active-user-header': userId }, body: JSON.stringify(input)
  }), async request => {
    const name = new URL(request.url).pathname.split('/').at(-1), data = await request.json(); forwarded.push({ name, data });
    if (name === 'getRecordValues') return json(await f.native.api(name, data, { spaceId: f.ids.space }));
    if (name === 'getInferenceTranscriptsForUser') return json({ threadIds: [], nextCursor: null });
    if (['saveTransactionsFanout', 'queryCollection', 'getThreadSpaceId'].includes(name)) return json({ ordinary: true });
    assert.fail('Hosted inference must not receive local builder requests: ' + name);
  });
  const input = databaseBuildInput();
  const preview = async () => {
    const response = await call('runInferenceTranscript', input); assert.equal(response.status, 200);
    const frames = (await response.text()).trim().split('\n').map(JSON.parse), step = frames.flatMap(frame => frame.data?.s || []).find(step => step.type === 'agent-tool-result');
    assert.ok(step); return step;
  };
  const confirmation = step => ({ transactions: [{ id: buildId(501), spaceId: f.ids.space, operations: [{
    pointer: { table: 'thread_message', id: step.id, spaceId: f.ids.space }, command: 'update', path: ['step'], args: { ...step, state: 'confirmation:confirmed' }
  }] }] });
  return { ...f, root, databaseBuild, mock, provider, modelCalls, forwarded, call, input, preview, confirmation };
}

test('actual desktop build route produces a preview, serves read-only native records and confirms the stored plan once', async t => {
  const f = fixture(t), step = await f.preview(); assert.equal(f.modelCalls.length, 1); assert.equal(f.writes().length, 0);
  const { collectionViewBlockId: id, collectionId, collectionViewId: viewId } = step.result;
  const records = await (await f.call('getRecordValues', { requests: [{ table: 'block', id, spaceId: f.ids.space }, { table: 'block', id: f.ids.parent, spaceId: f.ids.space }] })).json();
  assert.equal(records.results[0].role, 'reader'); assert.equal(records.results[0].value.collection_id, collectionId);
  assert.equal(records.results[1].value.id, f.ids.parent); assert.equal(f.forwarded.length, 1);
  const plan = f.databaseBuild.threads.get(f.input.threadId).plans[0].plan;
  const query = await f.call('queryCollection', { source: { type: 'collection', id: collectionId, spaceId: f.ids.space },
    collectionView: { id: viewId || plan.viewId, spaceId: f.ids.space }, loader: { reducers: { results: { type: 'results', limit: 200 } } } });
  assert.equal(query.status, 200); assert.deepEqual((await query.json()).result.reducerResults.results.blockIds, []);
  const confirmed = await f.call('saveTransactionsFanout', f.confirmation(step)); assert.equal(confirmed.status, 200);
  const data = await confirmed.json(); assert.equal(data.recordMap.thread_message[step.id].value.value.step.state, 'applied');
  assert.equal(data.recordMap.block[id].value.value.collection_id, collectionId); assert.equal(f.writes().length, 1);
  assert.equal((await f.call('saveTransactionsFanout', f.confirmation(step))).status, 200); assert.equal(f.writes().length, 1);
  assert.deepEqual(f.forwarded.map(item => item.name), ['getRecordValues']);
});

test('native desktop entry points cannot take over an existing research or builder conversation ID', async t => {
  const f = fixture(t); await f.preview(); const before = f.modelCalls.length;
  const side = await f.call('createAgentThread', { threadId: f.input.threadId, spaceId: f.ids.space, content: [{ type: 'text', text: '新的合成侧栏问题' }] });
  assert.equal(side.status, 409); assert.equal(f.mock.agent.threads.size, 0);
  const threadId = buildId(650), web = { threadId, spaceId: f.ids.space, transcript: [
    { id: buildId(651), type: 'config', value: { type: 'researcher', searchScope: { type: 'web' }, useWebSearch: true } },
    { id: buildId(652), type: 'user', value: [['只研究合成公开网页']] }
  ] };
  const response = await f.call('runInferenceTranscript', web); assert.equal(response.status, 200); await response.text();
  assert.equal(f.mock.record(threadId).created_source, 'researcher');
  const takeover = await f.call('runInferenceTranscript', { ...f.input, threadId });
  assert.equal(takeover.status, 409); assert.equal(f.databaseBuild.owns({ threadId }), false);
  assert.equal(f.mock.record(threadId).created_source, 'researcher'); assert.equal(f.modelCalls.length, before);
});

test('build transactions and metadata enforce account ownership while ordinary saves keep their native route', async t => {
  const f = fixture(t), step = await f.preview(), foreign = buildId(550);
  assert.equal((await f.call('saveTransactionsFanout', f.confirmation(step), foreign)).status, 403);
  assert.equal((await f.call('getThreadSpaceId', { threadId: f.input.threadId }, foreign)).status, 403);
  assert.equal((await f.call('stopWorkflowAutomationRunThread', { threadId: f.input.threadId, spaceId: f.ids.space }, foreign)).status, 404);
  assert.equal(f.writes().length, 0); assert.equal(f.forwarded.length, 0);
  assert.equal((await (await f.call('getThreadSpaceId', { threadId: f.input.threadId })).json()).spaceId, f.ids.space);
  const ordinary = { transactions: [{ id: buildId(551), operations: [{ pointer: { table: 'block', id: f.ids.parent }, command: 'update', path: [], args: { alive: true } }] }] };
  assert.deepEqual(await (await f.call('saveTransactionsFanout', ordinary)).json(), { ordinary: true });
  assert.deepEqual(f.forwarded.at(-1).data, ordinary);
});

test('builder history uses the existing combined cursor service and retrying an applied preview never regenerates', async t => {
  const f = fixture(t), step = await f.preview(); await f.call('saveTransactionsFanout', f.confirmation(step));
  const input = { threadParentPointer: { table: 'space', id: f.ids.space }, types: ['workflow'], limit: 10 };
  const listed = await (await f.call('getInferenceTranscriptsForUser', input)).json(); assert.ok(listed.threadIds.includes(f.input.threadId));
  const denied = await (await f.call('getInferenceTranscriptsForUser', input, buildId(552))).json(); assert.ok(!denied.threadIds.includes(f.input.threadId));
  const retry = await f.call('runInferenceTranscript', { ...f.input, isRetry: true }); const text = await retry.text();
  assert.match(text, /数据库已创建/); assert.equal(f.modelCalls.length, 1); assert.equal(f.writes().length, 1);
});

test('actual desktop route previews grouped layouts, enforces both pointer workspaces and returns all confirmed views', async t => {
  const f = fixture(t), draft = { ...f.draft, views: [{ name: '看板', type: 'board', groupBy: '状态' }, { name: '日历', type: 'calendar', dateBy: '截止日期' }] };
  f.provider.generate = async function* (args) { f.modelCalls.push(args); yield JSON.stringify(draft); };
  const step = await f.preview(), plan = f.databaseBuild.threads.get(f.input.threadId).plans[0].plan;
  const schema = f.databaseBuild.record(plan.collectionId, 'collection', { userId: f.ids.user, spaceId: f.ids.space }).schema;
  const statusId = Object.keys(schema).find(id => schema[id].type === 'status');
  const input = { source: { type: 'collection', id: plan.collectionId, spaceId: f.ids.space }, collectionView: { id: plan.viewIds[0], spaceId: f.ids.space },
    loader: { reducers: { groups: { type: 'groups', groupBy: { property: statusId, type: 'status', groupBy: 'option', sort: { type: 'ascending' } },
      groupSortPreference: [], limit: 100, blockResults: { type: 'independent', defaultLimit: 50 } } } } };
  const response = await f.call('queryCollection', input), data = await response.json(); assert.equal(response.status, 200);
  assert.equal(Object.keys(data.recordMap.collection_view).length, 2); assert.equal(data.result.reducerResults.groups.results.length, 4);
  assert.equal((await f.call('queryCollection', { ...input, collectionView: { ...input.collectionView, spaceId: buildId(599) } })).status, 403);
  assert.equal(f.forwarded.length, 0); assert.equal(f.writes().length, 0);
  const confirmed = await (await f.call('saveTransactionsFanout', f.confirmation(step))).json();
  assert.equal(Object.keys(confirmed.recordMap.collection_view).length, 2); assert.equal((await f.store.verify(plan)).ok, true); assert.equal(f.writes().length, 1);
});

test('new rows and child records under an unconfirmed preview cannot escape to the native server', async t => {
  const f = fixture(t), step = await f.preview(), plan = f.databaseBuild.threads.get(f.input.threadId).plans[0].plan;
  const payload = (table, parentTable, parentId) => ({ transactions: [{ id: buildId(610), spaceId: f.ids.space, operations: [{
    pointer: { table, id: buildId(611), spaceId: f.ids.space }, command: 'set', path: [], args: { id: buildId(611), space_id: f.ids.space,
      type: 'page', parent_table: parentTable, parent_id: parentId, alive: true, properties: { title: [['temporary preview row']] } }
  }] }] });
  const row = payload('block', 'collection', plan.collectionId), child = payload('block', 'block', plan.databaseId), view = payload('collection_view', 'block', plan.databaseId);
  for (const input of [row, child, view]) assert.equal((await f.call('saveTransactionsFanout', input)).status, 409);
  assert.equal(f.forwarded.length, 0); assert.equal(f.writes().length, 0);
  assert.equal((await f.call('saveTransactionsFanout', f.confirmation(step))).status, 200);
  assert.deepEqual(await (await f.call('saveTransactionsFanout', row)).json(), { ordinary: true }, 'Confirmed graph returns to native editing');
});
