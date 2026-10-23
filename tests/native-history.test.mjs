import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { NativeMock } = require('../src/native-mock.cjs');
const { LocalHistory } = require('../src/local-history.cjs');
const { AgentMock } = require('../src/agent-mock.cjs');
const SPACE = '11111111-1111-4111-8111-111111111111', USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', THREAD = '22222222-2222-4222-8222-222222222222';
test('a persisted DeepSeek conversation appears in the native history dropdown and reopens after restart', async t => {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-native-history-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const stateFile = path.join(root, 'conversations.json');
  const provider = { config: () => ({ mode: 'deepseek', model: 'deepseek-flash' }), status: () => ({ mode: 'deepseek', model: 'deepseek-flash' }), async* generate() { yield '已保存这段合成测试对话。'; } };
  const first = new NativeMock({ stateFile, provider });
  await first.handle('createAgentThread', { threadId: THREAD, spaceId: SPACE, content: [{ type: 'text', text: '解释自动保存历史对话的方法' }] }, null, { userId: USER });
  for (let n = 0; n < 100 && first.agent.status().active; n++) await sleep(5);
  const restored = new NativeMock({ stateFile, provider });
  const list = await restored.handle('getInferenceTranscriptsForUser', { threadParentPointer: { table: 'space', id: SPACE, spaceId: SPACE }, limit: 50 }, null, { userId: USER, passthrough: async () => new Response(JSON.stringify({ threadIds: [], nextCursor: null, recordMap: { __version__: 3 } })) });
  assert.equal(list.status, 200);
  const data = await list.json();
  assert.ok(data.threadIds.includes(THREAD));
  const record = restored.agent.record(THREAD);
  assert.match(record.data.title, /历史对话/);
  const transcript = await (await restored.handle('getThreadTranscript', { threadId: THREAD })).json();
  assert.ok(transcript.patches.some(p => p.entity.kind === 'assistant_message' && p.entity.content[0].text.includes('已保存')));
});

test('native history paginates local and remote records without dropping rows or sending local IDs upstream', async () => {
  const history = new LocalHistory(), threads = new Map(), calls = [], remoteIds = ['remote-1', 'remote-2', 'remote-3'];
  for (let n = 0; n < 5; n++) threads.set('local-' + n, { thread: { id: 'local-' + n, alive: true, type: 'workflow', space_id: SPACE, created_by_id: USER, updated_time: 100 - n, created_time: 100 - n, data: { title: '测试-' + n } } });
  const agent = { threads, record: id => threads.get(id)?.thread };
  const fetchRemote = async input => { calls.push(input); assert.equal(JSON.stringify(input).includes('notion-switch-history:'), false); assert.equal(JSON.stringify(input).includes('local-'), false); const offset = Number(input.cursor) || 0, rows = remoteIds.slice(offset, offset + input.limit); return new Response(JSON.stringify({ threadIds: rows, nextCursor: offset + rows.length < remoteIds.length ? String(offset + rows.length) : null, recordMap: { __version__: 3 } })); };
  let cursor, seen = [];
  for (let n = 0; n < 8; n++) {
    const input = { threadParentPointer: { table: 'space', id: SPACE }, limit: 2, ...(cursor ? { cursor } : {}) };
    const data = await (await history.list({ input, agent, userId: USER, fetchRemote })).json();
    assert.ok(data.threadIds.length <= 2); seen.push(...data.threadIds); cursor = data.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ['local-0', 'local-1', 'local-2', 'local-3', 'local-4', ...remoteIds]);
  assert.equal(calls[0].limit, 1); assert.equal(calls[1].cursor, '1');
});

test('local history isolates users, workspaces, archived views and cursor scope while preserving native remote data', async () => {
  const threads = new Map();
  const add = (id, user, space) => threads.set(id, { thread: { id, created_by_id: user, space_id: space, type: 'workflow', alive: true, updated_time: 5, created_time: 5, data: { title: 'synth' } } });
  add('own', USER, SPACE); add('other-user', THREAD, SPACE); add('other-workspace', USER, THREAD);
  const agent = { threads, record: id => threads.get(id)?.thread }, history = new LocalHistory();
  const fetchRemote = async () => new Response(JSON.stringify({ threadIds: ['native-remote'], nextCursor: 'native-next', unrelated: { keep: true }, recordMap: { __version__: 3, block: { untouched: true } } }));
  const input = { threadParentPointer: { table: 'space', id: SPACE }, limit: 50 };
  const data = await (await history.list({ input, userId: USER, agent, fetchRemote })).json();
  assert.deepEqual(data.threadIds, ['own', 'native-remote']); assert.equal(data.nextCursor, 'native-next');
  assert.deepEqual(data.unrelated, { keep: true }); assert.deepEqual(data.recordMap.block, { untouched: true });
  assert.equal(JSON.stringify(data).includes('other-user'), false); assert.equal(JSON.stringify(data).includes('other-workspace'), false);
  const archived = await (await history.list({ input: { ...input, archived: true }, userId: USER, agent, fetchRemote })).json();
  assert.deepEqual(archived.threadIds, ['native-remote']);
  const first = await (await history.list({ input: { ...input, limit: 1 }, userId: USER, agent, fetchRemote })).json();
  const wrongUser = await (await history.list({ input: { ...input, cursor: first.nextCursor }, userId: THREAD, agent, fetchRemote: () => { throw Error('local cursor must never be forwarded'); } })).json();
  assert.deepEqual(wrongUser.threadIds, []);
});

test('local saved conversations remain accessible when remote history is unavailable and logs contain only counts', async () => {
  const record = { id: THREAD, alive: true, type: 'workflow', space_id: SPACE, created_by_id: USER, created_time: 1, updated_time: 1, data: { title: 'private-fixture-history' } };
  const logs = [], history = new LocalHistory({ log: data => logs.push(data) }), agent = { threads: new Map([[THREAD, { thread: record }]]), record: () => record };
  const result = await history.list({ input: { threadParentPointer: { table: 'space', id: SPACE }, limit: 50 }, agent, userId: USER, fetchRemote: async () => new Response('upstream-private-error', { status: 503 }) });
  assert.equal(result.status, 200); assert.deepEqual((await result.json()).threadIds, [THREAD]);
  assert.equal(JSON.stringify(logs).includes('private-fixture'), false); assert.equal(JSON.stringify(logs).includes(THREAD), false);
});

test('streaming reply text is automatically persisted before generation finishes', async t => {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-history-stream-save-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  let release;
  const provider = { config: () => ({ mode: 'deepseek' }), async* generate() { yield '尚未结束的合成回复'; await new Promise(resolve => { release = resolve; }); yield '已结束'; } };
  const stateFile = path.join(root, 'conversations.json'), agent = new AgentMock({ stateFile, provider });
  const input = { threadId: THREAD, spaceId: SPACE, content: [{ type: 'text', text: '自动保存测试' }] };
  agent.create(input, { userId: USER });
  for (let n = 0; n < 100 && !release; n++) await sleep(5);
  await sleep(1100);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(saved.threads[0].entities.some(e => e.kind === 'assistant_message' && e.content[0].text.includes('尚未结束')));
  assert.equal(agent.status().active, 1); release();
  for (let n = 0; n < 100 && agent.status().active; n++) await sleep(5);
});

test('legacy generic titles are migrated without changing stored messages or a user-chosen title', async t => {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-history-title-migration-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const stateFile = path.join(root, 'conversations.json');
  const agent = new AgentMock({ stateFile });
  agent.create({ threadId: THREAD, spaceId: SPACE, content: [{ type: 'text', text: '旧版会话：讨论每周计划' }] }, { userId: USER }); agent.find({ threadId: THREAD }).stop('fixture-cleanup');
  const record = agent.record(THREAD); record.data.title = 'NotionSwitch · deepseek-flash'; agent.save();
  const before = JSON.parse(fs.readFileSync(stateFile, 'utf8')).threads[0];
  const restored = new AgentMock({ stateFile });
  assert.equal(restored.record(THREAD).data.title, '旧版会话：讨论每周计划'); assert.ok(restored.record(THREAD).version > record.version);
  assert.deepEqual([...restored.find({ threadId: THREAD }).entities.values()], before.entities);
  restored.record(THREAD).data.title = 'NotionSwitch · 我的自定义标题'; restored.save();
  const reopened = new AgentMock({ stateFile }); assert.equal(reopened.record(THREAD).data.title, 'NotionSwitch · 我的自定义标题');
});
