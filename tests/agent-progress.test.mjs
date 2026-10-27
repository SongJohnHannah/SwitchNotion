import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runAgent } = require('../src/agent-runtime.cjs');
const { compact, checkpointData, receipt, contextTokens, estimateTokens } = require('../src/agent-context.cjs');
const { readPayload, progressPage } = require('../src/agent-progress.cjs');
const { ProviderRouter } = require('../src/provider.cjs');
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const messages = task => [{ role: 'system', content: '' }, { role: 'user', content: task }];
const defs = names => names.map(name => ({ function: { name } }));
const state = () => ({ version: 1, receipts: [], pending: [], compactions: 0 });

test('repeating an inaccessible read stops without sending a second request', async () => {
  let reads = 0, rounds = 0;
  const provider = { async* generate({ onToolCalls }) { onToolCalls([call('read-' + ++rounds, 'read_page', { page_id: 'missing' })]); } };
  const workspace = { open: () => ({ definitions: defs(['read_page']), execute: async () => {
    reads++; const error = Error('Notion API 返回 HTTP 404，请检查页面授权。'); error.status = 404; throw error;
  } }) };
  await assert.rejects(runAgent({ provider, config: { multiAgent: false }, messages: messages('读取目标'), workspace, signal: new AbortController().signal, onText: () => {} }), /停止重复读取/);
  assert.equal(reads, 1); assert.equal(rounds, 2);
});

test('repeated reads reach Notion but duplicate large bodies are not sent to the model again', async () => {
  let generations = 0, reads = 0;
  const payload = 'large unchanged content '.repeat(8000);
  const provider = { async* generate({ messages, onToolCalls }) {
    if (generations++ < 10) onToolCalls([call('read-' + generations, 'read_page', { page_id: 'fixture' })]);
    else {
      const results = messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
      assert.equal(results.filter(r => r.markdown === payload).length, 1);
      assert.equal(results.filter(r => r.unchanged).length, 9);
      for (const result of results.filter(r => r.unchanged)) assert.equal(result.same_result_as_tool_call_id, 'read-1');
      yield '已核对。';
    }
  } };
  await runAgent({ provider, config: { multiAgent: false }, messages: messages('只读合成核对'), workspace: { open: () => ({ definitions: defs(['read_page']), execute: async () => ({ page_id: 'fixture', revision: 'unchanged', markdown: payload, request_id: 'fresh-' + ++reads }) }) }, signal: new AbortController().signal, onText: () => {} });
  assert.equal(reads, 10);
});

test('read references never point to a result discarded by compaction or conceal a changed revision', () => {
  const cache = new Map(), history = [];
  const args = { page_id: 'fixture' }, result = { page_id: 'fixture', revision: 'v1', markdown: 'full body' };
  assert.equal(readPayload(history, cache, 'read_page', args, result, 'first').markdown, 'full body');
  history.push({ role: 'tool', tool_call_id: 'first', content: JSON.stringify(result) });
  assert.equal(readPayload(history, cache, 'read_page', args, result, 'second').unchanged, true);
  history.length = 0;
  assert.equal(readPayload(history, cache, 'read_page', args, result, 'third').markdown, 'full body');
  history.push({ role: 'tool', tool_call_id: 'third', content: JSON.stringify(result) });
  assert.equal(readPayload(history, cache, 'read_page', args, { ...result, revision: 'v2' }, 'fourth').revision, 'v2');
});

test('verified writes are not resubmitted through current-page, workspace or UUID aliases', async () => {
  const page = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', space = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let rounds = 0, writes = 0, saved;
  const steps = [];
  const provider = { async* generate({ onToolCalls }) {
    const args = { revision: 'v1', content: '只追加一次', page_id: rounds ? page.replaceAll('-', '').toUpperCase() : 'current', ...(rounds ? { workspace_id: 'current' } : {}) };
    if (rounds++ < 2) onToolCalls([call('write-' + rounds, 'append_page', args)]); else yield '已完成。';
  } };
  await runAgent({ provider, config: { multiAgent: false }, messages: messages('合成追加任务'), nativeContext: { page_id: page, workspace_id: space }, workspace: { open: () => ({ definitions: defs(['append_page']), execute: async () => { writes++; return { page_id: page, workspace_id: space, verified: true, revision: 'v2' }; } }) }, signal: new AbortController().signal, onText: () => {}, onCheckpoint: value => { saved = value; }, onStep: value => steps.push(value) });
  assert.equal(writes, 1); assert.equal(saved.receipts.length, 1);
  assert.equal(steps.filter(s => s.verified === true).length, 1);
  assert.ok(steps.some(s => s.duplicate === true));
});

test('stop at a saved continuation boundary does not dispatch the next pending write', async () => {
  const stop = new AbortController(); let rounds = 0, writes = 0, saved;
  const provider = { async* generate({ onToolCalls }) { onToolCalls(Array.from({ length: 99 }, (_, i) => call('c-' + rounds + '-' + i, 'create_database_entry', { properties: { name: rounds * 99 + i } }))); rounds++; } };
  await assert.rejects(runAgent({ provider, config: { multiAgent: false }, messages: messages('合成导入'), operationScope: 'stop-boundary', workspace: { open: () => ({ definitions: defs(['create_database_entry']), execute: async () => ({ verified: true, page_id: 'created-' + ++writes }) }) }, signal: stop.signal, onText: () => {}, onCheckpoint: value => { saved = value; }, onStep: step => { if (step.name === 'task_continuation') stop.abort(); } }), { name: 'AbortError' });
  assert.equal(writes, 256); assert.equal(saved.receipts.length, 256); assert.equal(saved.pending.length, 41);
  assert.equal(saved.operationScope, 'stop-boundary'); assert.equal(saved.completed, false);
});

test('network errors and uncertain mutations never cause an automatic task replay', async () => {
  let generations = 0, writes = 0, saved;
  const provider = { async* generate({ onToolCalls }) {
    if (generations++ === 0) onToolCalls([call('write', 'create_page', { title: 'fixture' })]);
    else throw Error('DeepSeek 连接失败');
  } };
  await assert.rejects(runAgent({ provider, config: { multiAgent: false }, messages: messages('合成创建'), workspace: { open: () => ({ definitions: defs(['create_page']), execute: async () => { writes++; throw Error('Notion API 写入结果未确定。'); } }) }, signal: new AbortController().signal, onText: () => {}, onCheckpoint: value => { saved = value; } }), /连接失败/);
  assert.equal(writes, 1); assert.equal(generations, 2); assert.equal(saved.uncertainWrite, true);
});

test('large ledgers stay on disk/checkpoint and older completed items remain available through pagination', () => {
  const checkpoint = state();
  checkpoint.receipts = Array.from({ length: 1000 }, (_, i) => receipt('create_page', { title: 'fixture-' + i }, { page_id: 'page-' + i, verified: true }));
  const data = checkpointData(checkpoint);
  assert.equal(data.verified_writes, 1000); assert.ok(data.omitted_receipts >= 872); assert.ok(JSON.stringify(data.receipts).length < 60000);
  const first = progressPage(checkpoint, { offset: 0, limit: 2 });
  assert.equal(first.receipts[0].result.page_id, 'page-0'); assert.equal(first.has_more, true); assert.equal(first.next_offset, 2);
  assert.throws(() => progressPage(checkpoint, { limit: 1000 }));
  assert.equal(checkpoint.receipts.length, 1000);
});

test('provider usage is based on the actual input and image base64 is not counted as text tokens', async () => {
  let usage;
  const provider = new ProviderRouter({ root: '.', fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream_options.include_usage, true);
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12345, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n');
  } }); provider.key = () => 'fixture';
  for await (const _ of provider.generate({ config: { model: 'deepseek-flash' }, messages: [], signal: new AbortController().signal, onUsage: value => { usage = value; } })) {}
  assert.deepEqual(usage, { prompt_tokens: 12345, completion_tokens: 10 });
  const input = messages('large '.repeat(100000)), units = estimateTokens([input, []]);
  assert.equal(contextTokens(input, { contextUsage: { promptTokens: 100000, units } }), 100000);
  const checkpoint = state(); checkpoint.contextUsage = { promptTokens: 100000, units };
  assert.equal(compact(input, checkpoint), null);
  assert.equal(estimateTokens({ image_url: { url: 'data:image/png;base64,' + 'A'.repeat(1000000) } }) < 9000, true);
});

test('semantic handoff retains remaining work while verified receipts stay authoritative and summary stays invisible', async () => {
  let rounds = 0, summaryCalls = 0, saved, answer = '';
  const provider = {
    async summarize({ messages: input }) { summaryCalls++; assert.ok(JSON.stringify(input).includes('FIELD-MAPPING-FIXTURE')); return '字段映射 FIELD-MAPPING-FIXTURE 已确定；只剩核对末尾 3 项。'; },
    async* generate({ messages: input, onToolCalls }) {
      if (rounds++ < 2) onToolCalls([call('read-' + rounds, 'read_page', { page_id: 'fixture-' + rounds })]);
      else { assert.ok(JSON.stringify(input).includes('只剩核对末尾 3 项')); yield '已核对剩余项。'; }
    }
  };
  await runAgent({ provider, config: { multiAgent: false }, messages: messages('合成资料核对'), workspace: { open: () => ({ definitions: defs(['read_page']), execute: async (_name, args) => ({ page_id: args.page_id, markdown: 'FIELD-MAPPING-FIXTURE ' + '资料'.repeat(100000) }) }) }, signal: new AbortController().signal, onText: text => { answer += text; }, onCheckpoint: value => { saved = value; } });
  assert.equal(summaryCalls, 1); assert.equal(saved.compactions, 1); assert.ok(saved.taskSummary.includes('末尾 3 项'));
  assert.equal(answer.includes('FIELD-MAPPING'), false); assert.equal(answer.includes('压缩'), false);
});

test('a failed background summary falls back to receipts and never retries a completed mutation', async () => {
  let rounds = 0, writes = 0, summaries = 0;
  const provider = { async summarize() { summaries++; throw Error('DeepSeek temporary failure'); }, async* generate({ onToolCalls }) { if (rounds++ === 0) onToolCalls([call('write', 'create_page', { title: 'fixture' })]); else yield '已完成。'; } };
  await runAgent({ provider, config: { multiAgent: false }, messages: messages('合成创建'), workspace: { open: () => ({ definitions: defs(['create_page']), execute: async () => { writes++; return { page_id: 'created', verified: true, markdown: '资料'.repeat(150000) }; } }) }, signal: new AbortController().signal, onText: () => {} });
  assert.equal(summaries, 1); assert.equal(writes, 1); assert.equal(rounds, 2);
});

test('repeated identical facts cannot cause an unbounded automatic continuation loop', async () => {
  let rounds = 0;
  const provider = { async* generate({ onToolCalls }) { onToolCalls([call('read-' + ++rounds, 'read_page', { page_id: 'same' })]); } };
  await assert.rejects(runAgent({ provider, config: { multiAgent: false }, messages: messages('合成只读'), workspace: { open: () => ({ definitions: defs(['read_page']), execute: async () => ({ page_id: 'same', revision: 'same', markdown: 'same' }) }) }, signal: new AbortController().signal, onText: () => {} }), /未获得新内容/);
  assert.equal(rounds, 65);
});

test('a single huge unchanged tool result cannot cause an endless compact-reread loop', async () => {
  let rounds = 0;
  const provider = { async* generate({ onToolCalls }) { onToolCalls([call('read-' + ++rounds, 'read_page', { page_id: 'same' })]); } };
  await assert.rejects(runAgent({ provider, config: { multiAgent: false }, messages: messages('合成只读'), workspace: { open: () => ({ definitions: defs(['read_page']), execute: async () => ({ page_id: 'same', revision: 'same', markdown: '资料'.repeat(150000) }) }) }, signal: new AbortController().signal, onText: () => {} }), /停止压缩循环/);
  assert.equal(rounds, 3);
});

test('compaction never retains a duplicate-result pointer without its original body', () => {
  const checkpoint = state(), input = messages('合成核对');
  for (let i = 0; i < 4; i++) input.push({ role: 'assistant', content: '', tool_calls: [call('read-' + i, 'read_page', {})] }, { role: 'tool', tool_call_id: 'read-' + i, content: JSON.stringify(i ? { unchanged: true, same_result_as_tool_call_id: 'read-0' } : { page_id: 'fixture', markdown: 'original complete body' }) });
  compact(input, checkpoint, { force: true });
  assert.equal(JSON.stringify(input).includes('same_result_as_tool_call_id'), false);
  assert.equal(JSON.stringify(input).includes('original complete body'), true);
});

test('the real summary adapter makes a bounded text-only request with no action tools or private reasoning', async () => {
  const provider = new ProviderRouter({ root: '.', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 8192); assert.equal(body.thinking.type, 'disabled');
    assert.equal(body.tools, undefined); assert.equal(options.body.includes('private-reasoning-fixture'), false);
    assert.equal(options.body.includes('base64-fixture'), false);
    assert.ok(body.messages[1].content.includes('remaining-task-fixture'));
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '剩余任务摘要。' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } }); provider.key = () => 'fixture';
  const summary = await provider.summarize({ config: { model: 'deepseek-flash', thinking: 'enabled' }, messages: [{ role: 'system', content: 'system' }, { role: 'user', content: [{ type: 'text', text: 'remaining-task-fixture' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,base64-fixture' } }] }, { role: 'assistant', content: '', reasoning_content: 'private-reasoning-fixture' }], signal: new AbortController().signal });
  assert.equal(summary, '剩余任务摘要。');
});
