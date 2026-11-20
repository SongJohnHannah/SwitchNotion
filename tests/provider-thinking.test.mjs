import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { ProviderRouter } = require('../src/provider.cjs');
const { runAgent } = require('../src/agent-runtime.cjs');
const { SettingsService } = require('../src/settings-service.cjs');
const { AgentMock } = require('../src/agent-mock.cjs');
const { models } = require('../src/native-models.cjs');
const sse = (delta, finish_reason) => new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\ndata: [DONE]\n\n');

test('thinking is enabled in API requests, retains reasoning across tool turns, and keeps it out of the native answer', async () => {
  let round = 0, answer = '';
  const provider = new ProviderRouter({ root: '.', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.thinking.type, 'enabled'); assert.equal(body.reasoning_effort, 'high');
    assert.equal(Object.hasOwn(body, 'tool_choice'), false);
    if (round++ === 0) return sse({ reasoning_content: 'private-fixture-reasoning', tool_calls: [{ index: 0, id: 'read-1', function: { name: 'read_page_info', arguments: '{"page_id":"fixture"}' } }] }, 'tool_calls');
    const previous = body.messages.find(m => m.tool_calls);
    assert.equal(previous.reasoning_content, 'private-fixture-reasoning'); assert.equal(previous.content, '');
    return sse({ reasoning_content: 'private-fixture-final-reasoning', content: '已确认页面信息。' }, 'stop');
  } });
  provider.key = () => 'fixture-key';
  await runAgent({ provider, config: { thinking: 'enabled', reasoningEffort: 'high', model: 'deepseek-flash', multiAgent: false }, messages: [{ role: 'system', content: '' }, { role: 'user', content: '只读检查指定页' }], workspace: { open: () => ({ definitions: [{ type: 'function', function: { name: 'read_page_info' } }], execute: async () => ({ page_id: 'fixture', title: 'fixture' }) }) }, signal: new AbortController().signal, onText: delta => { answer += delta; } });
  assert.equal(round, 2); assert.ok(answer.includes('已确认页面信息'));
  assert.equal(answer.includes('private-fixture'), false);
  assert.equal(JSON.stringify(provider.lastGeneration).includes('private-fixture'), false);
});

test('GUI persists thinking effort and collaboration choice while preserving the existing API key', async t => {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch');
  const root = fs.mkdtempSync(path.join(parent, 'test-thinking-settings-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'deepseek-api-key.txt'), 'fixture-key');
  fs.writeFileSync(path.join(root, 'provider.local.json'), JSON.stringify({ mode: 'deepseek', model: 'deepseek-flash', keySource: 'local' }));
  fs.writeFileSync(path.join(root, 'notion-connections.local.json'), JSON.stringify({ version: 2, connections: [] }));
  const service = new SettingsService({ root, fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] })) });
  assert.equal((await service.state()).deepseek.multiAgent, true);
  const saved = await service.request('deepseek.save', { model: 'deepseek-flash', apiKey: '', thinking: 'enabled', reasoningEffort: 'max', multiAgent: 'disabled' });
  assert.equal(saved.ok, true);
  const state = await service.state();
  assert.equal(state.deepseek.thinking, true); assert.equal(state.deepseek.reasoningEffort, 'max'); assert.equal(state.deepseek.multiAgent, false);
  assert.equal(JSON.stringify(state).includes('fixture-key'), false);
  assert.equal(fs.readFileSync(path.join(root, 'deepseek-api-key.txt'), 'utf8') === 'fixture-key', true);
  const invalid = await service.request('deepseek.save', { model: 'deepseek-flash', thinking: 'arbitrary', reasoningEffort: 'high' });
  assert.equal(invalid.ok, false); assert.equal((await service.state()).deepseek.thinking, true);
});

test('configuration and menu writes share one thinking value across native chat requests', async t => {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch');
  const root = fs.mkdtempSync(path.join(parent, 'test-shared-thinking-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'provider.local.json'), JSON.stringify({ mode: 'deepseek', model: 'deepseek-flash', thinking: 'enabled', reasoningEffort: 'high', multiAgent: false, keySource: 'local' }));
  fs.writeFileSync(path.join(root, 'deepseek-api-key.txt'), 'fixture-key');
  const bodies = [];
  const provider = new ProviderRouter({ root, fetchImpl: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return sse({ content: '完成' }, 'stop');
  } });
  const settings = new SettingsService({ root, fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] })) });
  const agent = new AgentMock({ provider });
  const threadId = randomUUID(), spaceId = randomUUID(), meta = { userId: randomUUID() };
  const content = [{ type: 'text', text: '合成侧栏消息' }];
  async function complete(id) {
    const t = agent.find({ threadId: id });
    for (let n = 0; n < 100 && t.session.status !== 'idle'; n++) await delay(5);
    assert.equal(t.turns.at(-1).status, 'completed');
  }
  assert.equal(agent.create({ threadId, spaceId, type: 'personal_agent', content, reasoningEffort: 'max' }, meta).status, 200);
  await complete(threadId);
  const send = extra => agent.send({ threadId, spaceId, event: { type: 'user.message', content }, ...extra }, meta);
  assert.deepEqual(await settings.request('deepseek.thinking.save', { effort: 'none' }), { ok: true, result: { thinking: false, reasoningEffort: 'high' } });
  assert.equal(send({ modelSelection: { type: 'explicit', model: models[1].nativeId }, reasoningEffort: 'max' }).status, 200);
  await complete(threadId);
  assert.equal((await settings.request('deepseek.save', { model: 'deepseek-flash', thinking: 'enabled', reasoningEffort: 'low', multiAgent: 'disabled' })).ok, true);
  assert.deepEqual(await settings.request('deepseek.thinking'), { ok: true, result: { thinking: true, reasoningEffort: 'low' } });
  assert.equal(send({ reasoningEffort: 'none' }).status, 200);
  await complete(threadId);
  const calendarThread = randomUUID();
  assert.equal(agent.create({ threadId: calendarThread, spaceId, type: 'calendar_agent', content, reasoningEffort: 'max' }, meta).status, 200);
  await complete(calendarThread);
  assert.deepEqual(bodies.map(b => [b.model, b.thinking.type, b.reasoning_effort]), [
    ['deepseek-flash', 'enabled', 'high'], ['deepseek-v4-pro', 'disabled', undefined],
    ['deepseek-v4-pro', 'enabled', 'low'], ['deepseek-flash', 'enabled', 'low']
  ]);
});

test('child output ceilings do not expand to the main-model maximum after length termination', async () => {
  let requests = 0, dispatched = false;
  const provider = new ProviderRouter({ root: '.', fetchImpl: async (_url, options) => {
    requests++; assert.equal(JSON.parse(options.body).max_tokens, 16384);
    return sse({ tool_calls: [{ index: 0, id: 'child', function: { name: 'read_page', arguments: '{' } }] }, 'length');
  } });
  provider.key = () => 'fixture-key';
  await assert.rejects(async () => { for await (const _ of provider.generate({ config: { model: 'deepseek-flash', maxTokens: 16384, allowOutputExpansion: false }, messages: [], tools: [{ function: { name: 'read_page' } }], signal: new AbortController().signal, onToolCalls: () => { dispatched = true; } })) {} }, /未完整结束/);
  assert.equal(requests, 1); assert.equal(dispatched, false);
});
