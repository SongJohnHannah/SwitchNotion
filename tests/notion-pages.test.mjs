import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createSession, definitions, writeTools } = createRequire(import.meta.url)('../src/notion-pages.cjs');
const PARENT = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';
const DESTINATION = '33333333-3333-4333-8333-333333333333';
const CREATED = '44444444-4444-4444-8444-444444444444';
const clone = value => structuredClone(value);
function fixture(extra = {}) {
  const make = (id, title, parent = PARENT) => ({ object: 'page', id, url: `https://www.notion.so/${id.replaceAll('-', '')}`, parent: { type: 'page_id', page_id: parent }, properties: { Name: { type: 'title', title: [{ plain_text: title, text: { content: title } }] } }, icon: null, cover: null, in_trash: false, is_locked: false, last_edited_time: '2026-10-22T00:00:00.000Z' });
  const pages = new Map([[PARENT, make(PARENT, '授权父页')], [PAGE, make(PAGE, '待编辑页面')], [DESTINATION, make(DESTINATION, '目标父页')]]);
  const contents = new Map(), calls = [], authorizations = [], mutations = [];
  let version = 0;
  const request = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body: clone(body) });
    if (extra.request) { const response = await extra.request({ method, endpoint, body, pages, contents }); if (response) return response; }
    if (method === 'POST' && endpoint === 'pages') {
      const page = make(CREATED, '', body.parent.page_id); page.properties = clone(body.properties);
      pages.set(CREATED, page); contents.set(CREATED, body.markdown || ''); return clone(page);
    }
    const id = endpoint.split('/')[1], page = pages.get(id);
    if (!page) throw Error('Notion API 返回 HTTP 404。');
    if (method === 'GET') return endpoint.endsWith('/markdown') ? { markdown: contents.get(id) || '', truncated: false, unknown_block_ids: [] } : clone(page);
    if (method === 'PATCH') {
      if (body.properties) for (const [name, value] of Object.entries(body.properties)) page.properties[name] = { ...page.properties[name], ...clone(value), type: 'title' };
      for (const key of ['icon', 'cover', 'in_trash', 'is_locked']) if (Object.hasOwn(body, key)) page[key] = clone(body[key]);
    } else if (method === 'POST' && endpoint.endsWith('/move')) page.parent = clone(body.parent);
    else throw Error('Unexpected fixture endpoint');
    page.last_edited_time = `2026-10-22T00:00:${String(++version).padStart(2, '0')}.000Z`;
    return clone(page);
  };
  const authorize = async (id, kind) => { authorizations.push({ id, kind }); if (!pages.has(id)) throw Error('Notion 页面不在授权范围。'); return id; };
  const mutate = async operation => {
    mutations.push(operation);
    const response = await request(operation.method, operation.endpoint, operation.body);
    return { ...await operation.verify(response), operation_id: 'synthetic-operation-' + mutations.length };
  };
  const session = createSession({ request, authorize, mutate, signal: new AbortController().signal });
  return { pages, contents, calls, mutations, authorizations, session };
}

test('create_page builds a real page request under the scoped parent and reads title, parent and Markdown back', async () => {
  const f = fixture();
  const result = await f.session.execute('create_page', { parent_page_id: PARENT, title: '词汇说明', content: '# 合成标题\n\n合成正文。' });
  assert.equal(result.verified, true); assert.equal(result.content_verified, true); assert.equal(result.page_id, CREATED);
  assert.equal(result.parent_page_id, PARENT);
  const write = f.calls.find(call => call.method === 'POST');
  assert.equal(write.endpoint, 'pages'); assert.deepEqual(write.body.parent, { type: 'page_id', page_id: PARENT });
  assert.equal(write.body.markdown, '# 合成标题\n\n合成正文。'); assert.equal(write.body.allow_async, false);
  assert.equal(f.calls.some(call => call.endpoint === `pages/${CREATED}/markdown` && call.method === 'GET'), true);
  assert.deepEqual(f.authorizations, [{ id: PARENT, kind: 'page' }]);
  assert.equal(f.mutations.length, 1);
});

test('metadata updates use the discovered title property, preserve unrelated fields and refresh the revision', async () => {
  const f = fixture(), before = await f.session.execute('read_page_info', { page_id: PAGE });
  const result = await f.session.execute('update_page_info', { page_id: PAGE, metadata_revision: before.metadata_revision, title: '新标题', icon_emoji: '📖', cover_url: 'https://example.com/cover.png', is_locked: true });
  assert.equal(result.verified, true); assert.equal(result.changed, true); assert.equal(result.title, '新标题'); assert.equal(result.is_locked, true);
  assert.notEqual(result.metadata_revision, before.metadata_revision);
  assert.equal(f.mutations[0].body.properties.Name.title[0].text.content, '新标题');
  assert.equal(Object.hasOwn(f.mutations[0].body, 'in_trash'), false);
  assert.equal(f.pages.get(PAGE).parent.page_id, PARENT);
  const cleared = await f.session.execute('update_page_info', { page_id: PAGE, metadata_revision: result.metadata_revision, icon_emoji: '', cover_url: '' });
  assert.equal(cleared.verified, true); assert.equal(cleared.icon, null); assert.equal(cleared.cover, null);
});

test('metadata writes require a current per-session read and reject concurrent edits before mutation', async () => {
  const f = fixture();
  await assert.rejects(f.session.execute('update_page_info', { page_id: PAGE, metadata_revision: 'a'.repeat(64), title: 'must not write' }), /先在本轮 read_page_info/);
  const before = await f.session.execute('read_page_info', { page_id: PAGE });
  f.pages.get(PAGE).properties.Name.title = [{ plain_text: '其他人改过的标题' }];
  await assert.rejects(f.session.execute('trash_page', { page_id: PAGE, metadata_revision: before.metadata_revision }), /读取后已变化/);
  assert.equal(f.mutations.length, 0);
});

test('move_page authorizes both page and destination, uses the official endpoint and verifies the new parent', async () => {
  const f = fixture(), before = await f.session.execute('read_page_info', { page_id: PAGE });
  const result = await f.session.execute('move_page', { page_id: PAGE, parent_page_id: DESTINATION, metadata_revision: before.metadata_revision });
  assert.equal(result.verified, true); assert.equal(result.parent.page_id, DESTINATION);
  assert.equal(f.mutations[0].endpoint, `pages/${PAGE}/move`); assert.equal(f.mutations[0].method, 'POST');
  assert.equal(f.authorizations.some(a => a.id === DESTINATION && a.kind === 'page'), true);
  await assert.rejects(f.session.execute('move_page', { page_id: PAGE, parent_page_id: PAGE, metadata_revision: result.metadata_revision }), /它自己/);
  assert.equal(f.mutations.length, 1);
});

test('trash and restore are explicit reversible operations, read back their outcomes and avoid no-op submissions', async () => {
  const f = fixture(), before = await f.session.execute('read_page_info', { page_id: PAGE });
  const trashed = await f.session.execute('trash_page', { page_id: PAGE, metadata_revision: before.metadata_revision });
  assert.equal(trashed.verified, true); assert.equal(trashed.in_trash, true);
  assert.deepEqual(f.mutations[0].body, { in_trash: true });
  const noOp = await f.session.execute('trash_page', { page_id: PAGE, metadata_revision: trashed.metadata_revision });
  assert.equal(noOp.changed, false); assert.equal(f.mutations.length, 1);
  const restored = await f.session.execute('restore_page', { page_id: PAGE, metadata_revision: noOp.metadata_revision });
  assert.equal(restored.verified, true); assert.equal(restored.in_trash, false);
  assert.equal(f.mutations.length, 2); assert.deepEqual(f.mutations[1].body, { in_trash: false });
});

test('malformed arguments, unscoped parents and unsafe cover URLs never submit a page write', async () => {
  const f = fixture(), before = await f.session.execute('read_page_info', { page_id: PAGE });
  await assert.rejects(f.session.execute('create_page', { parent_page_id: PARENT, title: '' }), /标题/);
  await assert.rejects(f.session.execute('create_page', { parent_page_id: CREATED, title: 'outside' }), /授权范围/);
  await assert.rejects(f.session.execute('create_page', { parent_page_id: PARENT, title: 'outside', erase_content: true }), /未知字段/);
  await assert.rejects(f.session.execute('update_page_info', { page_id: PAGE, metadata_revision: before.metadata_revision, cover_url: 'http://example.com/image' }), /HTTPS/);
  await assert.rejects(f.session.execute('update_page_info', { page_id: PAGE, metadata_revision: before.metadata_revision, is_locked: 'true' }), /布尔值/);
  assert.equal(f.mutations.length, 0);
});

test('creation readback detects missing content without replaying the successful creation request', async () => {
  const f = fixture({ request: ({ method, endpoint }) => method === 'GET' && endpoint.endsWith('/markdown') ? { markdown: 'different', truncated: false } : null });
  const result = await f.session.execute('create_page', { parent_page_id: PARENT, title: '验收页', content: 'expected content' });
  assert.equal(result.verified, false); assert.equal(result.content_verified, false); assert.equal(result.page_id, CREATED);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('page tool catalog exposes only explicit content operations and classifies every metadata mutation as a write', () => {
  assert.deepEqual(definitions.map(d => d.function.name), ['create_page', 'read_page_info', 'update_page_info', 'move_page', 'trash_page', 'restore_page']);
  assert.equal(writeTools.has('read_page_info'), false);
  assert.equal(writeTools.size, 5);
  assert.equal(definitions.every(d => d.function.parameters.additionalProperties === false), true);
});
