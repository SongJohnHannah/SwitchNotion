import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const require = createRequire(import.meta.url), { AgentMock } = require('../src/agent-mock.cjs');
const { WebSources } = require('../src/web-sources.cjs'), { runAgent } = require('../src/agent-runtime.cjs');
const { NativeMock, json } = require('../src/native-mock.cjs');
const id = n => 'ac00aa00-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
const settle = async agent => { for (let i = 0; agent.status().active && i < 500; i++) await sleep(2); assert.equal(agent.status().active, 0); };

test('native side chat opens per-turn web tools, reads a source and gives the result to the model', async () => {
  let opened = 0, executed = 0, closed = 0, calls = 0;
  const webSources = { open: async ({ userId, spaceId, content }) => {
    opened++; assert.equal(userId, id(1)); assert.equal(spaceId, id(2)); assert.ok(JSON.stringify(content).includes('https://example.com/'));
    return { definitions: [{ type: 'function', function: { name: 'read_web_page', description: 'Read a synthetic public page', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } }],
      async execute(name, args) { executed++; assert.equal(name, 'read_web_page'); assert.equal(args.url, 'https://example.com/'); return { source: 'public-web', url: args.url, title: '合成公开页', text: '蓝色代码927', complete: true }; }, close() { closed++; } };
  } };
  const provider = { config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate({ messages, tools, onToolCalls }) {
    calls++; assert.ok(tools.some(tool => tool.function.name === 'read_web_page'));
    if (calls === 1) { onToolCalls([{ id: 'synthetic-web-call', type: 'function', function: { name: 'read_web_page', arguments: '{"url":"https://example.com/"}' } }]); return; }
    assert.ok(messages.some(message => message.role === 'tool' && message.content.includes('蓝色代码927'))); yield '依据[合成公开页](https://example.com/)：蓝色代码927';
  } };
  const agent = new AgentMock({ provider, webSources });
  agent.create({ threadId: id(3), spaceId: id(2), content: [{ type: 'text', text: '读取 https://example.com/ 的合成内容' }] }, { userId: id(1) });
  await settle(agent);
  assert.equal(agent.status().failed, 0); assert.equal(opened, 1); assert.equal(executed, 1); assert.equal(closed, 1); assert.equal(calls, 2);
});

test('native follow-up after restart refetches verified web sources without persisting page text or provider keys', async t => {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-web-followup-')), file = path.join(root, 'conversation.json');
  let calls = 0, fetches = 0;
  const webSources = new WebSources({ root, fetchPublic: async url => {
    fetches++; return { url, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>not-persisted-web-body-' + fetches + '</main>') };
  } });
  webSources.save({ enabled: 'enabled' });
  const provider = { config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate({ messages, onToolCalls }) {
    calls++; if (!messages.some(value => value.role === 'tool')) { onToolCalls([{ id: 'read-' + calls, type: 'function', function: { name: 'read_web_page', arguments: '{"url":"https://example.com/article"}' } }]); return; }
    const tool = JSON.parse(messages.findLast(value => value.role === 'tool').content); assert.ok(tool.text.includes('not-persisted-web-body-')); yield '[已核对网页](https://example.com/article)';
  } };
  let agent = new AgentMock({ provider, webSources, stateFile: file });
  t.after(() => { for (const item of agent.threads.values()) item.stop?.('cleanup'); clearTimeout(agent.saveTimer); webSources.close(); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  agent.create({ threadId: id(3), spaceId: id(2), content: [{ type: 'text', text: '读取 https://example.com/article' }] }, { userId: id(1) }); await settle(agent);
  assert.equal(agent.status().failed, 0); assert.equal(fetches, 1); assert.equal(webSources.sessions.size, 0);
  const saved = fs.readFileSync(file, 'utf8'); assert.ok(!saved.includes('not-persisted-web-body-')); assert.ok(saved.includes('webSourcePointers'));
  agent = new AgentMock({ provider, webSources, stateFile: file });
  agent.send({ threadId: id(3), event: { type: 'user.message', text: '继续核对刚才的网页' } }, { userId: id(1) }); await settle(agent);
  assert.equal(agent.status().failed, 0); assert.equal(fetches, 2); assert.equal(calls, 4); assert.equal(webSources.sessions.size, 0);
});

test('read-only collaborators can use web-only sessions and return actual source URLs without a workspace connection', async () => {
  const sources = [], web = { definitions: [{ type: 'function', function: { name: 'read_web_page', parameters: { type: 'object', properties: { url: { type: 'string' } } } } }],
    async execute(name, args) { assert.equal(name, 'read_web_page'); sources.push(args.url); return { source: 'public-web', url: args.url, text: '合成研究资料', complete: true }; } };
  const provider = { async* generate({ messages, tools, onToolCalls }) {
    const tool = messages.findLast(value => value.role === 'tool');
    if (!tool) {
      const delegate = tools.some(value => value.function.name === 'delegate_research');
      onToolCalls([{ id: delegate ? 'delegate' : 'read', type: 'function', function: delegate ? { name: 'delegate_research', arguments: '{"tasks":["核对公开来源甲","核对公开来源乙"]}' } : { name: 'read_web_page', arguments: '{"url":"https://example.com/article"}' } }]); return;
    }
    const result = JSON.parse(tool.content);
    if (result.agents) { assert.equal(result.agents.length, 2); assert.ok(result.agents.every(value => value.sources.includes('https://example.com/article'))); yield '两份合成来源已核对'; }
    else yield '合成资料分析';
  } };
  let answer = '';
  await runAgent({ provider, config: {}, web, signal: new AbortController().signal, operationScope: 'web-only-collaboration', messages: [{ role: 'system', content: '' }, { role: 'user', content: '比较两份合成公开来源' }], onText: value => { answer += value; } });
  assert.equal(sources.length, 2); assert.match(answer, /两份合成来源已核对/);
});

test('the actual desktop route uses the web-enabled native mock and rejects a foreign account before a second read', async t => {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-web-desktop-')); let reads = 0, forwarded = 0;
  const webSources = new WebSources({ root, fetchPublic: async url => { reads++; return { url, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>路由合成正文</main>') }; } });
  webSources.save({ enabled: 'enabled' });
  const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate({ messages, onToolCalls }) {
    if (!messages.some(value => value.role === 'tool')) { onToolCalls([{ id: 'read-route', type: 'function', function: { name: 'read_web_page', arguments: '{"url":"https://example.com/article"}' } }]); return; }
    assert.ok(messages.some(value => value.role === 'tool' && value.content.includes('路由合成正文'))); yield '[合成网页](https://example.com/article)';
  } };
  const mock = new NativeMock({ provider, webSources });
  t.after(() => { for (const item of mock.agent.threads.values()) item.stop?.('cleanup'); webSources.close(); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const source = fs.readFileSync(new URL('../src/desktop-hook.cjs', import.meta.url), 'utf8');
  const context = { Request, Response, Headers, URL, mock, provider, json, settings: { speech: { enabled: false }, isLoginSyncing: () => false },
    nativeSpeech: { enabled: false }, meetingBridge: { observe() {} }, recordings: { wake() {} }, createNativeImageAdapter: () => ({}),
    isNotion: host => host === 'app.notion.com', log() {}, localUploadPrefix: '/notion-switch-local-upload/', endpoints: new Set(['createAgentThread', 'sendEventToAgentThread']) };
  const route = vm.runInNewContext(source.slice(source.indexOf('async function route('), source.indexOf('\nfunction install(ses)')) + '\nroute', context);
  const call = (endpoint, input, user = id(1)) => route(new Request('https://app.notion.com/api/v3/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-notion-active-user-header': user }, body: JSON.stringify(input) }), () => { forwarded++; return json({ remote: true }); });
  assert.equal((await call('createAgentThread', { type: 'personal_agent', threadId: id(3), spaceId: id(2), content: [{ type: 'text', text: '读取 https://example.com/article' }] })).status, 200);
  await settle(mock.agent); assert.equal(mock.agent.status().failed, 0); assert.equal(reads, 1);
  assert.equal((await call('sendEventToAgentThread', { threadId: id(3), event: { type: 'user.message', text: '再读一次' } }, id(9))).status, 403);
  assert.equal(reads, 1); assert.equal(forwarded, 0);
});

test('calendar and custom thread kinds keep network tools disabled on follow-up even if a message claims to be personal', async t => {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-web-thread-kind-'));
  const webSources = new WebSources({ root, fetchPublic: async () => assert.fail('Unsupported thread must not access the web') });
  webSources.save({ enabled: 'enabled', apiKey: 'synthetic-brave-key' }); let calls = 0;
  const provider = { config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate({ tools }) {
    calls++; assert.ok(!tools.some(value => ['search_web', 'read_web_page'].includes(value.function.name))); yield '普通合成对话';
  } };
  const mock = new NativeMock({ provider, webSources });
  t.after(() => { for (const item of mock.agent.threads.values()) item.stop?.('cleanup'); webSources.close(); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  for (const [endpoint, type, threadId] of [['createCalendarAgentThread', undefined, id(31)], ['createAgentThread', 'custom_agent', id(32)]]) {
    await mock.handle(endpoint, { threadId, type, spaceId: id(2), content: [{ type: 'text', text: 'hello' }] }, undefined, { userId: id(1) }); await settle(mock.agent);
    await mock.handle('sendEventToAgentThread', { threadId, type: 'personal_agent', event: { type: 'user.message', text: '继续' } }, undefined, { userId: id(1) }); await settle(mock.agent);
  }
  assert.equal(calls, 4); assert.equal(webSources.sessions.size, 0);
});
