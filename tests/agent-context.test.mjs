import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runAgent } = require('../src/agent-runtime.cjs');

test('context compacts automatically after 96 verified writes and continues without replaying any write', async () => {
  let writes = 0, rounds = 0, answer = '', checkpoint;
  const steps = [];
  const workspace = { open: () => ({
    definitions: [{ type: 'function', function: { name: 'create_database_entry' } }],
    execute: async (_name, args) => ({ verified: true, page_id: 'entry-' + ++writes, data_source_id: 'vocabulary-source', properties: { term: args.term, explanation: '释义'.repeat(3000) }, url: 'https://www.notion.so/entry-' + writes })
  }) };
  const provider = { async* generate({ messages, onToolCalls }) {
    if (rounds++ === 0) {
      onToolCalls(Array.from({ length: 96 }, (_, index) => ({ id: 'entry-call-' + index, type: 'function', function: { name: 'create_database_entry', arguments: JSON.stringify({ data_source_id: 'vocabulary-source', term: '术语-' + index }) } })));
      return;
    }
    assert.ok(JSON.stringify(messages).length < 200000);
    const state = JSON.stringify(messages);
    assert.ok(state.includes('entry-1') && state.includes('entry-96'));
    assert.ok(state.includes('vocabulary-source'));
    yield '96 条已完成，只继续剩余工作。';
  } };
  await runAgent({ provider, config: {}, messages: [{ role: 'system', content: '' }, { role: 'user', content: '把指定页面的全部词汇导入数据库，保留已经写入的条目。' }], workspace, signal: new AbortController().signal,
    onText: delta => { answer += delta; }, onStep: step => steps.push(step), onCheckpoint: value => { checkpoint = value; } });
  assert.equal(writes, 96); assert.equal(rounds, 2);
  assert.ok(answer.includes('96 条已完成'));
  assert.ok(steps.some(step => step.name === 'context_compaction' && step.state === 'completed'));
  assert.equal(checkpoint.receipts.filter(receipt => receipt.verified).length, 96);
});

test('a remote context rejection compacts only the undispatched generation and never replays a write', async () => {
  let generations = 0, writes = 0;
  const provider = { async* generate({ onToolCalls }) {
    if (generations++ === 0) { onToolCalls([{ id: 'remote-context-write', type: 'function', function: { name: 'create_database_entry', arguments: '{"term":"once"}' } }]); return; }
    if (generations === 2) { const error = Error('DeepSeek context limit'); error.code = 'CONTEXT_LENGTH'; throw error; }
    yield '继续完成。';
  } };
  await runAgent({ provider, config: { multiAgent: false }, messages: [{ role: 'system', content: '' }, { role: 'user', content: '合成写入任务' }], workspace: { open: () => ({ definitions: [{ function: { name: 'create_database_entry' } }], execute: async () => { writes++; return { page_id: 'created-once', verified: true, properties: { explanation: 'long result '.repeat(4000) } }; } }) }, signal: new AbortController().signal, onText: () => {} });
  assert.equal(generations, 3); assert.equal(writes, 1);
});
