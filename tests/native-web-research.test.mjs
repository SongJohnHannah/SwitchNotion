import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url), { NativeMock } = require('../src/native-mock.cjs');
const { WebSources } = require('../src/web-sources.cjs'), { localRecords } = require('../src/local-records.cjs');
const { preparePublicResearch, streamPublicResearch } = require('../src/native-web-research.cjs');
const { InlineRecords } = require('../src/inline-records.cjs');
const id = n => 'bc00aa00-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
function request() { return { spaceId: id(1), threadId: id(2), traceId: id(3), asPatchResponse: true, transcript: [
  { id: id(4), type: 'config', value: { type: 'researcher', searchScope: { type: 'web' }, useWebSearch: true } },
  { id: id(5), type: 'context', value: { spaceId: id(1), userId: id(9), clientRenderedPages: { page: 'excluded-private-snapshot' } } },
  { id: id(6), type: 'user', value: [['研究 https://example.com/report 的合成说明，报告代码和来源。']] }
] }; }

test('native web-only research reads a synthetic public source and never opens a Notion workspace', async () => {
  let calls = 0, reads = 0, closed = 0;
  const webSources = { async open(options) {
    assert.equal(options.purpose, 'research'); assert.equal(options.input.notion, false);
    return { definitions: [{ type: 'function', function: { name: 'read_web_page', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } }],
      authorizedUrls: () => ['https://example.com/report'], close() { closed++; }, async execute(name, args) {
        reads++; assert.equal(name, 'read_web_page'); assert.equal(args.url, 'https://example.com/report');
        return { source: 'public-web', url: args.url, title: '合成网页', text: '合成代码青色927', complete: true, body_available: true };
      } };
  } };
  const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate({ messages, tools, onToolCalls }) {
    calls++; assert.ok(!JSON.stringify(messages).includes('excluded-private-snapshot')); assert.ok(tools.every(value => ['read_web_page', 'read_task_progress'].includes(value.function.name)));
    if (calls === 1) { onToolCalls([{ id: 'synthetic-public-source', type: 'function', function: { name: 'read_web_page', arguments: '{"url":"https://example.com/report"}' } }]); return; }
    assert.ok(messages.some(value => value.role === 'tool' && value.content.includes('合成代码青色927'))); yield '合成代码青色927，[来源](https://example.com/report)。';
  } };
  const native = new NativeMock({ provider, webSources, workspace: { open: () => assert.fail('Notion body access is pending separate authorization') } });
  const response = await native.handle('runInferenceTranscript', request(), undefined, { userId: id(9) });
  assert.equal(response.status, 200); const text = await response.text(); assert.match(text, /合成代码青色927/); assert.equal(calls, 2); assert.equal(reads, 1); assert.ok(closed >= 1);
  const record = native.record(id(2), 'thread', { userId: id(9), spaceId: id(1) });
  assert.equal(record.data.notion_switch_research.web_only, true); assert.equal(record.data.notion_switch_research.status, 'completed');
});

function fixture(t, generate) {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-native-web-research-中文 空格-'));
  const stateFile = path.join(root, 'conversation.json'), modelCalls = [], fetches = [];
  const webSources = new WebSources({ root, fetchPublic: async url => {
    fetches.push(url); return { url, headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>合成原生研究</title><main>合成公开代码927-' + fetches.length + '</main>') };
  } }); webSources.save({ enabled: 'enabled' });
  const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate(options) {
    modelCalls.push(options);
    if (generate) return yield* generate(options);
    const tool = options.messages.findLast(value => value.role === 'tool');
    if (!tool) { options.onToolCalls([{ id: 'public-read-' + modelCalls.length, type: 'function', function: { name: 'read_web_page', arguments: '{"url":"https://example.com/report"}' } }]); return; }
    yield '合成报告：' + JSON.parse(tool.content).text + '。[来源](https://example.com/report)';
  } };
  const options = { provider, webSources, stateFile, workspace: { open: () => assert.fail('No private Notion body reader in this branch') },
    inlineReferences: () => assert.fail('No inline Notion references in this branch') };
  const native = new NativeMock(options), meta = { userId: id(9) };
  t.after(() => { native.close(); webSources.close(); clearTimeout(native.agent.saveTimer); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const call = value => native.handle('runInferenceTranscript', value || request(), undefined, meta);
  return { root, options, native, webSources, modelCalls, fetches, meta, call };
}
const frames = async response => { assert.equal(response.status, 200); return (await response.text()).trim().split('\n').map(JSON.parse); };
const userTransaction = (native, text, newId = id(71)) => {
  const thread = native.record(id(2));
  return { transactions: [{ spaceId: id(1), operations: [
    { pointer: { table: 'thread_message', id: newId, spaceId: id(1) }, command: 'set', path: [], args: {
      id: newId, parent_id: id(2), parent_table: 'thread', space_id: id(1), created_by_id: id(9), step: { id: newId, type: 'user', value: [[text]] }
    } },
    { pointer: { table: 'thread', id: id(2), spaceId: id(1) }, command: 'listAfter', path: ['messages'], args: { id: newId, after: thread.messages.at(-1) } }
  ] }] };
};

test('both native config shapes emit raw or patch report steps and restore owned history without storing fetched body', async t => {
  const f = fixture(t), input = request(); input.asPatchResponse = false;
  input.transcript[0].value = { type: 'workflow', isAgentResearchRequest: true, searchScopes: [{ type: 'web' }], useWebSearch: true };
  const result = await frames(await f.call(input)); assert.ok(result.some(step => step.type === 'agent-inference' && JSON.stringify(step).includes('合成公开代码927-1')));
  assert.ok(!result.some(step => step.type === 'patch-start')); assert.equal(f.webSources.sessions.size, 0);
  const restored = new NativeMock(f.options); t.after(() => { restored.close(); clearTimeout(restored.agent.saveTimer); });
  assert.equal(restored.record(id(2)).data.notion_switch_research.status, 'completed');
  const history = await (await restored.handle('getInferenceTranscriptsForUser', { threadParentPointer: { table: 'space', id: id(1) }, types: ['workflow'] }, undefined, f.meta)).json();
  assert.ok(history.threadIds.includes(id(2)));
  const other = await (await restored.handle('getInferenceTranscriptsForUser', { threadParentPointer: { table: 'space', id: id(1) } }, undefined, { userId: id(88) })).json();
  assert.ok(!other.threadIds.includes(id(2)));
  const store = fs.readFileSync(path.join(f.root, 'inline-conversations.local.json'), 'utf8');
  assert.ok(!store.includes('<main>')); assert.ok(!store.includes('excluded-private-snapshot')); assert.ok(store.includes('合成报告'));
});

test('workspace sources, page mentions, selected text and injected context never fall back to public-only generation', async t => {
  const f = fixture(t);
  for (const edit of [value => value.transcript[0].value.searchScope = { type: 'notion' }, value => value.transcript[0].value.searchScope = { type: 'everything' },
    value => value.transcript[0].value.searchScope = { type: 'page', pageId: id(33) },
    value => value.transcript[2].value = [['未接入页面', [['p', id(33), id(1)]]]],
    value => value.transcript.splice(2, 0, { id: id(34), type: 'user-specified-context', value: { pointers: [{ table: 'block', id: id(33), spaceId: id(1) }] } }),
    value => value.transcript[2].type = 'user-injected', value => value.transcript[0].value.useWebSearch = false,
    value => value.transcript[0].value.isHipaa = true]) {
    const input = request(); edit(input); const response = await f.call(input); assert.ok(response.status >= 400); await response.body?.cancel();
  }
  assert.equal(f.modelCalls.length, 0); assert.equal(f.fetches.length, 0); assert.equal(f.webSources.sessions.size, 0); assert.equal(f.native.inline.threads.size, 0);
});

test('disabled local web setting fails visibly without a model call or silently using model knowledge', async t => {
  const f = fixture(t); f.webSources.save({ enabled: 'disabled' });
  const result = await frames(await f.call()); assert.match(JSON.stringify(result), /本地联网设置尚未启用/);
  assert.equal(f.modelCalls.length, 0); assert.equal(f.native.record(id(2)).data.notion_switch_research.status, 'failed');
});

test('local message transactions permit follow-up after restart and reject changed assistant reports atomically', async t => {
  const f = fixture(t); await frames(await f.call());
  const firstAnswerId = f.native.record(id(2)).messages.at(-1), firstTraceId = f.native.record(firstAnswerId, 'thread_message').step.traceId;
  const transaction = userTransaction(f.native, '继续核对刚才的公开网页');
  const saved = f.native.transactions(transaction, f.meta); assert.equal(saved.status, 200);
  const restored = new NativeMock(f.options); t.after(() => { restored.close(); clearTimeout(restored.agent.saveTimer); });
  const reply = await frames(await restored.handle('runInferenceTranscript', { threadId: id(2), spaceId: id(1), transcript: [], asPatchResponse: true }, undefined, f.meta));
  assert.match(JSON.stringify(reply), /合成公开代码927-2/); assert.equal(f.fetches.length, 2);
  assert.equal(restored.record(firstAnswerId, 'thread_message').step.traceId, firstTraceId);
  assert.ok(Number.isSafeInteger(restored.record(firstAnswerId, 'thread_message').step.finishedAt));
  const assistantId = restored.record(id(2)).messages.at(-1), original = restored.record(assistantId, 'thread_message').step;
  const acknowledgement = { transactions: [{ operations: [{ pointer: { table: 'thread_message', id: assistantId }, command: 'update', path: ['step'], args: Object.fromEntries(Object.entries(original).reverse()) }] }] };
  assert.equal(restored.transactions(acknowledgement, f.meta).status, 200);
  const before = JSON.stringify([...restored.inline.threads, ...restored.inline.messages]);
  const tampered = { transactions: [{ operations: [{ pointer: { table: 'thread_message', id: assistantId }, command: 'update', path: ['step'], args: { ...original, value: [{ type: 'text', content: '伪造报告' }] } }] }] };
  assert.equal(restored.transactions(tampered, f.meta).status, 400); assert.equal(JSON.stringify([...restored.inline.threads, ...restored.inline.messages]), before);
  const repeat = await restored.handle('runInferenceTranscript', { threadId: id(2), spaceId: id(1), transcript: [] }, undefined, f.meta);
  assert.equal(repeat.status, 403); assert.equal(f.modelCalls.length, 4);
});

test('mixed or unlinked local transactions and foreign accounts are rejected without changing any local record', async t => {
  const f = fixture(t); await frames(await f.call()); const before = JSON.stringify([...f.native.inline.threads, ...f.native.inline.messages]);
  const transaction = userTransaction(f.native, '新的合成问题');
  const mixed = structuredClone(transaction); mixed.transactions[0].operations.push({ pointer: { table: 'block', id: id(90) }, command: 'update', path: ['properties'], args: { title: [['不得远程保存']] } });
  assert.equal(f.native.transactions(mixed, f.meta).status, 409);
  const unlinked = structuredClone(transaction); unlinked.transactions[0].operations.pop(); assert.equal(f.native.transactions(unlinked, f.meta).status, 400);
  assert.equal(f.native.transactions(transaction, { userId: id(88) }).status, 403);
  assert.equal(JSON.stringify([...f.native.inline.threads, ...f.native.inline.messages]), before);
  assert.equal((await f.native.handle('runInferenceTranscript', request(), undefined, { userId: id(88) })).status, 403);
  assert.equal(f.modelCalls.length, 2);
});

test('native stop preserves a partial report, refuses another account and aborts ongoing generation', async t => {
  let started; const ready = new Promise(resolve => started = resolve);
  const f = fixture(t, async function* ({ signal }) { yield '已生成的合成部分报告'; started(); await sleep(10000, undefined, { signal }); yield '不应继续生成'; });
  const response = await f.call(); await ready;
  assert.equal(f.native.record(id(2)).current_inference_id, id(3)); assert.ok(f.native.record(id(2)).current_inference_lease_expiration > Date.now());
  const cleanup = { transactions: [{ operations: [{ pointer: { table: 'thread', id: id(2) }, command: 'update', path: [], args: { current_inference_id: null, current_inference_lease_expiration: null } }] }] };
  assert.equal(f.native.transactions(cleanup, f.meta).status, 200); assert.equal(f.native.record(id(2)).current_inference_id, id(3));
  assert.equal((await f.native.handle('stopWorkflowAutomationRunThread', { threadId: id(2), spaceId: id(1) }, undefined, { userId: id(88) })).status, 403);
  assert.equal(f.native.status().activeTurns, 1);
  await f.native.handle('stopWorkflowAutomationRunThread', { threadId: id(2), spaceId: id(1) }, undefined, f.meta);
  const result = await frames(response); assert.match(JSON.stringify(result), /部分报告/); assert.ok(!JSON.stringify(result).includes('不应继续生成'));
  assert.equal(f.native.record(id(2)).data.notion_switch_research.status, 'stopped'); assert.equal(f.native.status().activeTurns, 0); assert.equal(f.webSources.sessions.size, 0);
  assert.equal(f.native.record(id(2)).current_inference_id, undefined);
});

test('public research deadline closes the response and persists partial state without touching a workspace', async t => {
  const f = fixture(t, async function* ({ signal }) { yield '截止前的合成结果'; await sleep(10000, undefined, { signal }); });
  const records = new InlineRecords(), normalized = preparePublicResearch(request(), records, id(9)), thread = { turns: [] };
  const response = streamPublicResearch({ normalized, records, userId: id(9), provider: f.options.provider, webSources: f.webSources, thread, timeoutMs: 30 });
  const result = await frames(response); assert.match(JSON.stringify(result), /时间上限/); assert.equal(records.record(id(2)).data.notion_switch_research.status, 'timeout'); assert.equal(f.webSources.sessions.size, 0);
});

test('editing a running question stops the old generation before committing the new local transcript', async t => {
  let started; const ready = new Promise(resolve => started = resolve);
  const f = fixture(t, async function* ({ signal }) { yield '旧问题的部分结果'; started(); await sleep(10000, undefined, { signal }); });
  const response = await f.call(); await ready;
  const transaction = userTransaction(f.native, '新问题的明确范围'); assert.equal(f.native.transactions(transaction, f.meta).status, 200);
  await frames(response);
  const record = f.native.record(id(2)); assert.equal(record.messages.at(-1), id(71));
  assert.equal(record.data.notion_switch_research.status, 'stopped'); assert.equal(f.native.status().activeTurns, 0);
  assert.ok(record.messages.some(idValue => f.native.record(idValue, 'thread_message').step.type === 'agent-inference'));
});

test('a source change requiring Notion authorization stops the old web report and starts no substitute search', async t => {
  let started; const ready = new Promise(resolve => started = resolve);
  const f = fixture(t, async function* ({ signal }) { yield '网页范围的部分结果'; started(); await sleep(10000, undefined, { signal }); });
  const response = await f.call(); await ready;
  const changed = request(); changed.transcript[0].value.searchScope = { type: 'everything' };
  assert.equal((await f.call(changed)).status, 501); await frames(response);
  assert.equal(f.modelCalls.length, 1); assert.equal(f.fetches.length, 0); assert.equal(f.native.status().activeTurns, 0); assert.equal(f.webSources.sessions.size, 0);
});

test('turning off web settings cancels the model response and releases its public source session', async t => {
  let started; const ready = new Promise(resolve => started = resolve);
  const f = fixture(t, async function* ({ signal }) { yield '配置变更前的合成部分'; started(); await sleep(10000, undefined, { signal }); });
  const response = await f.call(); await ready; f.webSources.save({ enabled: 'disabled' });
  const result = await frames(response); assert.match(JSON.stringify(result), /已停止/);
  assert.equal(f.native.record(id(2)).data.notion_switch_research.status, 'stopped'); assert.equal(f.webSources.sessions.size, 0);
});

test('local title and archive metadata stay local and archived research cannot silently restart', async t => {
  const f = fixture(t); await frames(await f.call());
  const operations = [
    { pointer: { table: 'thread', id: id(2) }, command: 'set', path: ['data', 'title'], args: '合成研究标题' },
    { pointer: { table: 'thread', id: id(2) }, command: 'update', path: [], args: { alive: false } }
  ];
  const result = f.native.transactions({ transactions: [{ operations }] }, f.meta); assert.equal(result.status, 200);
  assert.equal(f.native.record(id(2)).data.title, '合成研究标题'); assert.equal(f.native.record(id(2)).alive, false);
  assert.equal((await f.call()).status, 409); assert.equal(f.modelCalls.length, 2);
  const remote = { transactions: [{ operations: [{ pointer: { table: 'block', id: id(99) }, command: 'update', path: [], args: { alive: true } }] }] };
  assert.equal(f.native.transactions(remote, f.meta), null);
});

test('actual desktop route keeps research inference, local message saves and scoped records off the remote path', async t => {
  const f = fixture(t), source = fs.readFileSync(new URL('../src/desktop-hook.cjs', import.meta.url), 'utf8'), forwarded = [];
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const context = { Request, Response, Headers, URL, mock: f.native, provider: f.options.provider, json, localRecords, aiRecords: f.native,
    createNativeImageAdapter: () => undefined, settings: { speech: { enabled: false }, isLoginSyncing: () => false },
    nativeSpeech: { enabled: false }, meetingBridge: { observe() {} }, recordings: { wake() {} }, log() {}, localUploadPrefix: '/notion-switch-local-upload/',
    isNotion: host => host === 'app.notion.com', endpoints: new Set(['runInferenceTranscript', 'stopWorkflowAutomationRunThread']) };
  const route = vm.runInNewContext(source.slice(source.indexOf('async function route('), source.indexOf('\nfunction install(ses)')) + '\nroute', context);
  const call = (endpoint, data, userId = id(9)) => route(new Request('https://app.notion.com/api/v3/' + endpoint, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-notion-active-user-header': userId }, body: JSON.stringify(data) }), async requestValue => {
    const name = new URL(requestValue.url).pathname.split('/').at(-1); forwarded.push(name);
    if (name === 'getInferenceTranscriptsForUser') return json({ threadIds: [], nextCursor: null });
    if (name === 'saveTransactionsFanout') return json({ ordinary: true });
    assert.fail('Local research must not reach remote endpoint: ' + name);
  });
  await frames(await call('runInferenceTranscript', request()));
  assert.equal((await call('saveTransactionsFanout', userTransaction(f.native, '继续比较同一公开来源'))).status, 200);
  const owned = await (await call('getRecordValues', { requests: [{ table: 'thread', id: id(2), spaceId: id(1) }] })).json(); assert.equal(owned.results[0].role, 'editor');
  const denied = await (await call('getRecordValues', { requests: [{ table: 'thread', id: id(2), spaceId: id(1) }] }, id(88))).json(); assert.deepEqual(denied.results, [{ role: 'none' }]);
  const history = await (await call('getInferenceTranscriptsForUser', { threadParentPointer: { table: 'space', id: id(1) } })).json(); assert.ok(history.threadIds.includes(id(2)));
  await frames(await call('runInferenceTranscript', { threadId: id(2), spaceId: id(1), transcript: [] }));
  assert.equal(f.modelCalls.length, 4); assert.deepEqual(forwarded, ['getInferenceTranscriptsForUser']);
  const ordinary = await (await call('saveTransactionsFanout', { transactions: [{ operations: [{ pointer: { table: 'block', id: id(99) }, command: 'update', path: [], args: { alive: true } }] }] })).json();
  assert.equal(ordinary.ordinary, true);
});

test('an explicit native DeepSeek model choice is retained in local research configuration and passed to the provider', async t => {
  const f = fixture(t), original = f.options.provider.config, selections = [];
  f.options.provider.config = selection => { selections.push(selection); return original(); };
  const input = request(); Object.assign(input.transcript[0].value, { model: 'baseten-deepseek-v4-pro', modelFromUser: true });
  await frames(await f.call(input));
  assert.deepEqual(selections, [{ type: 'explicit', model: 'baseten-deepseek-v4-pro' }]);
  const config = f.native.record(id(4), 'thread_message').step.value; assert.equal(config.model, 'baseten-deepseek-v4-pro');
  const invalid = request(); invalid.threadId = id(90); Object.assign(invalid.transcript[0].value, { model: 'unreviewed-model', modelFromUser: true });
  assert.equal((await f.call(invalid)).status, 403); assert.equal(selections.length, 1);
});
