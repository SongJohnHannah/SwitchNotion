import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { aiBlockDatabaseFixture } from './helpers/native-ai-block-database.mjs';
import { autofillId } from './helpers/native-autofill.mjs';
const { generateAiBlock } = createRequire(import.meta.url)('../src/native-ai-block.cjs');
const { uuid } = createRequire(import.meta.url)('../src/native-context.cjs');
const sourceData = f => JSON.parse(f.requests[0].messages.at(-1).content.split('所选来源资料：\n')[1]);

test('AI block reads an explicit database schema, all record properties and own body without borrowing the visible view filter', async () => {
  const f = aiBlockDatabaseFixture(), response = await generateAiBlock(f);
  assert.equal(JSON.parse(await response.text()).markdownString, '数据库合成摘要');
  const [source] = sourceData(f);
  assert.equal(source.type, 'database'); assert.equal(source.collection_id, f.ids.collection);
  assert.equal(source.scope.view_filter_applied, false); assert.equal(source.scope.expand_child_pages, false);
  assert.equal(source.rows.length, 3); assert.equal(source.fields.find(field => field.id === 'category').type, 'select');
  assert.match(source.rows.find(row => row.page_id === f.ids.first).text, /青色927研发资料的正文/);
  assert.equal(source.rows.find(row => row.page_id === f.ids.unselected).properties.category.text, '市场');
  assert.deepEqual(source.rows.find(row => row.page_id === f.ids.first).unread_media, [{ block_id: f.mediaId, type: 'pdf', body_available: false }]);
  assert.equal(f.requests[0].tools, undefined); assert.ok(!JSON.stringify(f.requests).includes('unselected-current-page-must-not-read'));
  assert.ok(!f.calls.some(call => call.endpoint === 'getRecordValues' && call.payload.requests.some(pointer => pointer.id === f.excludedId)));
  assert.equal(f.queries[0].loader.filter, undefined); assert.equal(f.queries[0].loader.sort, undefined);
  assert.deepEqual(f.queries[0].loader.reducers, { results: { type: 'results', limit: 201, loadContentCover: false } });
  assert.equal(f.writes().length, 0);
});

test('AI block preserves mixed explicit source order and deduplicates the same database', async () => {
  const f = aiBlockDatabaseFixture(), config = f.get('block', f.aiId).format.ai_block_configuration_menu;
  config.context = [{ type: 'page', pageId: f.ids.first }, ...config.context, ...config.context];
  await generateAiBlock(f); const sources = sourceData(f);
  assert.equal(sources.length, 2); assert.equal(sources[0].page_id, f.ids.first); assert.equal(sources[1].collection_id, f.ids.collection);
  assert.equal(f.queries.length, 2, 'One complete read plus one membership recheck');
});

test('database references require valid source ownership, reader access and complete bounded results before model invocation', async () => {
  const variants = [f => { f.get('block', f.ids.parent).collection_id = autofillId(98); },
    f => { f.view.parent_id = autofillId(99); },
    f => { f.setRole('none'); },
    f => { f.get('block', f.ids.first).parent_id = autofillId(99); },
    f => { f.get('collection', f.ids.collection).space_id = autofillId(99); },
    f => { delete f.get('block', f.ids.parent).view_ids; }];
  for (const result of [
    { type: 'results', hasMore: true, blockIds: [autofillId(6)] },
    { type: 'results', blockIds: [] },
    { type: 'results', hasMore: false, blockIds: [autofillId(6), autofillId(6)] },
    { type: 'results', hasMore: false, blockIds: Array.from({ length: 201 }, (_, n) => autofillId(1000 + n)) }
  ]) variants.push(f => f.setQuery(() => ({ result: { reducerResults: { results: result } } })));
  for (const change of variants) {
    const f = aiBlockDatabaseFixture(); change(f); await assert.rejects(generateAiBlock(f));
    assert.equal(f.requests.length, 0); assert.equal(f.writes().length, 0);
  }
});

test('AI block rejects changed schema, record content or database membership after generation', async () => {
  for (const change of [f => { f.get('collection', f.ids.collection).schema.summary.name = '生成期间改名'; },
    f => { f.get('block', f.ids.body1).properties.title = [['生成期间改正文']]; },
    f => { f.setQuery(() => ({ result: { reducerResults: { results: { type: 'results', hasMore: false, blockIds: [f.ids.first] } } } })); }]) {
    const f = aiBlockDatabaseFixture();
    f.provider.generate = async function* () { yield '未提交预览'; change(f); };
    await assert.rejects(generateAiBlock(f), /变化|过期|不完整/); assert.equal(f.writes().length, 0);
  }
});

test('source permission revocation during generation prevents the preview even if a stale value is still returned', async () => {
  const f = aiBlockDatabaseFixture(), original = f.store.api; let revoked = false;
  f.store.api = async (...args) => {
    const result = await original(...args);
    if (revoked && args[0] === 'getRecordValues') result.results.forEach(record => { if (record.value?.id === f.ids.body1) record.role = 'none'; });
    return result;
  };
  f.provider.generate = async function* () { yield '未提交预览'; revoked = true; };
  await assert.rejects(generateAiBlock(f), /权限|变化/); assert.equal(f.writes().length, 0);
});

test('AI block represents an empty database explicitly and never fabricates record content', async () => {
  const f = aiBlockDatabaseFixture(); f.setQuery(() => ({ result: { reducerResults: { results: { type: 'results', hasMore: false, blockIds: [] } } } }));
  await generateAiBlock(f); const [source] = sourceData(f);
  assert.deepEqual(source.rows, []); assert.equal(source.scope.complete, true); assert.ok(source.fields.length > 0); assert.equal(f.writes().length, 0);
});

test('AI block stops an aborted database read and rejects excess source data without sending it to the model', async () => {
  const a = aiBlockDatabaseFixture(), controller = new AbortController();
  a.setQuery(() => { controller.abort(); return { result: { reducerResults: { results: { type: 'results', hasMore: false, blockIds: [] } } } }; });
  await assert.rejects(generateAiBlock({ ...a, signal: controller.signal }), /abort/i); assert.equal(a.requests.length, 0);
  const b = aiBlockDatabaseFixture(); b.get('block', b.ids.first).properties.summary = [['x'.repeat(160001)]];
  await assert.rejects(generateAiBlock(b), /过长|过多|范围/); assert.equal(b.requests.length, 0); assert.equal(b.writes().length, 0);
});

test('database readers may read a source while child pages and linked relation targets remain unexpanded', async () => {
  const f = aiBlockDatabaseFixture(), nested = autofillId(60), hidden = autofillId(61), relation = autofillId(62);
  f.records.set('block:' + nested, { id: nested, alive: true, space_id: f.ids.space, type: 'page', parent_table: 'block', parent_id: f.ids.first,
    content: [hidden], properties: { title: [['未展开的子页标题']] } });
  f.get('block', f.ids.first).content.push(nested);
  f.get('block', f.ids.first).properties.related = [['‣', [['p', relation, f.ids.space]]]];
  const original = f.store.api;
  f.store.api = async (...args) => {
    const response = await original(...args);
    if (args[0] === 'getRecordValues') response.results.forEach(record => { if (record.value?.id !== f.aiId) record.role = 'reader'; });
    return response;
  };
  await generateAiBlock(f);
  assert.match(sourceData(f)[0].rows[0].text, /未展开的子页标题/);
  assert.ok(!f.calls.some(call => call.endpoint === 'getRecordValues' && call.payload.requests.some(pointer => [hidden, relation].includes(pointer.id))));
  assert.equal(f.writes().length, 0);
});

test('the actual desktop route returns database-backed AI block Markdown without forwarding hosted inference', async () => {
  const f = aiBlockDatabaseFixture(), source = fs.readFileSync(new URL('../src/desktop-hook.cjs', import.meta.url), 'utf8');
  f.provider.status = () => ({ mode: 'deepseek' });
  const route = vm.runInNewContext(source.slice(source.indexOf('async function route('), source.indexOf('\nfunction install(ses)')) + '\nroute', {
    Request, Response, Headers, URL, uuid, generateAiBlock, provider: f.provider,
    settings: { speech: { enabled: false }, isLoginSyncing: () => false }, nativeSpeech: { enabled: false },
    meetingBridge: { observe() {}, forRequest: (_request, _session, spaceId) => { assert.equal(spaceId, f.ids.space); return f.store; } },
    recordings: { wake() {} }, log() {}, localUploadPrefix: '/notion-switch-local-upload/', isNotion: host => host === 'app.notion.com',
    endpoints: new Set(['runInferenceTranscript']), json: (value, status = 200) => new Response(JSON.stringify(value), { status })
  });
  const response = await route(new Request('https://app.notion.com/api/v3/generateAiBlock', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-notion-active-user-header': f.ids.user }, body: JSON.stringify(f.input)
  }), () => assert.fail('AI block inference must stay local'));
  assert.equal(response.status, 200); assert.equal(JSON.parse(await response.text()).markdownString, '数据库合成摘要');
  assert.equal(f.requests.length, 1); assert.equal(f.writes().length, 0);
});
