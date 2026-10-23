import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { compact, recoverCheckpoint, reconcileCheckpoint, receipt } = require('../src/agent-context.cjs');
const { canonical } = require('../src/notion-mutations.cjs');
const { AgentMock } = require('../src/agent-mock.cjs');
const { runAgent } = require('../src/agent-runtime.cjs');
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const checkpoint = task => ({ version: 1, task, operationScope: 'fixture-thread:fixture-turn', receipts: [], pending: [], compactions: 0 });
const toolExchange = (name, result, id = 'read-fixture') => [
  { role: 'assistant', content: '', reasoning_content: 'complete synthetic reasoning', tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] },
  { role: 'tool', tool_call_id: id, content: JSON.stringify(result) }
];
function fixture(t) {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-context-edges-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'write-journal'));
  return root;
}
function writeJournal(root, operationScope, index, { status = 'verified', noResult = false } = {}) {
  const id = `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, '0')}`;
  const args = { data_source_id: SOURCE, properties: { 词汇: '合成术语-' + index, 释义: '合成释义' } };
  const request = { method: 'POST', endpoint: 'pages', body: { parent: { type: 'data_source_id', data_source_id: SOURCE }, properties: args.properties } };
  const record = { status, workspace_id: WORKSPACE, operation_scope: operationScope + ':' + WORKSPACE, name: 'create_database_entry', target: SOURCE, intended: args, request, response: { object: 'page', id }, ...(!noResult ? { result: { verified: true, page_id: id, url: `https://www.notion.so/${id.replaceAll('-', '')}` } } : {}) };
  const hash = createHash('sha256').update(JSON.stringify(canonical({ workspaceId: WORKSPACE, operationScope: record.operation_scope, name: record.name, target: record.target, args, ...request }))).digest('hex');
  record.operation_id = hash;
  if (record.result) record.result.operation_id = hash;
  fs.writeFileSync(path.join(root, 'write-journal', 'content-' + hash + '.json'), JSON.stringify(record));
  return { record, id };
}

test('multiple compactions retain earlier read references, pagination state and prior assistant context', () => {
  const task = '将来源页面的词汇导入刚才找到的目标数据库，只继续剩余内容。';
  const state = checkpoint(task);
  const messages = [{ role: 'system', content: 'synthetic system' }, { role: 'user', content: task },
    { role: 'assistant', content: '已按你的要求选定目标数据库，需保留此前的字段映射。' },
    ...toolExchange('search_databases', { database_id: SOURCE, workspace_id: WORKSPACE, next_cursor: 'initial-search-cursor', has_more: true, markdown: 'synthetic body '.repeat(15000) })];
  compact(messages, state, { force: true });
  assert.ok(Array.isArray(state.readEvidence) && state.readEvidence.length);
  assert.ok(Array.isArray(state.priorAnswers) && state.priorAnswers.length);
  messages.push(...toolExchange('read_page', { page_id: PAGE, markdown: 'new synthetic body '.repeat(15000) }, 'second-read'));
  compact(messages, state, { force: true });
  const payload = JSON.stringify(messages);
  assert.equal(payload.includes(SOURCE), true);
  assert.equal(payload.includes('initial-search-cursor'), true);
  assert.equal(payload.includes('此前的字段映射'), true);
  assert.equal(state.compactions, 2);
});

test('compaction preserves machine cursors exactly rather than replacing them with a truncated pseudo-cursor', () => {
  const task = '跨工作区继续搜索全部已授权页面。', state = checkpoint(task);
  const cursor = 'nsw1:' + 'synthetic-valid-cursor-data-'.repeat(50);
  const messages = [{ role: 'system', content: '' }, { role: 'user', content: task },
    ...toolExchange('search_pages', { workspace_id: WORKSPACE, next_cursor: cursor, has_more: true, markdown: 'large '.repeat(40000) })];
  compact(messages, state, { force: true });
  assert.equal(JSON.stringify(messages).includes(cursor), true);
});

test('an original task that fits the context is not duplicated until compaction itself exceeds the limit', () => {
  const task = '必须保留的原始任务约束。'.repeat(10000), state = checkpoint(task);
  assert.ok(task.length < 160000);
  const messages = [{ role: 'system', content: '' }, { role: 'user', content: task },
    ...toolExchange('read_page', { page_id: PAGE, markdown: 'large synthetic result '.repeat(10000) })];
  assert.doesNotThrow(() => compact(messages, state, { force: true }));
  assert.ok(JSON.stringify(messages).length < 200000);
  assert.equal(messages.filter(m => m.role === 'user' && !m.notionSwitchMemory).some(m => m.content === task), true);
});

test('checkpoint recovery retrieves exactly the completed task receipts, excluding another turn', t => {
  const root = fixture(t), scope = 'fixture-thread:fixture-turn';
  for (let i = 0; i < 96; i++) writeJournal(root, scope, i);
  writeJournal(root, 'different-thread:different-turn', 100);
  const state = recoverCheckpoint(root, scope, '继续剩余合成任务');
  assert.equal(state.receipts.length, 96);
  assert.equal(state.receipts.every(r => r.verified), true);
  assert.equal(state.receipts.some(r => r.arguments.properties.词汇 === '合成术语-100'), false);
});

test('an uncertain submitted creation retains the server-assigned object ID for readback', t => {
  const root = fixture(t), scope = 'fixture-thread:fixture-turn';
  const { id } = writeJournal(root, scope, 0, { status: 'submitted', noResult: true });
  const state = recoverCheckpoint(root, scope, '继续剩余合成任务');
  assert.equal(state.receipts.length, 1);
  assert.equal(state.receipts[0].uncertain, true);
  assert.equal(JSON.stringify(state.receipts[0].result).includes(id), true);
});

test('restoring an existing checkpoint reconciles a verified journal write completed just before interruption', t => {
  const root = fixture(t), scope = 'fixture-thread:fixture-turn';
  const { record } = writeJournal(root, scope, 0);
  const stateFile = path.join(root, 'conversations.json');
  const savedCheckpoint = checkpoint('继续剩余合成任务');
  savedCheckpoint.pending = [{ id: 'pending-at-stop', type: 'function', function: { name: record.name, arguments: JSON.stringify(record.intended) } }];
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, threads: [{
    thread: { id: 'fixture-thread', space_id: WORKSPACE, data: { agent_provider: {} } },
    sessionId: 'fixture-session', turns: [{ turnId: 'fixture-turn', status: 'stopped', verifiedWrites: 0 }],
    sequence: 1, session: { status: 'idle' }, eventIds: [], entities: [{ id: 'user-fixture', kind: 'user_message', sequence: 1, text: [['继续剩余合成任务']] }], agentCheckpoint: savedCheckpoint
  }] }));
  const agent = new AgentMock({ stateFile });
  const restored = agent.threads.get('fixture-thread').agentCheckpoint;
  assert.equal(restored.receipts.filter(r => r.verified).length, 1);
});

test('journal reconciliation counts one operation once when routing stripped the workspace argument', t => {
  const root = fixture(t), scope = 'fixture-thread:fixture-turn';
  const { record } = writeJournal(root, scope, 0);
  const state = checkpoint('继续剩余合成任务');
  state.receipts.push(receipt(record.name, { ...record.intended, workspace_id: WORKSPACE }, { ...record.result, workspace_id: WORKSPACE }));
  reconcileCheckpoint(root, state);
  assert.equal(state.receipts.filter(r => r.verified).length, 1);
});

test('resuming after a native page change stops before opening a workspace or calling the model', async () => {
  let opened = false, generated = false;
  const state = checkpoint('在原页面下完成剩余导入');
  state.originContext = { workspace_id: WORKSPACE, page_id: PAGE };
  await assert.rejects(runAgent({ provider: { async* generate() { generated = true; } }, config: {}, checkpoint: state,
    messages: [{ role: 'system', content: '' }, { role: 'user', content: '继续' }],
    workspace: { open: () => { opened = true; return {}; } }, nativeContext: { workspace_id: WORKSPACE, page_id: SOURCE },
    operationScope: state.operationScope, signal: new AbortController().signal, onText: () => {}
  }), /当前页面或工作区已改变/);
  assert.equal(opened, false); assert.equal(generated, false);
});

test('a verified write returned during stop is checkpointed before cancellation exits the tool loop', async () => {
  const stop = new AbortController();
  let saved, writes = 0;
  const call = { id: 'stop-window-call', type: 'function', function: { name: 'create_database_entry', arguments: JSON.stringify({ data_source_id: SOURCE, properties: { 词汇: '只写一次' } }) } };
  const provider = { async* generate({ onToolCalls }) { onToolCalls([call]); } };
  const workspace = { open: () => ({ definitions: [{ type: 'function', function: { name: 'create_database_entry' } }], execute: async () => {
    writes++; stop.abort();
    return { verified: true, operation_id: 'synthetic-verified-operation', page_id: PAGE, data_source_id: SOURCE };
  } }) };
  await assert.rejects(runAgent({ provider, config: { multiAgent: false }, messages: [{ role: 'system', content: '' }, { role: 'user', content: '完成合成导入' }], workspace,
    operationScope: 'stop-window', signal: stop.signal, onText: () => {}, onCheckpoint: value => { saved = value; }
  }), { name: 'AbortError' });
  assert.equal(writes, 1);
  assert.equal(saved.receipts.filter(r => r.verified).length, 1);
  assert.equal(saved.pending.length, 0);
  assert.equal(saved.uncertainWrite, false);
});

test('uncertain recovery exposes only read tools and rejects an unsolicited write before dispatch', async () => {
  let writes = 0;
  const state = checkpoint('继续剩余合成导入');
  state.receipts.push(receipt('create_database_entry', { data_source_id: SOURCE }, { error: '此前结果未确定' }));
  state.uncertainWrite = true;
  const workspace = { open: () => ({ definitions: [{ type: 'function', function: { name: 'read_page' } }, { type: 'function', function: { name: 'create_database_entry' } }], execute: async () => { writes++; return { verified: true }; } }) };
  const provider = { async* generate({ tools, onToolCalls }) {
    assert.equal(tools.some(t => t.function.name === 'create_database_entry'), false);
    onToolCalls([{ id: 'must-not-write', type: 'function', function: { name: 'create_database_entry', arguments: '{}' } }]);
  } };
  await assert.rejects(runAgent({ provider, config: { multiAgent: false }, checkpoint: state, messages: [{ role: 'system', content: '' }, { role: 'user', content: '继续' }], workspace,
    operationScope: state.operationScope, signal: new AbortController().signal, onText: () => {}
  }), /未启用的工具/);
  assert.equal(writes, 0); assert.notEqual(state.completed, true);
});
