import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createSession, definitions, writeTools } = createRequire(import.meta.url)('../src/notion-databases.cjs');
const PARENT = '11111111-1111-4111-8111-111111111111', DB = '22222222-2222-4222-8222-222222222222', SOURCE = '33333333-3333-4333-8333-333333333333', ENTRY = '44444444-4444-4444-8444-444444444444', OTHER = '55555555-5555-4555-8555-555555555555';
const clone = value => structuredClone(value);
const spans = content => [{ type: 'text', plain_text: content, text: { content } }];
function fixture() {
  const sources = new Map(), databases = new Map(), pages = new Map(), propertyResponses = new Map(), calls = [], mutations = [], authorized = [], denied = new Set();
  const normalizeProperties = properties => Object.fromEntries(Object.entries(properties).map(([name, field], index) => { const type = field.type || Object.keys(field)[0]; return [name, { id: type === 'title' ? 'title' : 'field-' + index, name, type, [type]: clone(field[type]) }]; }));
  const source = { object: 'data_source', id: SOURCE, title: spans('词汇解释'), parent: { type: 'database_id', database_id: DB }, properties: normalizeProperties({ '词汇': { title: {} }, '解释': { rich_text: {} }, '标签': { multi_select: { options: [{ name: '教育' }] } }, '已掌握': { checkbox: {} }, '无用字段': { number: {} } }) };
  sources.set(SOURCE, source);
  databases.set(DB, { object: 'database', id: DB, title: spans('词汇解释'), description: [], parent: { type: 'page_id', page_id: PARENT }, is_inline: true, data_sources: [{ id: SOURCE, name: '词汇解释' }] });
  const request = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body: clone(body) });
    if (endpoint === 'search') return { results: [clone(source)], has_more: !!body.query, next_cursor: body.query ? 'fixture-cursor' : null };
    if (endpoint === 'databases' && method === 'POST') {
      const database = { object: 'database', id: DB, title: clone(body.title), description: [], parent: clone(body.parent), is_inline: body.is_inline, data_sources: [{ id: SOURCE, name: body.title[0].text.content }] };
      databases.set(DB, database);
      source.properties = normalizeProperties(body.initial_data_source.properties); source.title = clone(body.title);
      return clone(database);
    }
    const dbId = endpoint.match(/^databases\/([^/]+)$/)?.[1];
    if (dbId) { const data = databases.get(dbId); if (!data) throw Error('Notion API 返回 HTTP 404。'); if (method === 'PATCH') Object.assign(data, clone(body)); return clone(data); }
    const sourceId = endpoint.match(/^data_sources\/([^/]+)$/)?.[1];
    if (sourceId) {
      const data = sources.get(sourceId); if (!data) throw Error('Notion API 返回 HTTP 404。');
      if (method === 'PATCH') for (const [name, value] of Object.entries(body.properties)) {
        if (value === null) delete data.properties[name];
        else if (value.name) { data.properties[value.name] = { ...data.properties[name], name: value.name }; delete data.properties[name]; }
        else data.properties[name] = normalizeProperties({ [name]: value })[name];
      }
      return clone(data);
    }
    if (endpoint === `data_sources/${SOURCE}/query`) return { results: [...pages.values()].map(clone), has_more: false, next_cursor: null };
    if (endpoint === 'pages' && method === 'POST') {
      const properties = Object.fromEntries(Object.entries(body.properties).map(([name, value]) => [name, { ...clone(value), type: Object.keys(value)[0], id: source.properties[name].id }]));
      const page = { object: 'page', id: ENTRY, url: 'https://www.notion.so/' + ENTRY.replaceAll('-', ''), parent: clone(body.parent), properties, markdown: body.markdown || '' };
      pages.set(ENTRY, page); return clone(page);
    }
    const propertyMatch = endpoint.match(/^pages\/([^/]+)\/properties\/([^?]+)(\?.*)?$/);
    if (propertyMatch) {
      const cursor = new URLSearchParams(propertyMatch[3]?.slice(1)).get('start_cursor') || '';
      const item = propertyResponses.get(propertyMatch[2] + ':' + cursor);
      if (item) return clone(item);
      throw Error('Notion API 返回 HTTP 404。');
    }
    const pageId = endpoint.match(/^pages\/([^/]+)(\/markdown)?$/)?.[1];
    if (pageId) {
      const page = pages.get(pageId); if (!page) throw Error('Notion API 返回 HTTP 404。');
      if (endpoint.endsWith('/markdown')) return { markdown: page.markdown, truncated: false, unknown_block_ids: [] };
      if (method === 'PATCH') for (const [name, value] of Object.entries(body.properties)) page.properties[name] = { ...clone(value), type: Object.keys(value)[0], id: source.properties[name].id };
      return clone(page);
    }
    throw Error('Unexpected synthetic endpoint: ' + endpoint);
  };
  const authorize = async (id, kind) => { if (denied.has(id) || !/^[a-f\d-]{36}$/i.test(id)) throw Error('Notion 资源不在授权范围。'); authorized.push({ id, kind }); return id; };
  const mutate = async operation => { mutations.push(operation); const response = await request(operation.method, operation.endpoint, operation.body); return { ...await operation.verify(response), operation_id: 'fixture-operation-' + mutations.length }; };
  const session = () => createSession({ request, authorize, mutate, signal: new AbortController().signal });
  return { sources, source, databases, pages, propertyResponses, calls, mutations, authorized, denied, session };
}

test('vocabulary database, schema, row creation, query and property update complete with independent readback', async () => {
  const f = fixture(), session = f.session();
  const created = await session.execute('create_database', { parent_page_id: PARENT, title: '词汇解释', columns: [{ name: '词汇', type: 'title' }, { name: '解释', type: 'rich_text' }, { name: '标签', type: 'multi_select', options: ['教育', '方法'] }, { name: '已掌握', type: 'checkbox' }] });
  assert.equal(created.verified, true); assert.equal(created.database_id, DB); assert.equal(created.data_source_id, SOURCE);
  assert.equal(f.mutations[0].endpoint, 'databases');
  assert.equal(f.mutations[0].body.initial_data_source.properties['词汇'].title !== undefined, true);
  const row = await session.execute('create_database_entry', { data_source_id: SOURCE, properties: { '词汇': '协同', '解释': '不同主体共同完成目标', '标签': ['教育'], '已掌握': false }, content: '合成正文，用于验证。' });
  assert.equal(row.verified, true); assert.equal(row.properties['解释'], '不同主体共同完成目标');
  const queried = await session.execute('query_database', { data_source_id: SOURCE, filter: { property: '词汇', title: { equals: '协同' } }, sorts: [{ property: '词汇', direction: 'ascending' }], page_size: 5 });
  assert.equal(queried.results[0].page_id, ENTRY); assert.equal(queried.complete, true);
  const update = await session.execute('update_database_entry', { page_id: ENTRY, property_revision: queried.results[0].property_revision, properties: { '解释': '围绕共同目标协调行动', '已掌握': true } });
  assert.equal(update.verified, true); assert.equal(update.properties['词汇'], '协同'); assert.equal(update.properties['解释'], '围绕共同目标协调行动'); assert.equal(update.properties['已掌握'], true);
  assert.equal(f.mutations.length, 3);
  assert.equal(f.calls.filter(call => call.endpoint === 'pages/' + ENTRY && call.method === 'GET').length >= 3, true);
});

test('schema edits and database rename require this-session revisions and preserve unmodified properties', async () => {
  const f = fixture(), session = f.session();
  const database = await session.execute('read_database', { database_id: DB }), schema = database.data_sources[0];
  const renamed = await session.execute('update_database', { database_id: DB, database_revision: database.database_revision, title: '学习词汇', description: '合成词汇数据' });
  assert.equal(renamed.verified, true);
  const updated = await session.execute('update_database_schema', { data_source_id: SOURCE, schema_revision: schema.schema_revision, add_columns: [{ name: '例句', type: 'rich_text' }], rename_columns: [{ from: '解释', to: '释义' }], remove_columns: ['无用字段'] });
  assert.equal(updated.verified, true); assert.equal(updated.properties['词汇'].type, 'title'); assert.equal(updated.properties['释义'].type, 'rich_text'); assert.equal(updated.properties['解释'], undefined); assert.equal(updated.properties['无用字段'], undefined);
  await assert.rejects(session.execute('update_database_schema', { data_source_id: SOURCE, schema_revision: updated.schema_revision, remove_columns: ['词汇'] }), /不能删除 title/);
  const fresh = f.session();
  await assert.rejects(fresh.execute('update_database', { database_id: DB, database_revision: renamed.database_revision, title: 'must not write' }), /先在本轮/);
  assert.equal(f.mutations.length, 2);
});

test('stale row or schema revisions and unknown field types are rejected before mutation', async () => {
  const f = fixture(), session = f.session();
  const row = await session.execute('create_database_entry', { data_source_id: SOURCE, properties: { '词汇': '合成词', '解释': '初始解释' } });
  f.pages.get(ENTRY).properties['解释'].rich_text = spans('由另一编辑者更改');
  await assert.rejects(session.execute('update_database_entry', { page_id: ENTRY, property_revision: row.property_revision, properties: { '解释': 'would overwrite' } }), /读取后已变化/);
  const schema = await session.execute('read_database', { data_source_id: SOURCE });
  f.source.properties['外部新增'] = { id: 'external', name: '外部新增', type: 'rich_text', rich_text: {} };
  await assert.rejects(session.execute('update_database_schema', { data_source_id: SOURCE, schema_revision: schema.schema_revision, add_columns: [{ name: '新字段', type: 'number' }] }), /读取后已变化/);
  await assert.rejects(session.execute('create_database_entry', { data_source_id: SOURCE, properties: { '词汇': 'bad', '不存在': 'x' } }), /没有字段/);
  await assert.rejects(session.execute('create_database_entry', { data_source_id: SOURCE, properties: { '词汇': 'bad', '已掌握': 'yes' } }), /类型错误/);
  assert.equal(f.mutations.length, 1);
});

test('database search returns router-compatible pagination and excludes locally denied data sources', async () => {
  const f = fixture(), session = f.session();
  const first = await session.execute('search_databases', { query: '词汇' });
  assert.equal(first.results[0].database_id, DB); assert.equal(first.results[0].data_source_id, SOURCE); assert.equal(first.has_more, true); assert.equal(first.complete, false); assert.equal(first.next_cursor, 'fixture-cursor');
  await session.execute('search_databases', { query: '词汇', start_cursor: first.next_cursor });
  assert.equal(f.calls.at(-1).body.filter.value, 'data_source'); assert.equal(f.calls.at(-1).body.start_cursor, 'fixture-cursor');
  f.denied.add(SOURCE);
  const denied = await session.execute('search_databases', { query: '' });
  assert.equal(denied.results.length, 0); assert.equal(denied.skipped.length, 1); assert.equal(denied.complete, false); assert.equal(f.mutations.length, 0);
});

test('invalid create arguments, duplicate title columns and unauthorized parents never submit writes', async () => {
  const f = fixture(), session = f.session();
  await assert.rejects(session.execute('create_database', { parent_page_id: PARENT, title: 'x', columns: [{ name: 'x', type: 'title' }, { name: 'y', type: 'title' }] }), /一个 title/);
  await assert.rejects(session.execute('create_database', { parent_page_id: PARENT, title: 'x', columns: [{ name: 'x', type: 'title', unrelated: true }] }), /配置无效/);
  await assert.rejects(session.execute('create_database', { parent_page_id: PARENT, title: 'x', columns: [{ name: 'x', type: 'select', options: ['same', 'same'] }] }), /选项名称无效/);
  f.denied.add(PARENT);
  await assert.rejects(session.execute('create_database', { parent_page_id: PARENT, title: 'x' }), /授权范围/);
  await assert.rejects(session.execute('read_database', { database_id: DB, data_source_id: SOURCE }), /二选一/);
  await assert.rejects(session.execute('query_database', { data_source_id: SOURCE, page_size: 1000 }), /分页大小无效/);
  assert.equal(f.mutations.length, 0);
  assert.equal(definitions.length, 12); assert.equal(writeTools.has('query_database'), false); assert.equal(writeTools.has('create_database_entry'), true);
});

test('database trash and restore use fresh state revisions and retain title and parent', async () => {
  const f = fixture(), session = f.session();
  const database = await session.execute('read_database', { database_id: DB });
  const trashed = await session.execute('trash_database', { database_id: DB, database_revision: database.database_revision });
  assert.equal(trashed.verified, true); assert.equal(trashed.in_trash, true); assert.notEqual(trashed.database_revision, database.database_revision);
  assert.deepEqual(f.mutations[0].body, { in_trash: true });
  f.denied.add(SOURCE);
  const callsBefore = f.calls.length;
  const trashMetadata = await session.execute('read_database', { database_id: DB });
  assert.equal(trashMetadata.in_trash, true); assert.equal(trashMetadata.data_sources.length, 0); assert.deepEqual(trashMetadata.data_source_ids, [SOURCE]);
  assert.equal(f.calls.slice(callsBefore).some(call => call.endpoint.startsWith('data_sources/')), false);
  const restored = await session.execute('restore_database', { database_id: DB, database_revision: trashMetadata.database_revision });
  assert.equal(restored.verified, true); assert.equal(restored.in_trash, false); assert.equal(restored.title, '词汇解释');
  assert.deepEqual(f.mutations[1].body, { in_trash: false }); assert.deepEqual(f.databases.get(DB).parent, { type: 'page_id', page_id: PARENT });
  assert.equal(writeTools.has('trash_database'), true); assert.equal(writeTools.has('restore_database'), true);
  const fresh = f.session();
  await assert.rejects(fresh.execute('trash_database', { database_id: DB, database_revision: restored.database_revision }), /先在本轮/);
  f.databases.get(DB).in_trash = true;
  await assert.rejects(session.execute('trash_database', { database_id: DB, database_revision: restored.database_revision }), /读取后已变化/);
  assert.equal(f.mutations.length, 2);
});

test('property pagination preserves encoded IDs, encodes cursors, and reports partial values honestly', async () => {
  const f = fixture(), session = f.session(), field = 'f%5C%3Ap', cursor = 'fixture ? & cursor';
  await session.execute('create_database_entry', { data_source_id: SOURCE, properties: { '词汇': '合成词', '解释': '合成解释' } });
  f.pages.get(ENTRY).properties['解释'].id = field;
  f.pages.get(ENTRY).properties['解释'].has_more = true;
  const row = await session.execute('read_database_entry', { page_id: ENTRY });
  assert.equal(row.property_ids['解释'], field); assert.equal(row.incomplete_properties.includes('解释'), true);
  f.propertyResponses.set(field + ':', { object: 'list', property_item: { id: field, type: 'rich_text', rich_text: {}, next_url: 'https://untrusted.invalid/do-not-follow' }, results: [{ object: 'property_item', id: field, type: 'rich_text', rich_text: spans('第一批')[0] }], has_more: true, next_cursor: cursor });
  f.propertyResponses.set(field + ':' + cursor, { object: 'list', property_item: { id: field, type: 'rich_text', rich_text: {}, next_url: null }, results: [{ object: 'property_item', id: field, type: 'rich_text', rich_text: spans('第二批')[0] }], has_more: false, next_cursor: null });
  const first = await session.execute('read_database_entry_property', { page_id: ENTRY, property_id: field, page_size: 25 });
  assert.equal(first.value, '第一批'); assert.equal(first.complete, false); assert.equal(first.has_more, true); assert.equal(first.next_cursor, cursor);
  const second = await session.execute('read_database_entry_property', { page_id: ENTRY, property_id: field, start_cursor: first.next_cursor, page_size: 25 });
  assert.equal(second.value, '第二批'); assert.equal(second.complete, true); assert.equal(second.next_cursor, null);
  assert.equal(f.calls.at(-1).endpoint.startsWith('pages/' + ENTRY + '/properties/' + field + '?'), true);
  assert.equal(new URLSearchParams(f.calls.at(-1).endpoint.split('?')[1]).get('start_cursor'), cursor);
  assert.equal(f.calls.some(call => call.endpoint.includes('untrusted.invalid')), false);
  f.propertyResponses.set('score:', { object: 'property_item', id: 'score', type: 'number', number: 123 });
  const scalar = await session.execute('read_database_entry_property', { page_id: ENTRY, property_id: 'score' });
  assert.equal(scalar.value, 123); assert.equal(scalar.complete, true);
  await assert.rejects(session.execute('read_database_entry_property', { page_id: ENTRY, property_id: '..' }), /字段 ID 无效/);
  await assert.rejects(session.execute('read_database_entry_property', { page_id: ENTRY, property_id: field, page_size: 0 }), /分页大小无效/);
  assert.equal(f.mutations.length, 1);
});
