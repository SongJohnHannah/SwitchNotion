import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { NotionWorkspace, pageId } = require('../src/notion-tools.cjs');
const { ProviderRouter } = require('../src/provider.cjs');
const { AgentMock } = require('../src/agent-mock.cjs');
const { writeTools } = require('../src/notion-capabilities.cjs');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture(t, extra = {}) {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-agent-tools-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'notion-api-key.txt'), 'fixture-notion-token');
  fs.writeFileSync(path.join(root, 'deepseek-api-key.txt'), 'fixture-deepseek-token');
  const pages = new Map([[A, { title: '来源甲', markdown: '跨页计划甲：下周二完成。', truncated: false }], [B, { title: '目标乙', markdown: '状态：待安排', truncated: false }]]);
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.ok(url.startsWith('https://api.notion.com/v1/'));
    assert.equal(options.headers.authorization, 'Bearer fixture-notion-token');
    assert.equal(options.headers['Notion-Version'], '2026-03-11');
    assert.equal(Object.keys(options.headers).length, 3);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method, body, signal: options.signal });
    if (extra.fetch) { const response = await extra.fetch({ url, options, body, pages }); if (response) return response; }
    if (url.endsWith('/search')) {
      let list = [...pages].filter(([, p]) => !body.query || p.title.includes(body.query));
      const offset = Number(body.start_cursor) || 0, rows = list.slice(offset, offset + body.page_size);
      return json({ results: rows.map(([id, p]) => ({ id, object: 'page', properties: { Name: { type: 'title', title: [{ plain_text: p.title }] } } })), has_more: offset + rows.length < list.length, next_cursor: offset + rows.length < list.length ? String(offset + rows.length) : null });
    }
    const id = url.match(/pages\/([^/]+)\/markdown$/)?.[1], page = pages.get(id);
    if (!page) return new Response('private error body fixture-notion-token', { status: 404 });
    if (options.method === 'PATCH') {
      assert.equal(body.allow_async, false);
      if (body.type === 'insert_content') page.markdown += '\n\n' + body.insert_content.content;
      else for (const edit of body.update_content.content_updates) page.markdown = page.markdown.replace(edit.old_str, edit.new_str);
    }
    return json({ object: 'page_markdown', id, markdown: page.markdown, truncated: page.truncated, unknown_block_ids: [] });
  };
  const workspace = new NotionWorkspace({ root, fetchImpl, intervalMs: 0 });
  const loadConfig = workspace.config.bind(workspace);
  workspace.config = () => ({ ...loadConfig(), key: 'fixture-notion-token' });
  return { root, pages, calls, workspace };
}
const waitFor = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(5); } throw Error('fixture timeout'); };

test('content search paginates across authorized pages, including body-only matches', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'notion.local.json'), JSON.stringify({ searchBatchSize: 1 }));
  const session = f.workspace.open();
  const first = await session.execute('search_pages', { query: '跨页', scope: 'content' });
  assert.equal(first.results[0].page_id, A); assert.equal(first.has_more, true); assert.equal(first.complete, false);
  const next = await session.execute('search_pages', { query: '跨页', scope: 'content', start_cursor: first.next_cursor });
  assert.equal(next.scanned, 1); assert.equal(next.results.length, 0); assert.equal(next.has_more, false);
  assert.equal(f.calls.filter(c => c.url.endsWith('/search')).some(c => Object.hasOwn(c.body, 'query')), false);
  assert.equal(pageId('https://www.notion.so/test-' + A.replaceAll('-', '') + '?pvs=4'), A);
  assert.throws(() => pageId('https://example.com/' + A), /Notion/);
});

test('read, exact replacement, append, read-back and local before-image form a complete write cycle', async t => {
  const f = fixture(t), session = f.workspace.open({ operationScope: 'write-test' });
  const before = await session.execute('read_page', { page_id: B });
  const replaced = await session.execute('replace_page_text', { page_id: B, revision: before.revision, old_text: '待安排', new_text: '待安排，周二完成' });
  assert.equal(replaced.verified, true);
  const added = await session.execute('append_page', { page_id: B, revision: replaced.revision, content: '来源：计划甲' });
  assert.equal(added.verified, true); assert.equal(f.workspace.verifiedWrites, 2);
  assert.ok(f.pages.get(B).markdown.includes('周二完成'));
  const records = fs.readdirSync(path.join(f.root, 'write-journal')).map(name => JSON.parse(fs.readFileSync(path.join(f.root, 'write-journal', name), 'utf8')));
  assert.equal(records.length, 2); assert.ok(records.every(r => r.status === 'verified' && r.before && r.result.verified));
});

test('scope restrictions, stale reads, ambiguous old text and incomplete pages prevent writes', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'notion.local.json'), JSON.stringify({ pageIds: [B] }));
  const session = f.workspace.open();
  await assert.rejects(session.execute('read_page', { page_id: A }), /授权范围/);
  const before = await session.execute('read_page', { page_id: B });
  f.pages.get(B).markdown += ' changed by somebody else';
  await assert.rejects(session.execute('append_page', { page_id: B, revision: before.revision, content: 'must not write' }), /已变化/);
  f.pages.get(B).markdown = 'same same';
  const repeated = await session.execute('read_page', { page_id: B });
  await assert.rejects(session.execute('replace_page_text', { page_id: B, revision: repeated.revision, old_text: 'same', new_text: 'different' }), /恰好匹配/);
  f.pages.get(B).truncated = true;
  await assert.rejects(session.execute('append_page', { page_id: B, revision: repeated.revision, content: 'must not write' }), /未加载/);
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 0);
});

test('ambiguous transport failure is not retried and prevents subsequent writes in the same turn', async t => {
  const f = fixture(t, { fetch: ({ options, pages }) => { if (options.method === 'PATCH') { pages.get(B).markdown += '\nMay already be committed'; throw Error('network failed'); } } });
  const session = f.workspace.open();
  const before = await session.execute('read_page', { page_id: B });
  await assert.rejects(session.execute('append_page', { page_id: B, revision: before.revision, content: 'May already be committed' }), /结果未确定/);
  const after = await session.execute('read_page', { page_id: B });
  await assert.rejects(session.execute('append_page', { page_id: B, revision: after.revision, content: 'May already be committed' }), /停止后续写入/);
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(f.root, 'write-journal', fs.readdirSync(path.join(f.root, 'write-journal'))[0]), 'utf8'));
  assert.equal(record.status, 'pending');
});

test('fragmented tool calls drive native cross-page search, read A, read B, append B and verified answer', async t => {
  const f = fixture(t);
  let modelRound = 0;
  const router = new ProviderRouter({ root: f.root, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer fixture-deepseek-token');
    assert.equal(Object.keys(options.headers).length, 2);
    const body = JSON.parse(options.body); assert.ok(body.tools.some(tool => tool.function.name === 'create_database'));
    const previous = body.messages.at(-1).role === 'tool' ? JSON.parse(body.messages.at(-1).content) : null;
    const specs = [ ['search_pages', { query: '跨页', scope: 'content' }], ['read_page', { page_id: A }], ['read_page', { page_id: B }], ['append_page', { page_id: B, revision: previous?.revision, content: '从来源甲整理：下周二完成。' }] ];
    let events;
    if (modelRound < specs.length) {
      const [name, args] = specs[modelRound], serialized = JSON.stringify(args);
      events = [ { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-' + modelRound, function: { name, arguments: serialized.slice(0, 5) } }] } }] }, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: serialized.slice(5) } }] }, finish_reason: 'tool_calls' }] } ];
    } else { assert.equal(previous.verified, true); events = [{ choices: [{ delta: { content: '已根据来源甲更新目标乙，并读回核验。' }, finish_reason: 'stop' }] }]; }
    modelRound++;
    return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n');
  } });
  router.key = () => 'fixture-deepseek-token';
  router.config = () => ({ mode: 'deepseek', model: 'deepseek-flash' });
  const agent = new AgentMock({ provider: router, workspace: f.workspace });
  const input = { threadId: 'native-tools-fixture', spaceId: 'fixture-space', content: [{ type: 'text', text: '搜索来源甲并将日期追加到目标乙' }] };
  agent.create(input);
  await waitFor(() => agent.status().completed + agent.status().failed > 0);
  assert.equal(agent.status().failed, 0); assert.equal(agent.status().completed, 1); assert.equal(modelRound, 5);
  assert.ok(f.pages.get(B).markdown.includes('从来源甲整理：下周二完成。'));
  const transcript = await agent.transcript(input).json();
  const answer = transcript.patches.find(p => p.entity.kind === 'assistant_message').entity.content[0].text;
  assert.ok(answer.includes('修改已读回核验')); assert.ok(answer.includes('已根据来源甲更新目标乙'));
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1);
});

test('native stop aborts an in-flight page read and prevents the next model/tool step', async t => {
  let pendingSignal;
  const f = fixture(t, { fetch: ({ options }) => new Promise((resolve, reject) => { pendingSignal = options.signal; pendingSignal.addEventListener('abort', () => reject(pendingSignal.reason), { once: true }); }) });
  let rounds = 0;
  const provider = { config: () => ({ mode: 'deepseek' }), async* generate({ onToolCalls }) { rounds++; onToolCalls([{ id: 'read', type: 'function', function: { name: 'read_page', arguments: JSON.stringify({ page_id: A }) } }]); } };
  const agent = new AgentMock({ provider, workspace: f.workspace });
  const input = { threadId: 'stop-tools', content: [{ type: 'text', text: 'read page' }] };
  agent.create(input); await waitFor(() => !!pendingSignal);
  agent.send({ threadId: input.threadId, event: { type: 'user.interrupt' } });
  await sleep(10);
  assert.equal(pendingSignal.aborted, true); assert.equal(rounds, 1); assert.equal(agent.status().stopped, 1); assert.equal(agent.status().failed, 0);
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 0);
});

test('native recovery replaces the truncated draft and never replays an earlier verified write', async t => {
  const f = fixture(t), longContent = '合成的长段落。'.repeat(600), budgets = [];
  let phase = 0;
  const router = new ProviderRouter({ root: f.root, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body), previous = body.messages.at(-1).role === 'tool' ? JSON.parse(body.messages.at(-1).content) : {};
    budgets.push(body.max_tokens);
    if (phase === 3) return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '两次修改均已核验。' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    const specs = [['read_page', { page_id: B }], ['append_page', { page_id: B, revision: previous.revision, content: '已完成的第一笔修改' }], ['append_page', { page_id: B, revision: previous.revision, content: longContent }]];
    const [name, args] = specs[phase], truncated = phase === 2 && body.max_tokens === 1024;
    const event = { choices: [{ delta: { ...(phase === 2 ? { content: truncated ? '应撤回的未完成草稿' : '完整操作说明' } : {}), tool_calls: [{ index: 0, id: 'phase-' + phase, function: { name, arguments: truncated ? JSON.stringify(args).slice(0, 1000) : JSON.stringify(args) } }] }, finish_reason: truncated ? 'length' : 'tool_calls' }] };
    if (!truncated) phase++;
    return new Response('data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n');
  } });
  router.key = () => 'fixture-key'; router.config = () => ({ mode: 'deepseek', model: 'fixture', maxTokens: 1024 });
  const agent = new AgentMock({ provider: router, workspace: f.workspace }), input = { threadId: 'budget-native-recovery', content: [{ type: 'text', text: '追加两段合成内容' }] };
  agent.create(input); await waitFor(() => agent.status().completed + agent.status().failed > 0);
  assert.equal(agent.status().failed, 0); assert.equal(agent.status().completed, 1);
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 2);
  assert.equal(f.pages.get(B).markdown.split('已完成的第一笔修改').length - 1, 1);
  assert.equal(f.pages.get(B).markdown.includes(longContent), true);
  assert.deepEqual(budgets, [1024, 1024, 1024, 393216, 1024]);
  const transcript = await agent.transcript(input).json(), answer = transcript.patches.find(p => p.entity.kind === 'assistant_message').entity.content[0].text;
  assert.equal(answer.includes('应撤回的未完成草稿'), false);
  assert.equal(answer.includes('完整操作说明'), true);
  assert.equal(answer.split('页面修改已读回核验').length - 1, 2);
});

test('an error after a verified write explicitly preserves its outcome in the native conversation', async t => {
  const f = fixture(t);
  let phase = 0;
  const provider = { config: () => ({ mode: 'deepseek' }), async* generate({ messages, onToolCalls }) {
    if (phase === 2) throw Error('DeepSeek 工具参数流未完整结束，本次工具调用未执行。');
    const previous = messages.at(-1).role === 'tool' ? JSON.parse(messages.at(-1).content) : {};
    const name = phase === 0 ? 'read_page' : 'append_page';
    onToolCalls([{ id: 'outcome-' + phase++, type: 'function', function: { name, arguments: JSON.stringify({ page_id: B, ...(name === 'append_page' ? { revision: previous.revision, content: '只写入一次' } : {}) }) } }]);
  } };
  const agent = new AgentMock({ provider, workspace: f.workspace }), input = { threadId: 'budget-verified-outcome', content: [{ type: 'text', text: '合成修改任务' }] };
  agent.create(input); await waitFor(() => agent.status().failed > 0);
  const transcript = await agent.transcript(input).json(), error = transcript.patches.find(p => p.entity.kind === 'error').entity;
  assert.equal(error.message.includes('此前已有 1 次页面修改读回核验'), true);
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1);
});

test('a task with four verified writes can continue through a batch of nine tools without replaying writes', async t => {
  const f = fixture(t);
  let phase = 0;
  const provider = { config: () => ({ mode: 'deepseek' }), async* generate({ messages, onToolCalls }) {
    const previous = messages.at(-1).role === 'tool' ? JSON.parse(messages.at(-1).content) : {};
    if (phase === 6) { yield '全部写入与后续核验完成。'; return; }
    if (phase === 5) onToolCalls(Array.from({ length: 9 }, (_, index) => ({ id: 'batch-' + index, type: 'function', function: { name: 'read_page', arguments: JSON.stringify({ page_id: B }) } })));
    else onToolCalls([{ id: 'step-' + phase, type: 'function', function: { name: phase ? 'append_page' : 'read_page', arguments: JSON.stringify(phase ? { page_id: B, revision: previous.revision, content: 'verified-change-' + phase } : { page_id: B }) } }]);
    phase++;
  } };
  const agent = new AgentMock({ provider, workspace: f.workspace }), input = { threadId: 'nine-tools-after-four-writes', content: [{ type: 'text', text: '合成多步骤验收' }] };
  agent.create(input); await waitFor(() => !agent.status().active);
  const transcript = await agent.transcript(input).json();
  const error = transcript.patches.find(p => p.entity.kind === 'error')?.entity.message;
  assert.equal(error, undefined);
  assert.equal(agent.status().completed, 1);
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 4);
  for (let index = 1; index <= 4; index++) assert.equal(f.pages.get(B).markdown.split('verified-change-' + index).length - 1, 1);
});

test('a multi-step agent task can finish after more than ten model generations', async t => {
  const f = fixture(t); let rounds = 0;
  const provider = { config: () => ({ mode: 'deepseek' }), async* generate({ onToolCalls }) {
    if (rounds++ === 12) { yield '长任务已完成。'; return; }
    onToolCalls([{ id: 'round-' + rounds, type: 'function', function: { name: 'read_page', arguments: JSON.stringify({ page_id: B }) } }]);
  } };
  const agent = new AgentMock({ provider, workspace: f.workspace });
  agent.create({ threadId: 'more-than-ten-rounds', content: [{ type: 'text', text: '合成多步骤只读任务' }] });
  await waitFor(() => !agent.status().active);
  assert.equal(agent.status().completed, 1); assert.equal(agent.status().failed, 0); assert.equal(rounds, 13);
  assert.equal(f.calls.some(call => call.method === 'PATCH'), false);
});

test('native stop cancels the remainder of a large tool batch without replay or next generation', async t => {
  let calls = 0, rounds = 0, pending;
  const workspace = { open: () => ({ definitions: [{ function: { name: 'read_page' } }], execute: async (_name, _args) => {
    calls++;
    if (calls === 9) await new Promise(resolve => { pending = resolve; });
    return { markdown: 'synthetic' };
  } }) };
  const provider = { config: () => ({ mode: 'deepseek' }), async* generate({ onToolCalls }) {
    rounds++;
    onToolCalls(Array.from({ length: 20 }, (_, index) => ({ id: 'call-' + index, type: 'function', function: { name: 'read_page', arguments: '{}' } })));
  } };
  const agent = new AgentMock({ workspace, provider }), input = { threadId: 'stop-large-batch', content: [{ type: 'text', text: '合成读取任务' }] };
  agent.create(input); await waitFor(() => !!pending);
  agent.send({ threadId: input.threadId, event: { type: 'user.interrupt' } }); pending(); await sleep(5);
  assert.equal(agent.status().stopped, 1); assert.equal(agent.status().failed, 0);
  assert.equal(calls, 9); assert.equal(rounds, 1);
});

test('truncated tool-call arguments are never dispatched to the executor', async t => {
  const f = fixture(t);
  const router = new ProviderRouter({ root: f.root, fetchImpl: async () => new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"broken","function":{"name":"append_page","arguments":"{broken"}}]},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n') });
  router.key = () => 'fixture-deepseek-token';
  let dispatched = false;
  await assert.rejects(async () => { for await (const _ of router.generate({ config: { model: 'fixture' }, messages: [], signal: new AbortController().signal, tools: f.workspace.open().definitions, onToolCalls: () => { dispatched = true; } })) {} }, /未完整结束/);
  assert.equal(dispatched, false); assert.equal(f.calls.length, 0);
});

test('read-only mode exposes no write tools and rejects direct write dispatch', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'notion.local.json'), JSON.stringify({ readOnly: true }));
  const session = f.workspace.open();
  assert.ok(session.definitions.some(d => d.function.name === 'search_pages'));
  assert.ok(session.definitions.some(d => d.function.name === 'read_page'));
  assert.equal(session.definitions.some(d => writeTools.has(d.function.name)), false);
  await assert.rejects(session.execute('append_page', { page_id: B, revision: 'x', content: 'no write' }), /只读/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(session.execute('read_page', { page_id: '33333333-3333-4333-8333-333333333333' }), error => error.message.includes('HTTP 404') && !error.message.includes('fixture-notion-token'));
});

test('restoring a process interrupted during writing tells the native conversation to verify the page', async t => {
  let pendingSignal;
  const f = fixture(t, { fetch: ({ options }) => { if (options.method === 'PATCH') return new Promise((resolve, reject) => { pendingSignal = options.signal; pendingSignal.addEventListener('abort', () => reject(pendingSignal.reason), { once: true }); }); } });
  const provider = { config: () => ({ mode: 'deepseek' }), async* generate({ messages, onToolCalls }) {
    const previous = messages.at(-1).role === 'tool' ? JSON.parse(messages.at(-1).content) : null;
    onToolCalls([{ id: previous ? 'write' : 'read', type: 'function', function: { name: previous ? 'append_page' : 'read_page', arguments: JSON.stringify(previous ? { page_id: B, revision: previous.revision, content: 'pending append' } : { page_id: B }) } }]);
  } };
  const stateFile = path.join(f.root, 'conversation.json');
  const agent = new AgentMock({ provider, workspace: f.workspace, stateFile });
  const input = { threadId: 'restart-write', content: [{ type: 'text', text: 'append to B' }] };
  agent.create(input); await waitFor(() => !!pendingSignal);
  const restored = new AgentMock({ stateFile });
  const data = await restored.transcript(input).json();
  const answer = data.patches.find(p => p.entity.kind === 'assistant_message').entity.content[0].text;
  assert.ok(answer.includes('程序在写入期间退出')); assert.equal(data.session.status, 'idle');
  agent.send({ threadId: input.threadId, event: { type: 'user.interrupt' } });
  await sleep(5);
});
