import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { ProviderRouter, MAX_OUTPUT_TOKENS } = require('../src/provider.cjs');
const { AgentMock } = require('../src/agent-mock.cjs');

test('output-limited tool arguments are regenerated completely before a single dispatch', async t => {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch');
  const root = fs.mkdtempSync(path.join(parent, 'test-provider-budget-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const budgets = [], dispatches = [];
  const args = JSON.stringify({ content: 'synthetic content '.repeat(400) });
  const router = new ProviderRouter({ root, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    budgets.push(request.max_tokens);
    const complete = request.max_tokens >= 4096;
    const event = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'budget-call', function: { name: 'append_page', arguments: complete ? args : args.slice(0, 1000) } }] }, finish_reason: complete ? 'tool_calls' : 'length' }] };
    return new Response('data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n');
  } });
  router.key = () => 'fixture-key';
  for await (const _ of router.generate({ config: { model: 'fixture', maxTokens: 1024 }, messages: [{ role: 'user', content: 'append synthetic content' }], signal: new AbortController().signal, tools: [{ type: 'function', function: { name: 'append_page' } }], onToolCalls: calls => dispatches.push(calls) })) {}
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0][0].function.arguments, args);
  assert.equal(budgets[0], 1024);
  assert.ok(budgets.at(-1) >= 4096);
  assert.ok(budgets.length <= 3);
});

test('DeepSeek adapter handles split SSE bytes and sends only provider credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-switch-provider-'));
  try {
    fs.writeFileSync(path.join(dir, 'key.txt'), 'fixture-key');
    let sent;
    const router = new ProviderRouter({ root: dir, fetchImpl: async (url, options) => {
      sent = { url, ...options };
      const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close(); } }));
    } });
    const controller = new AbortController();
    let text = '';
    for await (const delta of router.generate({ config: { apiKeyFile: 'key.txt', model: 'deepseek-flash', maxTokens: 999999 }, messages: [{ role: 'user', content: 'test' }], signal: controller.signal })) text += delta;
    assert.equal(text, '你好');
    assert.equal(sent.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(sent.headers.authorization.startsWith('Bearer '), true);
    assert.equal(Object.keys(sent.headers).length, 2);
    assert.equal(JSON.parse(sent.body).stream, true);
    assert.equal(JSON.parse(sent.body).max_tokens, MAX_OUTPUT_TOKENS);
    assert.equal(router.requests, 1);
  } finally { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const reason of [undefined, 'stop', 'length']) {
  test(`tool calls with ${reason || 'missing'} termination never dispatch partial parameters`, async () => {
    let requests = 0, dispatched = false;
    const router = new ProviderRouter({ root: '', fetchImpl: async () => {
      requests++;
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'fixture', function: { name: 'append_page', arguments: '{"content":"incomplete' } }] }, ...(reason ? { finish_reason: reason } : {}) }] }) + '\n\ndata: [DONE]\n\n');
    } });
    router.key = () => 'fixture-key';
    await assert.rejects(async () => { for await (const _ of router.generate({ config: { model: 'fixture', maxTokens: 8192 }, messages: [], signal: new AbortController().signal, tools: [{ function: { name: 'append_page' } }], onToolCalls: () => { dispatched = true; } })) {} }, /未完整结束/);
    assert.equal(dispatched, false);
    assert.equal(requests, reason === 'length' ? 2 : 1);
    assert.equal(router.lastGeneration.attempts.at(-1).finishReason, reason || 'missing');
  });
}

test('the complete tool batch is checked for valid JSON before any dispatch', async () => {
  let dispatched = false;
  const router = new ProviderRouter({ root: '', fetchImpl: async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'valid', function: { name: 'append_page', arguments: '{"content":"valid"}' } }, { index: 1, id: 'invalid', function: { name: 'append_page', arguments: '{invalid' } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n') });
  router.key = () => 'fixture-key';
  await assert.rejects(async () => { for await (const _ of router.generate({ config: { model: 'fixture' }, messages: [], signal: new AbortController().signal, tools: [{ function: { name: 'append_page' } }], onToolCalls: () => { dispatched = true; } })) {} }, /有效的 JSON/);
  assert.equal(dispatched, false);
});

test('complete streamed plans larger than sixteen calls retain order and dispatch only once', async () => {
  let dispatched = [], count = 0;
  const router = new ProviderRouter({ root: '', fetchImpl: async () => {
    const fragments = Array.from({ length: 24 }, (_, index) => ({ index, id: 'large-' + index, function: { name: 'read_page', arguments: JSON.stringify({ page_id: 'fixture-' + index }) } }));
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: fragments }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
  } });
  router.key = () => 'fixture-key';
  for await (const _ of router.generate({ config: { model: 'fixture' }, messages: [], signal: new AbortController().signal, tools: [{ function: { name: 'read_page' } }], onToolCalls: calls => { count++; dispatched = calls; } })) {}
  assert.equal(count, 1); assert.equal(dispatched.length, 24);
  assert.deepEqual(dispatched.map(call => call.id), Array.from({ length: 24 }, (_, index) => 'large-' + index));
  assert.equal(router.lastGeneration.attempts[0].toolCalls, 24);
});

test('native stop cancels regeneration of truncated arguments without dispatch', async () => {
  const stop = new AbortController();
  let requests = 0, pendingSignal, dispatched = false;
  const router = new ProviderRouter({ root: '', fetchImpl: async (_url, options) => {
    requests++;
    if (requests === 1) return new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'fixture', function: { name: 'append_page', arguments: '{incomplete' } }] }, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n');
    return new Promise((_resolve, reject) => { pendingSignal = options.signal; options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
  } });
  router.key = () => 'fixture-key';
  const generating = (async () => { for await (const _ of router.generate({ config: { model: 'fixture', maxTokens: 8192 }, messages: [], signal: stop.signal, tools: [{ function: { name: 'append_page' } }], onToolCalls: () => { dispatched = true; } })) {} })();
  for (let i = 0; i < 100 && !pendingSignal; i++) await sleep(1);
  assert.ok(pendingSignal);
  stop.abort();
  await assert.rejects(generating, { name: 'AbortError' });
  assert.equal(pendingSignal.aborted, true);
  assert.equal(dispatched, false);
  assert.equal(requests, 2);
});

test('active streaming can continue beyond two minutes and uses the official maximum by default', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stream, request;
  const encoder = new TextEncoder(), event = text => encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
  const router = new ProviderRouter({ root: '', fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(event('first')); } }));
  } });
  router.key = () => 'fixture-key';
  const generator = router.generate({ config: { model: 'fixture' }, messages: [], signal: new AbortController().signal });
  assert.equal((await generator.next()).value, 'first');
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(110000);
    stream.enqueue(event('next'));
    assert.equal((await generator.next()).value, 'next');
  }
  stream.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  stream.close();
  assert.equal((await generator.next()).done, true);
  assert.equal(request.max_tokens, 393216);
});

test('a stalled stream times out without retrying an incomplete tool call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let streamSignal, requests = 0;
  const encoder = new TextEncoder();
  const router = new ProviderRouter({ root: '', fetchImpl: async (_url, options) => {
    requests++; streamSignal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
      streamSignal.addEventListener('abort', () => controller.error(streamSignal.reason), { once: true });
    } }));
  } });
  router.key = () => 'fixture-key';
  const generator = router.generate({ config: { model: 'fixture' }, messages: [], signal: new AbortController().signal });
  assert.equal((await generator.next()).value, 'first');
  const reading = generator.next();
  t.mock.timers.tick(120001);
  await assert.rejects(reading, /长时间没有返回数据/);
  assert.equal(streamSignal.aborted, true);
  assert.equal(requests, 1);
});

test('native stop aborts provider generation and continuation includes the partial answer', async () => {
  const calls = [];
  const provider = { config: () => ({ mode: 'deepseek' }), async* generate(args) {
    calls.push(args);
    yield 'partial';
    await sleep(20);
    if (!args.signal.aborted) yield ' complete';
  } };
  const agent = new AgentMock({ provider });
  const input = { threadId: 'provider-thread', spaceId: 'space', content: [{ type: 'text', text: 'first' }] };
  agent.create(input);
  await sleep(2);
  agent.send({ threadId: input.threadId, event: { type: 'agent.interrupt' } });
  assert.equal(calls[0].signal.aborted, true);
  agent.send({ threadId: input.threadId, event: { type: 'user.message', content: [{ type: 'text', text: 'continue' }] } });
  await sleep(50);
  assert.deepEqual(calls[1].messages.slice(1).map(m => [m.role, m.content]), [['user', 'first'], ['assistant', 'partial'], ['user', 'continue']]);
  assert.equal(agent.status().completed, 1);
  assert.equal(agent.status().stopped, 1);
});

test('provider failures become a native error and release the running state', async () => {
  const agent = new AgentMock({ provider: { config: () => ({ mode: 'deepseek' }), async* generate() { throw Error('DeepSeek API 返回 HTTP 401'); } } });
  const input = { threadId: 'failure-test', content: [{ type: 'text', text: 'test' }] };
  agent.create(input);
  await sleep(5);
  const transcript = await agent.transcript(input).json();
  assert.equal(transcript.session.status, 'idle');
  assert.equal(agent.status().failed, 1);
  assert.ok(transcript.patches.some(p => p.entity.kind === 'error'));
});
