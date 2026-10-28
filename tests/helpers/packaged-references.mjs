import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { formulaInput } from './native-formula.mjs';
import { autofillFixture } from './native-autofill.mjs';
import { autofillViewFixture } from './native-autofill-view.mjs';
import { aiBlockDatabaseFixture } from './native-ai-block-database.mjs';
import { databaseBuildStoreFixture } from './native-database-build-store.mjs';
import { databaseBuildInput } from './native-database-build.mjs';

const SPACE = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const blockId = n => '44444444-4444-4444-8444-' + String(n).padStart(12, '0');
// Reading an opaque/unsupported block must still preserve its type and data.
// Media metadata is not proof that the model can see/hear its contents.
export const referencedBlockTypes = ['paragraph', 'heading_1', 'heading_2', 'heading_3', 'heading_4', 'bulleted_list_item', 'numbered_list_item', 'quote', 'to_do', 'toggle', 'callout', 'code', 'equation', 'divider', 'breadcrumb', 'table_of_contents', 'table', 'table_row', 'column_list', 'column', 'synced_block', 'link_to_page', 'child_page', 'child_database', 'image', 'video', 'audio', 'file', 'pdf', 'bookmark', 'embed', 'link_preview', 'tab', 'meeting_notes', 'unsupported'];

// Load the files copied by the real packager and exercise native input ->
// Agent -> scoped Router -> HTTP -> tool result -> model -> saved transcript.
export async function verifyPackagedReferences(sourceDirectory, root) {
  const require = createRequire(path.join(sourceDirectory, 'agent-mock.cjs'));
  const { AgentMock } = require('./agent-mock.cjs');
  const { NotionRouter } = require('./notion-routing.cjs');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'notion-connections.local.json'), JSON.stringify({ version: 2, connections: [{ workspaceId: SPACE, apiKey: 'synthetic-reference-test', enabled: true, readOnly: true }] }));
  const blocks = new Map(referencedBlockTypes.map((type, index) => [blockId(index), { object: 'block', id: blockId(index), type, parent: { type: 'page_id', page_id: PAGE }, has_children: type === 'table', [type]: { synthetic_marker: type + '-source' } }]));
  const calls = [], fetchImpl = async (url, options) => {
    const request = new URL(url); calls.push([options.method, request.pathname, request.search]);
    assert.equal(options.method, 'GET', 'Reference inspection must never write');
    let value;
    if (request.pathname === '/v1/users/me') value = { object: 'user', type: 'bot', bot: { workspace_id: SPACE, workspace_name: '合成引用测试' } };
    else if (request.pathname.endsWith('/children')) {
      const continued = request.searchParams.has('start_cursor');
      value = { results: [{ object: 'block', id: blockId(100 + Number(continued)), type: 'table_row', table_row: { cells: [[{ type: 'text', text: { content: continued ? 'second row' : 'first row' } }]] } }], has_more: !continued, next_cursor: continued ? null : 'second-batch' };
    } else if (request.pathname.startsWith('/v1/blocks/')) value = blocks.get(request.pathname.slice('/v1/blocks/'.length));
    if (!value) throw Error('Unexpected reference request: ' + request.pathname);
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
  const selection = { type: 'blocks', text: '', value: [...blocks.keys()].map(id => ({ table: 'block', id, spaceId: SPACE })) };
  let round = 0;
  const provider = { config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate({ messages, onToolCalls }) {
    const quote = messages.findLast(m => m.notionSwitchSelection);
    assert.deepEqual(JSON.parse(quote.content).value, selection.value);
    if (round++ === 0) {
      onToolCalls([...blocks.keys()].map((id, index) => ({ id: 'read-' + index, type: 'function', function: { name: 'read_block', arguments: JSON.stringify({ block_id: id }) } })));
    } else if (round === 2) {
      const results = messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
      assert.equal(results.length, referencedBlockTypes.length);
      assert.deepEqual(results.map(item => item.block.type), referencedBlockTypes);
      for (const item of results) { assert.equal(item.workspace_id, SPACE); assert.equal(item.block[item.block.type].synthetic_marker, item.block.type + '-source'); }
      onToolCalls([{ id: 'rows-1', type: 'function', function: { name: 'read_block_children', arguments: JSON.stringify({ block_id: blockId(referencedBlockTypes.indexOf('table')), page_size: 1 }) } }]);
    } else if (round === 3) {
      const result = JSON.parse(messages.at(-1).content);
      assert.equal(result.has_more, true); assert.equal(result.complete, false);
      onToolCalls([{ id: 'rows-2', type: 'function', function: { name: 'read_block_children', arguments: JSON.stringify({ block_id: blockId(referencedBlockTypes.indexOf('table')), page_size: 1, start_cursor: result.next_cursor }) } }]);
    } else {
      assert.equal(JSON.parse(messages.at(-1).content).complete, true);
      yield '所选引用已逐项读取（合成测试）。';
    }
  } };
  const stateFile = path.join(root, '引用 上下文.json');
  const agent = new AgentMock({ provider, workspace: new NotionRouter({ root, fetchImpl, intervalMs: 0 }), stateFile });
  agent.create({ spaceId: SPACE, threadId: 'packaged-reference-test', threadContext: { currentBlockId: PAGE, selectionPageId: PAGE, selection }, content: [{ type: 'text', text: '读取所有选中的引用；不要修改内容，也不要读取邻居页。' }] });
  for (let i = 0; agent.status().active && i < 200; i++) await sleep(5);
  assert.equal(agent.status().active, 0); assert.equal(agent.status().failed, 0); assert.equal(round, 4);
  assert.equal(calls.filter(([method, endpoint]) => endpoint.startsWith('/v1/blocks/') && !endpoint.endsWith('/children')).length, referencedBlockTypes.length);
  assert.ok(!JSON.stringify(calls).includes(OTHER));
  const restored = new AgentMock({ stateFile });
  const users = (await restored.transcript({ threadId: 'packaged-reference-test' }).json()).patches.filter(p => p.entity.kind === 'user_message');
  assert.deepEqual(users[0].entity.thread_context.selection, selection);
}

export async function verifyPackagedInlineReferences(sourceDirectory, root) {
  const require = createRequire(path.join(sourceDirectory, 'native-mock.cjs'));
  const { NativeMock } = require('./native-mock.cjs');
  const { NotionRouter } = require('./notion-routing.cjs');
  const { createInlineReferenceReader } = require('./inline-references.cjs');
  const table = blockId(201), extra = blockId(202), rows = [blockId(203), blockId(204)];
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'notion-connections.local.json'), JSON.stringify({ version: 2,
    connections: [{ workspaceId: SPACE, apiKey: 'synthetic-inline-reference', enabled: true, readOnly: true }] }));
  const calls = [], router = new NotionRouter({ root, intervalMs: 0, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'GET', 'Floating references must never write');
    const request = new URL(url); calls.push(request.pathname);
    let value;
    if (request.pathname === '/v1/users/me') value = { object: 'user', type: 'bot', bot: { workspace_id: SPACE, workspace_name: '合成引用验收' } };
    else if (request.pathname === '/v1/blocks/' + extra) return new Response(JSON.stringify({ message: 'synthetic not found' }), { status: 404 });
    else if (request.pathname === '/v1/pages/' + extra) value = { object: 'page', id: extra, parent: { type: 'workspace', workspace: true },
      properties: { title: { type: 'title', title: [{ plain_text: '附加合成页', text: { content: '附加合成页' } }] } } };
    else if (request.pathname === '/v1/pages/' + extra + '/markdown') value = { markdown: '附加完整页面青色927' };
    else if (request.pathname === '/v1/blocks/' + table) value = { object: 'block', id: table, type: 'table', has_children: true,
      parent: { type: 'page_id', page_id: PAGE }, table: { table_width: 1, has_column_header: false } };
    else if (request.pathname === '/v1/blocks/' + table + '/children') {
      const more = !request.searchParams.has('start_cursor');
      value = { results: [{ object: 'block', id: rows[more ? 0 : 1], type: 'table_row', has_children: false,
        parent: { type: 'block_id', block_id: table }, table_row: { cells: [[{ plain_text: more ? '第一行合成数据' : '第二行合成数据' }]] } }],
        has_more: more, next_cursor: more ? 'next-row' : null };
    }
    else assert.fail('Unexpected inline reference request: ' + request.pathname);
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  } });
  let modelRequests = 0;
  const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek' }), async* generate({ messages, tools }) {
    modelRequests++; assert.equal(tools, undefined);
    const prompt = JSON.stringify(messages);
    for (const text of ['附加完整页面青色927', '第一行合成数据', '第二行合成数据']) assert.ok(prompt.includes(text), text);
    yield '引用已完整读取。';
  } };
  const stateFile = path.join(root, 'conversation.json'), contextId = blockId(205);
  const native = new NativeMock({ stateFile, provider, workspace: router, inlineReferences: createInlineReferenceReader({ workspace: router }) });
  const input = { threadId: blockId(206), spaceId: SPACE, createdSource: 'writer', transcript: [
    { id: blockId(207), type: 'context', value: { blockId: PAGE } },
    { id: contextId, type: 'user-specified-context', value: { pointers: [{ table: 'block', id: extra, spaceId: SPACE }],
      blockSelection: { type: 'blocks', text: '', value: [{ table: 'block', id: table, spaceId: SPACE }] } } },
    { id: blockId(208), type: 'user', value: [['根据所有引用生成预览，不修改页面。']] }
  ] };
  const response = await native.handle('runInferenceTranscript', input), output = await response.text();
  assert.equal(modelRequests, 1); assert.ok(output.includes('引用已完整读取。'));
  assert.equal(calls.filter(name => name.endsWith('/children')).length, 2);
  const restored = new NativeMock({ stateFile });
  assert.deepEqual(restored.record(contextId, 'thread_message').step.value.pointers, input.transcript[1].value.pointers);
  assert.ok(!fs.readFileSync(path.join(root, 'inline-conversations.local.json'), 'utf8').includes('附加完整页面青色927'));
}

export async function verifyPackagedAiBlockSources(sourceDirectory) {
  const { generateAiBlock } = createRequire(path.join(sourceDirectory, 'native-ai-block.cjs'))('./native-ai-block.cjs');
  const ai = blockId(301), extra = blockId(302), content = blockId(303), excluded = blockId(304);
  const values = new Map([
    [PAGE, { id: PAGE, type: 'page', content: [ai, excluded] }],
    [ai, { id: ai, type: 'ai_block', parent_id: PAGE, format: { ai_block_configuration_menu: { type: 'custom',
      context: [{ type: 'page', pageId: extra }], searchScopes: [], autofillInstructions: [['概括所选页面']] } } }],
    [extra, { id: extra, type: 'page', content: [content] }],
    [content, { id: content, type: 'text', parent_id: extra, properties: { title: [['包内指定页青色927']] } }]
  ]);
  const store = { spaceId: SPACE, records: async ids => {
    assert.ok(!ids.includes(excluded), 'AI block must not read unselected current-page content');
    return new Map(ids.filter(id => values.has(id)).map(id => [id, { role: 'editor', value: values.get(id) }]));
  } };
  let called = 0;
  const provider = { config: () => ({}), async* generate({ messages, tools }) {
    called++; assert.equal(tools, undefined); assert.match(JSON.stringify(messages), /包内指定页青色927/); yield '已读取指定页';
  } };
  const response = await generateAiBlock({ input: { blockPointer: { table: 'block', id: ai, spaceId: SPACE },
    parentPagePointer: { table: 'block', id: PAGE, spaceId: SPACE } }, store, provider });
  assert.equal(called, 1); assert.equal(JSON.parse((await response.text()).trim()).markdownString, '已读取指定页');
  const database = aiBlockDatabaseFixture();
  database.provider.generate = async function* ({ messages, tools }) {
    assert.equal(tools, undefined); const content = JSON.stringify(messages);
    assert.match(content, /第三条市场资料/); assert.match(content, /青色927研发资料的正文/);
    assert.match(content, /view_filter_applied/); assert.ok(!content.includes('unselected-current-page-must-not-read'));
    yield '包内数据库引用已读取';
  };
  const databaseResponse = await generateAiBlock(database);
  assert.equal(JSON.parse(await databaseResponse.text()).markdownString, '包内数据库引用已读取'); assert.equal(database.writes().length, 0);
}

export async function verifyPackagedFormulaPreview(sourceDirectory) {
  const { NativeMock } = createRequire(path.join(sourceDirectory, 'native-mock.cjs'))('./native-mock.cjs');
  let calls = 0;
  const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({}), async* generate({ messages, tools }) {
    calls++; assert.equal(tools, undefined);
    assert.match(JSON.stringify(messages), /单价/); assert.ok(!JSON.stringify(messages).includes('must-not-forward'));
    yield '{"type":"formula","formula":"prop(\\"单价\\") * prop(\\"数量\\") + 927"}';
  } };
  const native = new NativeMock({ provider, workspace: { open: () => assert.fail('No formula write tools') } });
  const response = await native.handle('runInferenceTranscript', formulaInput());
  const frame = JSON.parse((await response.text()).trim());
  assert.equal(frame.type, 'generate-formula'); assert.equal(JSON.parse(frame.value).type, 'formula');
  assert.equal(calls, 1); assert.equal(native.status().activeTurns, 0);
}

export async function verifyPackagedAutofill(sourceDirectory, root) {
  const require = createRequire(path.join(sourceDirectory, 'native-autofill-jobs.cjs'));
  const { NativeAutofillJobs } = require('./native-autofill-jobs.cjs');
  const { NativeAutofillStore } = require('./native-autofill-store.cjs');
  const { pollNativeAutofill } = require('./compat/autofill.cjs');
  for (const fixture of [autofillFixture, autofillViewFixture]) {
    const f = fixture(), stateRoot = path.join(root, f.input.type); fs.mkdirSync(stateRoot, { recursive: true });
    const provider = { config: () => ({ mode: 'deepseek' }), async* generate({ tools, messages }) {
      assert.equal(tools, undefined); assert.ok(!JSON.stringify(messages).includes('must-not-read-unselected'));
      yield '{"summary":"包内青色927摘要","category":"研发","tags":["青色"]}';
    } };
    const service = new NativeAutofillJobs({ root: stateRoot, provider }), meta = { userId: f.ids.user, store: new NativeAutofillStore({ native: f.native }) };
    try {
      const response = await service.handle('triggerLiteAgentAutofill', f.input, undefined, meta), queued = await response.json();
      assert.equal(response.status, 200); let final;
      const environment = { currentUser: { id: f.ids.user }, api: { async callCellCompatibleApi(options) {
        const result = await service.handle(options.eventName, options.data, undefined, meta); assert.equal(result.status, 200);
        return { type: 'success', data: await result.json() };
      } } };
      const native = id => { if (id === 418819) return { S: { updateStatus: (_, counts) => { final = counts; } } }; assert.fail('Unexpected timeout'); };
      await pollNativeAutofill(environment, native, queued.notionSwitchAutofill, f.ids.space, 1); await service.wait(queued.groupId);
      assert.equal(final.success, 2); assert.equal(f.writes().length, 2);
      assert.equal(f.get('block', f.ids.first).properties.summary[0][0], '包内青色927摘要');
      if (f.input.type === 'viewFill') {
        assert.deepEqual(service.jobs.get(queued.groupId).info.rowIds, [f.ids.second, f.ids.first]);
        assert.ok(f.queries.length >= 4);
      }
      const restored = new NativeAutofillJobs({ root: stateRoot, provider });
      assert.equal(restored.record(queued.workflowAutomationRunIds[0], 'workflow_automation_run', { userId: f.ids.user, spaceId: f.ids.space }).status, 'success');
    } finally { service.close(); }
  }
}

// Exercise only the shipped pure selector. This does not read instruction pages
// or imply that their content is connected to the production model request.
export function verifyPackagedInstructionSelection(sourceDirectory) {
  const require = createRequire(path.join(sourceDirectory, 'native-instruction-selection.cjs'));
  const selection = require('./native-instruction-selection.cjs');
  const user = blockId(301), view = blockId(302), personal = blockId(303), skill = blockId(304);
  const entry = value => ({ role: 'editor', value });
  const fixture = { userId: user, spaceId: SPACE,
    root: entry({ id: user, space_view_pointers: [{ table: 'space_view', id: view, spaceId: SPACE }] }),
    view: entry({ id: view, space_id: SPACE, parent_table: 'user_root', parent_id: user,
      settings: { agent_personalization_settings: { context_page_id: personal }, ai_prompts: { installed_skill_page_ids: [skill] } } }),
    workspace: entry({ id: SPACE, settings: {} }) };
  const result = selection.selectInstructionSettings(fixture);
  assert.equal(result.personalPageId, personal); assert.deepEqual(result.automaticSkillIds, [skill]);
  assert.ok(!Object.hasOwn(result, 'body')); assert.ok(!Object.hasOwn(result, 'text'));
  assert.throws(() => selection.selectInstructionSettings({ ...fixture, userId: OTHER }), /账号|工作区/);
  assert.deepEqual(selection.explicitPages([{ type: 'text', text: [['合成技能', [['p', skill, SPACE]]]] }], SPACE), [{ pageId: skill, spaceId: SPACE }]);
  const reference = { pageId: skill, spaceId: SPACE, page: entry({ id: skill, space_id: SPACE, type: 'page' }) };
  assert.equal(selection.classifyReference(reference).kind, 'page_reference');
  const prompt = entry({ id: selection.promptId(skill), space_id: SPACE, parent_id: skill, parent_table: 'block', prompt_type: 'skill' });
  assert.equal(selection.classifyReference({ ...reference, prompt }).kind, 'skill_candidate');
  fixture.workspace.value.settings.disable_agent_skills = true;
  assert.deepEqual(selection.selectInstructionSettings(fixture).automaticSkillIds, []);
}

export async function verifyPackagedConversationScope(sourceDirectory) {
  const require = createRequire(path.join(sourceDirectory, 'native-mock.cjs'));
  const { NativeMock } = require('./native-mock.cjs'), { localRecords } = require('./local-records.cjs');
  const userId = blockId(401), otherUser = blockId(402), threadId = blockId(403); let calls = 0;
  const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek' }), async* generate() { calls++; yield '包内合成历史'; } };
  const native = new NativeMock({ provider });
  await native.handle('createAgentThread', { spaceId: SPACE, threadId, content: [{ type: 'text', text: '合成账号甲的问题' }] }, undefined, { userId });
  for (let i = 0; native.status().activeTurns && i < 500; i++) await sleep(2);
  assert.equal(native.status().activeTurns, 0); assert.equal(calls, 1);
  assert.equal((await native.handle('getThreadTranscript', { threadId }, undefined, { userId: otherUser })).status, 403);
  assert.equal((await native.handle('sendEventToAgentThread', { threadId, event: { type: 'interrupt' } }, undefined, { userId: otherUser })).status, 403);
  const input = { requests: [{ table: 'thread', id: threadId, spaceId: SPACE }] };
  const request = new Request('https://app.notion.com/api/v3/getRecordValues', { method: 'POST', headers: { 'x-notion-active-user-header': otherUser }, body: JSON.stringify(input) });
  const denied = await (await localRecords(request, input, 'getRecordValues', native, () => assert.fail('Local records must not reach the server'), () => {})).json();
  assert.deepEqual(denied.results, [{ role: 'none' }]);
  assert.equal(native.record(threadId, 'thread', { userId, spaceId: SPACE }).created_by_id, userId);
  assert.equal(native.record(threadId, 'thread', { userId, spaceId: OTHER }), undefined);
}

export async function verifyPackagedWebSources(sourceDirectory, root) {
  const require = createRequire(path.join(sourceDirectory, 'native-mock.cjs'));
  const { NativeMock } = require('./native-mock.cjs'), { WebSources } = require('./web-sources.cjs');
  fs.mkdirSync(root, { recursive: true });
  const userId = blockId(451), threadId = blockId(452); let reads = 0;
  const webSources = new WebSources({ root, fetchPublic: async url => { reads++; return { url, headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>包内网页</title><main><p>蓝色包内资料927</p><script>must-not-execute</script></main>') }; } });
  webSources.save({ enabled: 'enabled' });
  const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate({ messages, tools, onToolCalls }) {
    assert.ok(tools.some(value => value.function.name === 'read_web_page')); assert.ok(!tools.some(value => value.function.name === 'search_web'));
    if (!messages.some(value => value.role === 'tool')) { onToolCalls([{ id: 'packaged-web', type: 'function', function: { name: 'read_web_page', arguments: '{"url":"https://example.com/article"}' } }]); return; }
    const result = JSON.parse(messages.findLast(value => value.role === 'tool').content); assert.equal(result.complete, true); assert.ok(result.text.includes('蓝色包内资料927')); assert.ok(!result.text.includes('must-not-execute'));
    yield '[包内网页](https://example.com/article)';
  } };
  const native = new NativeMock({ provider, webSources });
  try {
    await native.handle('createAgentThread', { type: 'personal_agent', spaceId: SPACE, threadId, content: [{ type: 'text', text: '解释 https://example.com/article' }] }, undefined, { userId });
    for (let i = 0; native.status().activeTurns && i < 500; i++) await sleep(2);
    assert.equal(native.status().activeTurns, 0); assert.equal(native.agent.status().failed, 0); assert.equal(reads, 1); assert.equal(webSources.sessions.size, 0);
    for (const file of ['vendor/parse5/LICENSE', 'vendor/entities/LICENSE', 'vendor/web-parser.manifest.json']) assert.ok(fs.existsSync(path.join(sourceDirectory, file)));
  } finally { for (const item of native.agent.threads.values()) item.stop?.('cleanup'); webSources.close(); }
}

// This validates the workspace-source preparation only. Private workspace body
// forwarding remains unsupported; the separate public-web branch is tested below.
export async function verifyPackagedResearchScope(sourceDirectory, root) {
  const require = createRequire(path.join(sourceDirectory, 'native-research.cjs'));
  const { normalizeResearch } = require('./native-research.cjs'), { researchWorkspace } = require('./research-scope.cjs');
  const { InlineRecords } = require('./inline-records.cjs'), { NativeMock } = require('./native-mock.cjs');
  fs.mkdirSync(root, { recursive: true });
  const threadId = blockId(471), pageId = blockId(472), userId = blockId(473);
  const input = { threadId, spaceId: SPACE, transcript: [
    { id: blockId(474), type: 'config', value: { type: 'workflow', isAgentResearchRequest: true, searchScopes: [{ type: 'page', pageId }], useWebSearch: false } },
    { id: blockId(475), type: 'context', value: { spaceId: SPACE, userEmail: 'excluded-profile', clientRenderedPages: { page: 'excluded-page-snapshot' } } },
    { id: blockId(476), type: 'user', value: [['比较包内合成研究资料']] }
  ] };
  const normalized = normalizeResearch(input, userId); assert.ok(!JSON.stringify(normalized).includes('excluded-'));
  let reads = 0;
  const workspace = { open: async options => {
    assert.deepEqual(options.readScope, { workspaceId: SPACE, rootIds: [pageId] });
    return { context: { current_workspace_id: SPACE, read_scope: { workspace_id: SPACE, root_ids: [pageId], read_only: true } },
      definitions: ['read_page', 'append_page'].map(name => ({ type: 'function', function: { name } })),
      execute: async () => { reads++; return { page_id: pageId, workspace_id: SPACE, markdown: '包内纯内存研究资料' }; } };
  } };
  const session = await researchWorkspace(workspace, { spaceId: SPACE, config: normalized.config }).open();
  assert.deepEqual(session.definitions.map(value => value.function.name), ['read_page']);
  await assert.rejects(session.execute('append_page', {})); await assert.rejects(session.execute('read_page', { workspace_id: OTHER }));
  assert.equal(reads, 0); assert.match((await session.execute('read_page', { page_id: pageId })).markdown, /纯内存/);
  const file = path.join(root, '研究历史.json'), records = new InlineRecords(file);
  const generated = { id: blockId(477), type: 'agent-inference', value: [{ type: 'text', content: '仅为合成存储验收' }] };
  records.snapshot(normalized.input, generated, 'running', userId, { source: 'researcher' });
  const restored = new InlineRecords(file); assert.equal(restored.record(threadId).data.notion_switch_research.status, 'interrupted');
  assert.equal(restored.record(threadId, 'thread', { userId: OTHER, spaceId: SPACE }), undefined);
  const native = new NativeMock({ provider: { status: () => ({ mode: 'deepseek' }), generate: () => assert.fail('No model integration') }, workspace: { open: () => assert.fail('No production body reader') } });
  assert.equal((await native.handle('runInferenceTranscript', input, undefined, { userId })).status, 501);
}

export async function verifyPackagedNativeWebResearch(sourceDirectory, root) {
  const require = createRequire(path.join(sourceDirectory, 'native-mock.cjs'));
  const { NativeMock } = require('./native-mock.cjs'), { WebSources } = require('./web-sources.cjs');
  fs.mkdirSync(root, { recursive: true }); let modelCalls = 0, reads = 0;
  const webSources = new WebSources({ root, fetchPublic: async url => { reads++; return { url, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>包内公开研究代码927-' + reads + '</main>') }; } });
  webSources.save({ enabled: 'enabled' });
  const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate({ messages, tools, onToolCalls }) {
    modelCalls++; assert.ok(tools.every(value => ['read_web_page', 'read_task_progress'].includes(value.function.name)));
    if (!messages.some(value => value.role === 'tool')) { onToolCalls([{ id: 'packaged-research-' + modelCalls, type: 'function', function: { name: 'read_web_page', arguments: '{"url":"https://example.com/native-research"}' } }]); return; }
    yield '包内报告：' + JSON.parse(messages.findLast(value => value.role === 'tool').content).text + ' [来源](https://example.com/native-research)';
  } };
  const options = { provider, webSources, stateFile: path.join(root, 'conversations.json'), workspace: { open: () => assert.fail('Public research cannot open a Notion connection') } };
  let native = new NativeMock(options);
  try {
    for (const variant of [0, 1]) {
      const base = 600 + variant * 10, threadId = blockId(base), userId = blockId(base + 1), configId = blockId(base + 2), questionId = blockId(base + 3);
      const config = variant ? { type: 'workflow', isAgentResearchRequest: true, searchScopes: [{ type: 'web' }], useWebSearch: true } : { type: 'researcher', searchScope: { type: 'web' }, useWebSearch: true };
      const input = { threadId, spaceId: SPACE, asPatchResponse: !!variant, transcript: [
        { id: configId, type: 'config', value: config }, { id: questionId, type: 'user', value: [['研究 https://example.com/native-research 的合成资料']] }
      ] };
      const response = await native.handle('runInferenceTranscript', input, undefined, { userId }); assert.equal(response.status, 200);
      const events = (await response.text()).trim().split('\n').map(JSON.parse); assert.ok(events.some(value => value.type === (variant ? 'patch-start' : 'agent-inference')));
      assert.match(JSON.stringify(events), /包内公开研究代码927/); assert.equal(webSources.sessions.size, 0);
      const thread = native.record(threadId), nextId = blockId(base + 4), transaction = { transactions: [{ spaceId: SPACE, operations: [
        { pointer: { table: 'thread_message', id: nextId }, command: 'set', path: [], args: { id: nextId, parent_id: threadId, parent_table: 'thread', space_id: SPACE,
          step: { id: nextId, type: 'user', value: [['继续核对同一合成来源']] } } },
        { pointer: { table: 'thread', id: threadId }, command: 'listAfter', path: ['messages'], args: { id: nextId, after: thread.messages.at(-1) } }
      ] }] };
      assert.equal(native.transactions(transaction, { userId }).status, 200); native.close(); native = new NativeMock(options);
      const reply = await native.handle('runInferenceTranscript', { threadId, spaceId: SPACE, transcript: [], asPatchResponse: true }, undefined, { userId });
      assert.equal(reply.status, 200); assert.match(await reply.text(), /包内公开研究代码927/);
      assert.equal(native.record(threadId).data.notion_switch_research.status, 'completed');
      assert.equal((await native.handle('runInferenceTranscript', input, undefined, { userId: OTHER })).status, 403);
    }
    assert.equal(modelCalls, 8); assert.equal(reads, 4); assert.equal(webSources.sessions.size, 0);
  } finally { native.close(); webSources.close(); clearTimeout(native.agent.saveTimer); }
}

export async function verifyPackagedDatabaseBuild(sourceDirectory) {
  const require = createRequire(path.join(sourceDirectory, 'native-database-build-store.cjs'));
  const { NativeBuildStore } = require('./native-database-build-store.cjs');
  const { buildMessages, parseBuildOutput } = require('./native-database-build.cjs');
  const f = databaseBuildStoreFixture(), store = new NativeBuildStore({ native: f.native });
  const plan = await store.prepare(parseBuildOutput(JSON.stringify(f.draft)), f.parentPointer);
  assert.equal(f.writes().length, 0); assert.equal(plan.step.state, 'confirmation:requested');
  await store.submit(plan, { confirmation: f.confirmation(plan) }); assert.equal((await store.verify(plan)).ok, true);
  assert.equal((await store.submit(plan, { confirmation: f.confirmation(plan) })).reused, true); assert.equal(f.writes().length, 1);
  assert.equal(typeof buildMessages, 'function');
  const { NativeBuildService } = require('./native-build-service.cjs');
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-packaged-builder-'));
  const fixture = databaseBuildStoreFixture(), nativeStore = new NativeBuildStore({ native: fixture.native });
  fixture.draft.views = [{ name: '表格', type: 'table' }, { name: '状态看板', type: 'board', groupBy: '状态' },
    { name: '日历', type: 'calendar', dateBy: '截止日期' }, { name: '列表', type: 'list' }, { name: '画廊', type: 'gallery' },
    { name: '时间轴', type: 'timeline', dateBy: '截止日期' }];
  const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({}), async* generate() { yield JSON.stringify(fixture.draft); } };
  const options = { root, provider, storeFactory: () => nativeStore }, service = new NativeBuildService(options);
  try {
    const meta = { userId: fixture.ids.user }, response = await service.stream(databaseBuildInput(), undefined, meta);
    const frames = (await response.text()).trim().split('\n').map(JSON.parse), step = frames.flatMap(frame => frame.data?.s || []).find(step => step.type === 'agent-tool-result');
    assert.ok(step); assert.equal(fixture.writes().length, 0);
    const plan = service.threads.get(databaseBuildInput().threadId).plans[0].plan;
    assert.equal(plan.viewIds.length, 6); assert.deepEqual(plan.draft.views, fixture.draft.views);
    assert.equal(service.recordRole(plan.collectionId, 'collection', { ...meta, spaceId: fixture.ids.space }), 'reader');
    const transaction = { transactions: [{ spaceId: fixture.ids.space, operations: [{ pointer: { table: 'thread_message', id: step.id, spaceId: fixture.ids.space }, command: 'update', path: ['step'], args: { ...step, state: 'confirmation:confirmed' } }] }] };
    assert.equal((await service.transactions(transaction, undefined, meta)).status, 200); assert.equal(fixture.writes().length, 1);
    const restored = new NativeBuildService(options);
    try { assert.equal((await restored.transactions(transaction, undefined, meta)).status, 200); assert.equal(fixture.writes().length, 1);
      assert.equal((await nativeStore.verify(plan)).ok, true); }
    finally { restored.close(); await restored.whenIdle(); }
  } finally { service.close(); await service.whenIdle(); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); }
}
