import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ProviderRouter } = require('../src/provider.cjs');
const { runAgent } = require('../src/agent-runtime.cjs');
const tools = [{ function: { name: 'create_page' } }];
const sse = (calls, finish = 'tool_calls', content) => new Response('data: ' + JSON.stringify({ choices: [{ delta: { ...(content ? { content } : {}), ...(calls ? { tool_calls: calls } : {}) }, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n');
const fragment = (id, title, invalid = false) => ({ index: id, id: 'fixture-' + id, function: { name: 'create_page', arguments: invalid ? '{"title":"broken "quote"}' : JSON.stringify({ title }) } });

test('a malformed undispatched tool plan is regenerated once after three verified writes, without replaying them', async () => {
  let requests = 0, answer = '', writes = [], saved;
  const provider = new ProviderRouter({ root: '.', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); requests++;
    if (requests === 1) return sse([fragment(0, 'one'), fragment(1, 'two'), fragment(2, 'three')]);
    if (requests === 2) return sse([fragment(0, 'four', true)], 'tool_calls', '临时失败内容');
    if (requests === 3) { assert.equal(body.messages.filter(m => m.role === 'tool').length, 3); return sse([fragment(0, 'four')]); }
    return sse(null, 'stop', '四项已核验。');
  } }); provider.key = () => 'fixture-key';
  await runAgent({ provider, config: { model: 'fixture', multiAgent: false }, messages: [{ role: 'system', content: '' }, { role: 'user', content: '合成任务：创建四项' }], workspace: { open: () => ({ definitions: tools, execute: async (_name, args) => { writes.push(args.title); return { page_id: args.title, verified: true }; } }) }, signal: new AbortController().signal, onText: delta => { answer += delta; }, onTextReset: count => { if (count) answer = answer.slice(0, -count); }, onCheckpoint: value => { saved = value; } });
  assert.deepEqual(writes, ['one', 'two', 'three', 'four']); assert.equal(requests, 4);
  assert.equal(saved.receipts.length, 4); assert.equal(answer.includes('临时失败内容'), false);
});

test('invalid JSON repair is bounded and never dispatches a partially valid plan', async () => {
  let requests = 0, dispatched = false;
  const provider = new ProviderRouter({ root: '.', fetchImpl: async () => { requests++; return sse([fragment(0, 'valid'), fragment(1, 'invalid', true)]); } }); provider.key = () => 'fixture';
  await assert.rejects(async () => { for await (const _ of provider.generate({ config: { model: 'fixture' }, messages: [], tools, signal: new AbortController().signal, onToolCalls: () => { dispatched = true; } })) {} }, /完整有效的 JSON/);
  assert.equal(requests, 2); assert.equal(dispatched, false);
});
