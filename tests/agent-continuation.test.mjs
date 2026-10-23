import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { runAgent } = require('../src/agent-runtime.cjs');
const { compact } = require('../src/agent-context.cjs');
const { AgentMock } = require('../src/agent-mock.cjs');
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('42 verified writes survive the 32-round boundary and the same task automatically finishes', async () => {
  let generations = 0, writes = 0, opens = 0, state;
  const steps = [];
  const provider = { async* generate({ onToolCalls }) {
    const round = generations++;
    if (!round) onToolCalls(Array.from({ length: 42 }, (_, index) => call('write-' + index, 'create_database_entry', { data_source_id: 'fixture-source', properties: { term: 'term-' + index } })));
    else if (round <= 34) onToolCalls([call('read-' + round, 'read_page', { page_id: 'page-' + round })]);
    else yield '所有剩余核对已完成。';
  } };
  const workspace = { open: options => { opens++; assert.equal(options.operationScope, 'same-task'); return { definitions: ['create_database_entry', 'read_page'].map(name => ({ function: { name } })), execute: async (name, args) => name === 'read_page' ? { page_id: args.page_id, markdown: args.page_id } : { page_id: 'created-' + ++writes, verified: true, operation_id: 'operation-' + writes } }; } };
  await runAgent({ provider, config: { multiAgent: false }, workspace, operationScope: 'same-task', messages: [{ role: 'system', content: '' }, { role: 'user', content: '合成任务：录入 42 条后完成剩余核对。' }], signal: new AbortController().signal, onText: () => {}, onStep: step => steps.push(step), onCheckpoint: value => { state = value; } });
  assert.equal(writes, 42); assert.equal(generations, 36); assert.equal(opens, 1);
  assert.equal(state.receipts.filter(r => r.verified).length, 42); assert.equal(state.completed, true);
  assert.ok(steps.some(step => step.name === 'task_continuation' && step.reason === 'round_budget'));
});

test('a complete pending tool plan crosses the 256-operation boundary once without regenerating or replaying writes', async () => {
  let generations = 0, writes = 0, state;
  const checkpoints = [];
  const provider = { async* generate({ onToolCalls }) {
    const round = generations++;
    if (round === 3) { yield '297 条已完成。'; return; }
    onToolCalls(Array.from({ length: 99 }, (_, index) => { const id = round * 99 + index; return call('call-' + id, 'create_database_entry', { data_source_id: 'source', properties: { term: 'term-' + id } }); }));
  } };
  const workspace = { open: () => ({ definitions: [{ function: { name: 'create_database_entry' } }], execute: async () => ({ verified: true, page_id: 'entry-' + ++writes, operation_id: 'op-' + writes }) }) };
  await runAgent({ provider, config: { multiAgent: false }, workspace, operationScope: 'long-tool-plan', messages: [{ role: 'system', content: '' }, { role: 'user', content: '合成导入 297 条不同记录。' }], signal: new AbortController().signal, onText: () => {}, onCheckpoint: value => { state = value; checkpoints.push({ completed: value.receipts.length, pending: value.pending.length }); } });
  assert.equal(writes, 297); assert.equal(generations, 4); assert.equal(state.completed, true);
  assert.ok(checkpoints.some(value => value.completed === 256 && value.pending === 41));
});

test('an irreducible user prompt above the old trigger does not compact on every small following tool result', () => {
  const task = '原始约束'.repeat(80000), state = { version: 1, task, receipts: [], pending: [], compactions: 0 };
  const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: task }, { role: 'assistant', content: '', tool_calls: [call('big-read', 'read_page', {})] }, { role: 'tool', tool_call_id: 'big-read', content: JSON.stringify({ page_id: 'source', markdown: 'body '.repeat(6000) }) }];
  assert.ok(compact(messages, state, { force: true }));
  messages.push({ role: 'assistant', content: '', tool_calls: [call('tiny-read', 'read_page', {})] }, { role: 'tool', tool_call_id: 'tiny-read', content: '{"page_id":"target"}' });
  assert.equal(compact(messages, state), null);
  assert.equal(state.compactions, 1);
});

test('automatic compaction does not add repeated housekeeping notices to the visible conversation', async () => {
  let rounds = 0, answer = '';
  const provider = { async* generate({ onToolCalls }) { if (rounds++ < 3) onToolCalls([call('read-' + rounds, 'read_page', { page_id: 'source-' + rounds })]); else yield '已完成。'; } };
  let compactions = 0;
  await runAgent({ provider, config: { multiAgent: false }, messages: [{ role: 'system', content: '' }, { role: 'user', content: '原始约束'.repeat(40000) }], workspace: { open: () => ({ definitions: [{ function: { name: 'read_page' } }], execute: async (_name, args) => ({ page_id: args.page_id, markdown: '新资料'.repeat(50000) }) }) }, signal: new AbortController().signal, onStep: step => { if (step.name === 'context_compaction') compactions++; }, onText: text => { answer += text; } });
  assert.ok(compactions > 0);
  assert.equal(answer.includes('压缩'), false); assert.ok(answer.includes('已完成。'));
});

test('native conversation stays in one user turn and assistant response across automatic round continuation', async () => {
  let rounds = 0;
  const provider = { config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate({ onToolCalls }) {
    if (rounds++ < 34) onToolCalls([call('native-read-' + rounds, 'read_page', { page_id: 'fixture-' + rounds })]);
    else yield '已完成剩余核对。';
  } };
  const agent = new AgentMock({ provider, workspace: { open: () => ({ definitions: [{ function: { name: 'read_page' } }], execute: async (_name, args) => ({ page_id: args.page_id }) }) } });
  agent.create({ threadId: 'fixture-auto-continue', content: [{ type: 'text', text: '合成只读核对任务' }] });
  for (let i = 0; i < 100 && !agent.status().completed; i++) await sleep(5);
  const thread = agent.threads.get('fixture-auto-continue');
  assert.equal(agent.status().failed, 0); assert.equal(agent.status().completed, 1); assert.equal(thread.turns.length, 1);
  assert.equal([...thread.entities.values()].filter(e => e.kind === 'user_message').length, 1);
  assert.equal([...thread.entities.values()].filter(e => e.kind === 'assistant_message').length, 1);
  assert.ok(thread.agentCheckpoint.execution.continuations >= 1);
});
