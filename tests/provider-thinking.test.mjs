import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ProviderRouter } = require('../src/provider.cjs');
const { runAgent } = require('../src/agent-runtime.cjs');
const { SettingsService } = require('../src/settings-service.cjs');
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
