import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NativeMock } = require('../src/native-mock.cjs');
const { isResearch, researchConfig, normalizeResearch, researchMessages } = require('../src/native-research.cjs');
const { researchWorkspace } = require('../src/research-scope.cjs');
const { runAgent } = require('../src/agent-runtime.cjs');
const id = n => 'ae00aa00-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
const input = () => ({ spaceId: id(1), threadId: id(2), traceId: id(3), createThread: true, asPatchResponse: true, transcript: [
  { id: id(4), type: 'config', value: { type: 'researcher', searchScope: { type: 'notion' }, useWebSearch: false } },
  { id: id(5), type: 'context', value: { spaceId: id(1), userId: id(9), userEmail: 'must-not-send-profile', clientRenderedPages: { hidden: 'must-not-send-snapshot' } } },
  { id: id(6), type: 'user', value: [['只读研究合成页面，回答代码并引用来源。']] }
] });
const tool = name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {}, required: [] } } });

test('pending native research integration stays explicit and performs no workspace or model access', async () => {
  const forbidden = () => assert.fail('Production report integration awaits explicit body authorization');
  const native = new NativeMock({ workspace: { open: forbidden }, provider: { status: () => ({ mode: 'deepseek' }), config: forbidden, generate: forbidden } });
  const response = await native.handle('runInferenceTranscript', input(), undefined, { userId: id(9) });
  assert.equal(response.status, 501); assert.match(await response.text(), /not ready/);
});

test('both audited researcher producers preserve scope, while ordinary workflows do not opt in', () => {
  const legacy = researchConfig({ type: 'researcher', searchScope: { type: 'page', pageId: id(7) }, useWebSearch: false });
  assert.deepEqual(legacy.rootIds, [id(7)]); assert.equal(legacy.useWebSearch, false);
  const workflow = researchConfig({ type: 'workflow', isAgentResearchRequest: true, searchScopes: [{ type: 'page', pageId: id(7) }, { type: 'web' }] });
  assert.equal(workflow.useWebSearch, true); assert.deepEqual(workflow.rootIds, [id(7)]);
  const request = input(); request.transcript[0].value = workflow; assert.equal(isResearch(request), true);
  request.transcript[0].value = { type: 'workflow' }; assert.equal(isResearch(request), false);
  for (const value of [{ type: 'writer' }, { type: 'workflow' }, { type: 'researcher', isCustomAgent: true }, { type: 'researcher', writerMode: true }, { type: 'researcher', isMeetingNotesMode: true }]) assert.throws(() => researchConfig(value));
});

test('native source defaults disclose missing connectors, honor web opt out and HIPAA restrictions', () => {
  const broad = researchConfig({ type: 'researcher', useWebSearch: true });
  assert.equal(broad.notion, true); assert.match(broad.notice, /连接器尚未接入/); assert.deepEqual(broad.rootIds, []);
  const narrow = researchConfig({ type: 'researcher', searchScope: { type: 'web' }, useWebSearch: false });
  assert.equal(narrow.notion, false); assert.equal(narrow.useWebSearch, false);
  assert.equal(researchConfig({ type: 'workflow', isAgentResearchRequest: true, isHipaa: true, useWebSearch: true }).useWebSearch, false);
  assert.equal(researchConfig({ type: 'researcher' }).useWebSearch, false);
  assert.throws(() => researchConfig({ type: 'researcher', useWebSearch: 'true' }));
});

test('unknown connector and narrowed scope formats fail instead of expanding the source boundary', () => {
  for (const scope of [{ type: 'slack' }, { type: 'teamspace', teamId: id(7) }, { type: 'site', siteId: 'help' }, { type: 'page', pageId: 'wrong' }, { type: 'notion', filter: 'unsupported' }])
    assert.throws(() => researchConfig({ type: 'researcher', searchScope: scope }));
  assert.throws(() => researchConfig({ type: 'workflow', isAgentResearchRequest: true, searchScopes: Array(33).fill({ type: 'notion' }) }));
  const selected = researchConfig({ type: 'researcher', searchScope: { type: 'collection', collectionId: id(8), pageId: id(7) } });
  assert.deepEqual(selected.rootIds, [id(8)]); assert.deepEqual(selected.collections, [{ collectionId: id(8), pageId: id(7) }]);
});

test('research normalization removes profile/rendered snapshots and rejects mismatched identities or unknown attachments', () => {
  const normalized = normalizeResearch(input(), id(9));
  assert.ok(!JSON.stringify(normalized).includes('must-not-send')); assert.equal(normalized.input.transcript.at(-1).userId, id(9));
  assert.equal(normalized.nativeContext.workspace_id, id(1));
  for (const mutate of [value => value.spaceId = 'bad', value => value.transcript[1].value.userId = id(88), value => value.transcript[1].value.spaceId = id(88),
    value => value.transcript.push({ id: id(10), type: 'attachment', value: {} }), value => value.transcript[2].id = id(4),
    value => value.transcript.push({ id: id(10), type: 'config', value: { type: 'researcher' } }), value => value.transcript[2].value = 'x'.repeat(32001)]) {
    const value = input(); mutate(value); assert.throws(() => normalizeResearch(value, id(9)));
  }
});

test('only latest explicit references are refreshed; older mentions stay conversation data', async () => {
  const value = input(), old = { id: id(11), type: 'user', value: [['旧引用', [['p', id(71), id(1)]]]] };
  value.transcript.splice(2, 0, { id: id(12), type: 'user-specified-context', value: { pointers: [{ table: 'block', id: id(72), spaceId: id(1) }] } }, old);
  value.transcript.at(-1).value = [['最新引用', [['p', id(73), id(1)]]]];
  const reads = [], messages = await researchMessages(normalizeResearch(value, id(9)).input, { resolveReferences: async options => {
    reads.push(...options.pointers.map(pointer => pointer.id)); return { references: options.pointers.map(pointer => ({ pointer, complete: true, body: '合成引用资料' })) };
  } });
  assert.deepEqual(reads, [id(73)]); assert.ok(messages.some(message => message.content.includes('合成引用资料')));
  const invalid = input(); invalid.transcript.push({ id: id(14), type: 'user-specified-context', value: { pointers: [] } });
  await assert.rejects(researchMessages(normalizeResearch(invalid, id(9)).input), /引用没有对应/);
});

test('research source wrapper requires scope enforcement proof, binds current workspace and rejects writes before execution', async () => {
  const config = researchConfig({ type: 'researcher', searchScope: { type: 'page', pageId: id(7) } }), reads = [], sources = [];
  const workspace = { open: async options => {
    assert.deepEqual(options.readScope, { workspaceId: id(1), rootIds: [id(7)] });
    return { context: { current_workspace_id: id(1), read_scope: { workspace_id: id(1), root_ids: [id(7)], read_only: true } },
      definitions: ['read_page', 'append_page', 'read_comment'].map(tool), execute: async (name, args) => { reads.push({ name, args }); return { page_id: id(7), workspace_id: id(1), url: 'https://www.notion.so/' + id(7), markdown: '纯内存合成资料' }; } };
  } };
  const session = await researchWorkspace(workspace, { spaceId: id(1), config, onSource: value => sources.push(value) }).open();
  assert.deepEqual(session.definitions.map(value => value.function.name), ['read_page']);
  for (const [name, args] of [['append_page', {}], ['read_page', { workspace_id: 'all' }], ['read_page', { workspace_id: id(8) }], ['read_comment', {}]]) await assert.rejects(session.execute(name, args));
  assert.equal(reads.length, 0);
  await session.execute('read_page', { page_id: id(7) }); assert.equal(reads[0].args.workspace_id, id(1)); assert.equal(sources[0].body_available, true);
  const noProof = { open: async () => ({ context: { current_workspace_id: id(1) }, definitions: [tool('read_page')] }) };
  await assert.rejects(researchWorkspace(noProof, { spaceId: id(1), config }).open(), /范围/);
  assert.equal(researchWorkspace(undefined, { spaceId: id(1), config: { notion: false } }), undefined);
});

test('selected collection validates data-source ownership and aliases page ID without fetching sibling data sources', async () => {
  const config = researchConfig({ type: 'researcher', searchScope: { type: 'collection', pageId: id(7), collectionId: id(8) } }), calls = [];
  let parent = id(7);
  const workspace = { open: async () => ({ context: { current_workspace_id: id(1), read_scope: { workspace_id: id(1), root_ids: [id(8)], read_only: true } },
    definitions: [tool('read_database')], execute: async (name, args) => { calls.push(args); return { data_source_id: id(8), parent: { database_id: parent } }; } }) };
  const wrapper = researchWorkspace(workspace, { spaceId: id(1), config }), session = await wrapper.open();
  assert.deepEqual(calls, [{ data_source_id: id(8), workspace_id: id(1) }]);
  await session.execute('read_database', { database_id: id(7) }); assert.deepEqual(calls.at(-1), { data_source_id: id(8), workspace_id: id(1) });
  parent = id(88); await assert.rejects(wrapper.open(), /关联不匹配/);
});

test('read-only research runtime rejects an invented write tool even when a synthetic model asks for it', async () => {
  let executions = 0, calls = 0;
  const provider = { async* generate({ tools, messages, onToolCalls }) {
    calls++; assert.ok(!tools.some(value => value.function.name === 'append_page')); assert.match(messages[0].content, /本轮禁止/);
    onToolCalls([{ id: 'unoffered-write', type: 'function', function: { name: 'append_page', arguments: '{}' } }]);
  } };
  await assert.rejects(runAgent({ provider, config: { multiAgent: false }, research: true, signal: new AbortController().signal,
    workspace: { open: async () => ({ definitions: [tool('read_page'), tool('append_page')], execute: async () => executions++ }) },
    messages: [{ role: 'system', content: '' }, { role: 'user', content: '仅分析合成资料' }], onText() {} }), /未启用的工具/);
  assert.equal(calls, 1); assert.equal(executions, 0);
});

test('a research reader rejects a mismatched workspace response before returning evidence', async () => {
  const config = researchConfig({ type: 'researcher', searchScope: { type: 'notion' } }); let sources = 0;
  const workspace = { open: async () => ({ context: { current_workspace_id: id(1) }, definitions: [tool('read_page')],
    execute: async () => ({ workspace_id: id(88), url: 'https://www.notion.so/' + id(7), markdown: '不能返回此合成资料' }) }) };
  const session = await researchWorkspace(workspace, { spaceId: id(1), config, onSource: () => sources++ }).open();
  await assert.rejects(session.execute('read_page', { page_id: id(7) }), /其他工作区/); assert.equal(sources, 0);
});
