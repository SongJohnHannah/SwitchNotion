import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { definitions, writeTools, createSession } = createRequire(import.meta.url)('../src/notion-collaboration.cjs');
const P1 = '11111111-1111-4111-8111-111111111111', P2 = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333', DB = '44444444-4444-4444-8444-444444444444', DS = '55555555-5555-4555-8555-555555555555';
const C1 = '66666666-6666-4666-8666-666666666666', C2 = '77777777-7777-4777-8777-777777777777', THREAD = '88888888-8888-4888-8888-888888888888';
const V1 = '99999999-9999-4999-8999-999999999999', V2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const rich = text => [{ type: 'text', plain_text: text, text: { content: text } }];
const copy = value => structuredClone(value);
function fixture(extra = {}) {
  const comments = new Map([[C1, { object: 'comment', id: C1, parent: { type: 'page_id', page_id: P1 }, discussion_id: THREAD, rich_text: rich('Existing comment') }]]);
  const views = new Map([[V1, { object: 'view', id: V1, parent: { type: 'database_id', database_id: DB }, data_source_id: DS, name: 'Existing table', type: 'table', filter: null, sorts: null, configuration: null }]]);
  const calls = [], mutations = [], authorized = [];
  const request = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body: copy(body) });
    if (extra.request) { const response = await extra.request(method, endpoint, body); if (response !== undefined) return copy(response); }
    const parsed = new URL(endpoint, 'https://fixture.invalid/');
    if (endpoint === `blocks/${B}`) return { object: 'block', id: B, parent: { type: 'page_id', page_id: P1 } };
    if (parsed.pathname === '/comments' && method === 'GET') {
      const target = parsed.searchParams.get('block_id'), rows = [...comments.values()].filter(c => c.parent.page_id === target || c.parent.block_id === target);
      return { results: copy(rows), has_more: false, next_cursor: null };
    }
    if (endpoint === 'comments' && method === 'POST') {
      const parent = body.parent || { type: 'page_id', page_id: P1 };
      const result = { object: 'comment', id: C2, parent: { type: Object.keys(parent)[0], ...parent }, discussion_id: body.discussion_id || THREAD, rich_text: rich(body.markdown) };
      comments.set(C2, result); return copy(result);
    }
    if (endpoint.startsWith('comments/')) {
      const cid = endpoint.slice(9), record = comments.get(cid);
      if (!record) throw Error('Notion API 返回 HTTP 404。');
      if (method === 'PATCH') record.rich_text = rich(body.markdown);
      if (method === 'DELETE') comments.delete(cid);
      return copy(record);
    }
    if (parsed.pathname === '/views' && method === 'GET') return { results: [...views.values()].map(v => ({ object: 'view', id: v.id })), has_more: false, next_cursor: null };
    if (endpoint === 'views' && method === 'POST') {
      const result = { object: 'view', id: V2, parent: { type: 'database_id', database_id: body.database_id || DB }, ...copy(body), ...(body.view_id ? { dashboard_view_id: body.view_id } : {}), ...(body.type === 'dashboard' ? { data_source_id: null } : {}) };
      delete result.database_id; views.set(V2, result); return copy(result);
    }
    if (endpoint.startsWith('views/')) {
      const vid = endpoint.slice(6), record = views.get(vid);
      if (!record) throw Error('Notion API 返回 HTTP 404。');
      if (method === 'PATCH') Object.assign(record, copy(body));
      if (method === 'DELETE') { if (views.size === 1) throw Error('Notion API 返回 HTTP 400。'); views.delete(vid); }
      return copy(record);
    }
    throw Error('Unexpected synthetic endpoint: ' + endpoint);
  };
  const authorize = async (resource, kind) => {
    authorized.push({ resource, kind });
    if (![P1, P2, B, DB, DS].includes(resource)) throw Error('Notion 资源不在授权范围。');
    return resource;
  };
  const mutate = async spec => { mutations.push(spec); const response = await request(spec.method, spec.endpoint, spec.body); return { ...(await spec.verify(response)), operation_id: 'fixture-operation' }; };
  return { comments, views, calls, mutations, authorized, session: createSession({ request, authorize, mutate }) };
}

test('comments are scoped to the page and valid discussions before one verified submission', async () => {
  const f = fixture();
  const page = await f.session.execute('list_comments', { page_id: P1, page_size: 10 });
  assert.equal(page.complete, true); assert.equal(page.results[0].content, 'Existing comment');
  assert.equal(page.note.includes('未解决'), true);
  const created = await f.session.execute('create_comment', { page_id: P1, content: 'Synthetic reply', discussion_id: THREAD });
  assert.equal(created.verified, true); assert.equal(created.comment_id, C2);
  assert.deepEqual(f.mutations[0].body, { discussion_id: THREAD, markdown: 'Synthetic reply' });
  assert.equal(f.mutations.length, 1);
  await assert.rejects(f.session.execute('create_comment', { page_id: P2, content: 'Must not be sent', discussion_id: THREAD }), /未发送回复/);
  assert.equal(f.mutations.length, 1);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('comment replies find an existing discussion on later pages and preserve query encoding', async () => {
  const f = fixture({ request: (method, endpoint) => {
    if (method === 'GET' && endpoint.startsWith('comments?')) {
      const parsed = new URL(endpoint, 'https://fixture.invalid');
      if (!parsed.searchParams.has('start_cursor')) return { results: [], has_more: true, next_cursor: 'cursor&other=value' };
      assert.equal(parsed.searchParams.get('start_cursor'), 'cursor&other=value');
      assert.equal(parsed.searchParams.has('other'), false);
      return { results: [{ object: 'comment', id: C1, parent: { page_id: P1 }, discussion_id: THREAD, rich_text: rich('Later') }], has_more: false, next_cursor: null };
    }
  } });
  assert.equal((await f.session.execute('create_comment', { page_id: P1, content: 'Found later', discussion_id: THREAD })).verified, true);
  assert.equal(f.mutations.length, 1);
});

test('comment updates and deletion require a prior read, fresh revision and the correct parent', async () => {
  const f = fixture();
  await assert.rejects(f.session.execute('update_comment', { page_id: P1, comment_id: C1, revision: 'forged', content: 'No' }), /先在本轮读取/);
  await assert.rejects(f.session.execute('read_comment', { page_id: P2, comment_id: C1 }), /不属于/);
  const before = await f.session.execute('read_comment', { page_id: P1, comment_id: C1 });
  f.comments.get(C1).rich_text = rich('Concurrent edit');
  await assert.rejects(f.session.execute('update_comment', { page_id: P1, comment_id: C1, revision: before.revision, content: 'No' }), /已变化/);
  assert.equal(f.mutations.length, 0);
  const current = await f.session.execute('read_comment', { page_id: P1, comment_id: C1 });
  const changed = await f.session.execute('update_comment', { page_id: P1, comment_id: C1, revision: current.revision, content: 'Updated' });
  assert.equal(changed.verified, true); assert.equal(changed.content, 'Updated');
  const deleted = await f.session.execute('delete_comment', { page_id: P1, comment_id: C1, revision: changed.revision });
  assert.equal(deleted.verified, true); assert.equal(f.comments.has(C1), false);
  assert.equal(f.mutations.length, 2);
});

test('block comments require ancestry within the specified page and separate comment permissions surface accurately', async () => {
  const f = fixture();
  await assert.rejects(f.session.execute('create_comment', { page_id: P2, block_id: B, content: 'Wrong page' }), /不属于/);
  assert.equal(f.mutations.length, 0);
  const created = await f.session.execute('create_comment', { page_id: P1, block_id: B, content: 'Block comment' });
  assert.equal(created.verified, true);
  assert.deepEqual(f.mutations[0].body.parent, { block_id: B });
  const blocked = fixture({ request: (_method, endpoint) => { if (endpoint.startsWith('comments')) throw Error('Notion API 返回 HTTP 403，请检查评论权限。'); } });
  await assert.rejects(blocked.session.execute('list_comments', { page_id: P1 }), /HTTP 403/);
  assert.equal(blocked.mutations.length, 0);
});

test('database views are anchored to the chosen database and create/readback includes layout settings', async () => {
  const f = fixture();
  const list = await f.session.execute('list_database_views', { database_id: DB });
  assert.equal(list.results[0].view_id, V1); assert.equal(list.complete, true);
  const created = await f.session.execute('create_database_view', { database_id: DB, data_source_id: DS, name: 'Terms', type: 'table', filter: { property: 'Term', title: { is_not_empty: true } }, configuration: { type: 'table', wrap_cells: true } });
  assert.equal(created.verified, true); assert.equal(created.name, 'Terms');
  assert.equal(f.mutations[0].endpoint, 'views'); assert.equal(f.mutations[0].target, DB);
  assert.equal(f.authorized.some(a => a.resource === DS && a.kind === 'data_source'), true);
  f.views.get(V1).parent.database_id = P2;
  await assert.rejects(f.session.execute('read_database_view', { database_id: DB, view_id: V1 }), /不属于指定数据库/);
});

test('view updates preserve unrelated fields, reject stale reads and deletion never deletes a database', async () => {
  const f = fixture();
  const before = await f.session.execute('read_database_view', { database_id: DB, view_id: V1 });
  f.views.get(V1).name = 'Changed elsewhere';
  await assert.rejects(f.session.execute('update_database_view', { database_id: DB, view_id: V1, revision: before.revision, name: 'No' }), /已变化/);
  assert.equal(f.mutations.length, 0);
  const current = await f.session.execute('read_database_view', { database_id: DB, view_id: V1 });
  const updated = await f.session.execute('update_database_view', { database_id: DB, view_id: V1, revision: current.revision, name: 'Renamed', sorts: [{ property: 'Term', direction: 'ascending' }] });
  assert.equal(updated.verified, true); assert.equal(f.views.get(V1).type, 'table'); assert.equal(f.views.get(V1).filter, null);
  await assert.rejects(f.session.execute('delete_database_view', { database_id: DB, view_id: V1, revision: updated.revision }), /HTTP 400/);
  assert.equal(f.views.size, 1);
  const extra = await f.session.execute('create_database_view', { database_id: DB, data_source_id: DS, name: 'Second', type: 'list' });
  const deleted = await f.session.execute('delete_database_view', { database_id: DB, view_id: extra.view_id, revision: extra.revision });
  assert.equal(deleted.verified, true); assert.equal(f.views.size, 1);
  assert.equal(f.calls.some(c => c.method === 'DELETE' && c.endpoint.startsWith('databases')), false);
});

test('tool schemas and runtime reject unsupported payloads before mutation', async () => {
  const f = fixture();
  assert.equal(definitions.length, 10); assert.equal(writeTools.size, 6);
  assert.equal(definitions.every(d => d.function.parameters.additionalProperties === false), true);
  await assert.rejects(f.session.execute('create_comment', { page_id: P1, content: '', method: 'POST' }), /未知字段/);
  await assert.rejects(f.session.execute('create_database_view', { database_id: DB, data_source_id: DS, name: 'No', type: 'table', configuration: { type: 'board' } }), /必须与视图类型一致/);
  await assert.rejects(f.session.execute('list_comments', { page_id: P1, page_size: 101 }), /分页大小/);
  await assert.rejects(f.session.execute('create_database_view', { database_id: DB, data_source_id: DS, name: 'No', type: 'table', filter: JSON.parse('{"constructor":{"bad":true}}') }), /无效字段/);
  assert.equal(f.mutations.length, 0);
});

test('dashboards have no data source on readback and widget creation validates the dashboard parent', async () => {
  const f = fixture();
  const dashboard = await f.session.execute('create_database_view', { database_id: DB, data_source_id: DS, name: 'Overview', type: 'dashboard' });
  assert.equal(dashboard.verified, true); assert.equal(dashboard.data_source_id, null);
  f.views.set(V1, { ...copy(f.views.get(V2)), id: V1 });
  f.views.delete(V2);
  const widget = await f.session.execute('create_database_view', { database_id: DB, data_source_id: DS, name: 'Terms', type: 'table', dashboard_view_id: V1, placement: { type: 'existing_row', row_index: 0 } });
  assert.equal(widget.verified, true); assert.equal(widget.dashboard_view_id, V1);
  assert.equal(f.mutations.at(-1).body.database_id, undefined);
  assert.equal(f.mutations.at(-1).body.view_id, V1);
  await assert.rejects(f.session.execute('create_database_view', { database_id: DB, data_source_id: DS, name: 'No nested dashboard', type: 'dashboard', dashboard_view_id: V1 }), /不能嵌套/);
  const count = f.mutations.length;
  await assert.rejects(f.session.execute('create_database_view', { database_id: DB, data_source_id: DS, name: 'No wrong parent', type: 'table', dashboard_view_id: V2 }), /必须放入 dashboard/);
  assert.equal(f.mutations.length, count);
});
