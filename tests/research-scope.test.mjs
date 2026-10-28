import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NotionWorkspace } = require('../src/notion-tools.cjs');
const { NotionRouter, registryName } = require('../src/notion-routing.cjs');
const { researchWorkspace } = require('../src/research-scope.cjs');
const { researchConfig } = require('../src/native-research.cjs');
const { writeTools } = require('../src/notion-capabilities.cjs');
const id = n => 'ba00aa00-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
const SPACE = id(1), OTHER = id(2), ROOT = id(10), CHILD = id(11), OUTSIDE = id(12), DB = id(20), SOURCE = id(21), SIBLING = id(22), ROW = id(23);
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture(t) {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-research-中文 空格-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const profiles = [{ workspaceId: SPACE, apiKey: 'synthetic-key-one', searchBatchSize: 25 }, { workspaceId: OTHER, apiKey: 'synthetic-key-two' }];
  const save = () => fs.writeFileSync(path.join(root, registryName), JSON.stringify({ version: 2, connections: profiles })); save();
  const parents = new Map([[ROOT, { workspace: true }], [CHILD, { page_id: ROOT }], [OUTSIDE, { workspace: true }], [DB, { page_id: ROOT }],
    [SOURCE, { database_id: DB }], [SIBLING, { database_id: DB }], [ROW, { data_source_id: SOURCE }]]), calls = [];
  const page = value => ({ object: 'page', id: value, parent: parents.get(value), properties: { title: { type: 'title', title: [{ plain_text: '合成 ' + value }] } }, url: 'https://www.notion.so/' + value });
  const source = value => ({ object: 'data_source', id: value, parent: parents.get(value), properties: { Name: { id: 'title', type: 'title', title: {} } }, title: [{ plain_text: '合成数据源' }] });
  const fetchImpl = async (url, options) => {
    assert.ok(url.startsWith('https://api.notion.com/v1/'));
    const endpoint = url.slice('https://api.notion.com/v1/'.length), body = options.body && JSON.parse(options.body);
    const wid = options.headers.authorization === 'Bearer synthetic-key-one' ? SPACE : options.headers.authorization === 'Bearer synthetic-key-two' ? OTHER : assert.fail('Unknown synthetic key');
    calls.push({ endpoint, method: options.method, body, wid });
    assert.ok(options.method === 'GET' || options.method === 'POST' && (endpoint === 'search' || endpoint.endsWith('/query')), 'No remote writes in synthetic fixture');
    if (endpoint === 'users/me') return json({ type: 'bot', bot: { workspace_id: wid, workspace_name: '合成工作区' } });
    if (endpoint === 'search') return json({ results: body.filter.value === 'data_source' ? [source(SOURCE), source(SIBLING)] : [ROOT, CHILD, OUTSIDE, ROW].map(page), has_more: false });
    const [resource, value, action] = endpoint.split('/');
    if (resource === 'pages' && action === 'markdown') return json({ markdown: '合成正文 ' + value });
    if (resource === 'pages' && parents.has(value)) return json(page(value));
    if (resource === 'data_sources' && !action) return json(source(value));
    if (resource === 'data_sources' && action === 'query') return json({ results: [page(ROW)], has_more: false });
    if (resource === 'databases') return json({ id: DB, object: 'database', parent: parents.get(DB), data_sources: [{ id: SOURCE }, { id: SIBLING }], title: [] });
    assert.fail('Unexpected synthetic endpoint ' + endpoint);
  };
  const workspace = new NotionWorkspace({ root, profile: profiles[0], fetchImpl, intervalMs: 0 });
  return { root, profiles, save, parents, calls, workspace, router: new NotionRouter({ root, fetchImpl, intervalMs: 0 }) };
}

test('selected page search verifies ancestry before reading Markdown and does not treat excluded pages as incomplete', async t => {
  const f = fixture(t), session = f.workspace.open({ scopePageIds: [ROOT] });
  const result = await session.execute('search_pages', { query: '合成', scope: 'content' });
  assert.deepEqual(result.results.map(value => value.page_id), [ROOT, CHILD, ROW]); assert.equal(result.complete, true);
  assert.equal(f.calls.some(value => value.endpoint === 'pages/' + OUTSIDE + '/markdown'), false);
  for (const child of [CHILD, ROW]) {
    const metadata = f.calls.findIndex(value => value.endpoint === 'pages/' + child), body = f.calls.findIndex(value => value.endpoint === 'pages/' + child + '/markdown');
    assert.ok(metadata >= 0 && metadata < body);
  }
  assert.ok(session.definitions.every(value => !writeTools.has(value.function.name)));
});

test('page placement is rechecked before each scoped read and cannot reuse a prior descendant permission after moving', async t => {
  const f = fixture(t), session = f.workspace.open({ scopePageIds: [ROOT] });
  await session.execute('read_page', { page_id: CHILD });
  const before = f.calls.filter(value => value.endpoint.endsWith('/markdown')).length;
  f.parents.set(CHILD, { page_id: OUTSIDE });
  await assert.rejects(session.execute('read_page', { page_id: CHILD }), error => error.code === 'NOTION_RESEARCH_SCOPE');
  assert.equal(f.calls.filter(value => value.endpoint.endsWith('/markdown')).length, before);
  await assert.rejects(session.execute('append_page', { page_id: ROOT, revision: 'invented', content: '禁止写入' }), /只读/);
});

test('per-turn scope intersects local connection authorization rather than granting extra pages', async t => {
  const f = fixture(t); f.profiles[0].pageIds = [OUTSIDE];
  const session = f.workspace.open({ scopePageIds: [ROOT] });
  await assert.rejects(session.execute('read_page', { page_id: ROOT }), /本地授权/);
  assert.equal(f.calls.some(value => value.endpoint.endsWith('/markdown')), false);
});

test('moving a selected root outside the connection allowlist invalidates cached descendant permissions', async t => {
  const f = fixture(t); f.profiles[0].pageIds = [OUTSIDE]; f.parents.set(ROOT, { page_id: OUTSIDE });
  const session = f.workspace.open({ scopePageIds: [ROOT] }); await session.execute('read_page', { page_id: CHILD });
  f.parents.set(ROOT, { workspace: true });
  const before = f.calls.filter(value => value.endpoint.endsWith('/markdown')).length;
  await assert.rejects(session.execute('read_page', { page_id: CHILD }), /本地授权/);
  assert.equal(f.calls.filter(value => value.endpoint.endsWith('/markdown')).length, before);
});

test('research router opens only the selected configured workspace and rejects all or writes before any request', async t => {
  const f = fixture(t), session = await f.router.open({ nativeContext: { workspace_id: SPACE, page_id: ROOT }, readScope: { workspaceId: SPACE, rootIds: [ROOT] } });
  assert.deepEqual(session.context.read_scope, { workspace_id: SPACE, root_ids: [ROOT], read_only: true });
  assert.deepEqual(session.context.workspaces.map(value => value.workspace_id), [SPACE]); assert.ok(f.calls.every(value => value.wid === SPACE));
  assert.equal(session.context.workspaces[0].read_only, true);
  assert.ok(session.definitions.every(value => !writeTools.has(value.function.name)));
  const schema = session.definitions.find(value => value.function.name === 'read_page').function.parameters.properties.workspace_id;
  assert.deepEqual(schema.enum, ['current', SPACE]);
  const before = f.calls.length;
  for (const [name, args] of [['search_pages', { query: '', scope: 'title', workspace_id: 'all' }], ['read_page', { page_id: ROOT, workspace_id: OTHER }],
    ['create_page', { parent_page_id: ROOT, title: '禁止' }]]) await assert.rejects(session.execute(name, args), /只允许读取/);
  assert.equal(f.calls.length, before);
  assert.match((await session.execute('read_page', { page_id: 'current' })).markdown, /合成正文/);
  await assert.rejects(f.router.open({ nativeContext: { workspace_id: OTHER }, readScope: { workspaceId: SPACE } }), /范围无效/);
});

test('selected data source opens without sibling enumeration and never queries sibling rows', async t => {
  const f = fixture(t), config = researchConfig({ type: 'researcher', searchScope: { type: 'collection', pageId: DB, collectionId: SOURCE } });
  const session = await researchWorkspace(f.router, { spaceId: SPACE, config }).open({ nativeContext: { workspace_id: SPACE } });
  const schema = await session.execute('read_database', { database_id: DB }); assert.equal(schema.data_source_id, SOURCE);
  assert.equal(f.calls.some(value => value.endpoint === 'databases/' + DB || value.endpoint === 'data_sources/' + SIBLING), false);
  const found = await session.execute('search_databases', { query: '' });
  assert.deepEqual(found.results.map(value => value.data_source_id), [SOURCE]); assert.equal(found.complete, true);
  const rows = await session.execute('query_database', { data_source_id: SOURCE }); assert.equal(rows.results[0].page_id, ROW);
  assert.match((await session.execute('read_page', { page_id: ROW })).markdown, /合成正文/);
  await assert.rejects(session.execute('read_database', { data_source_id: SIBLING }), /本轮研究/);
  assert.equal(f.calls.some(value => value.endpoint === 'databases/' + DB), true, 'Sibling ancestry can check database parent metadata');
  // Ancestry can request source metadata to prove exclusion; it cannot read a
  // sibling query or body, and opening the selected collection never enumerates
  // database.data_sources through read_database(database_id).
  assert.equal(f.calls.some(value => value.endpoint === 'data_sources/' + SIBLING + '/query'), false);
});

test('unscoped workspace behavior keeps normal tools and configured connections', async t => {
  const f = fixture(t), session = await f.router.open({ nativeContext: { workspace_id: SPACE } });
  assert.ok(session.definitions.some(value => value.function.name === 'append_page'));
  assert.deepEqual(session.context.workspaces.map(value => value.workspace_id), [SPACE, OTHER]); assert.equal(session.context.read_scope, undefined);
});
