const { uuid } = require('./native-context.cjs');
const fail = message => { throw Error('AI block 数据库' + message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const plain = value => Array.isArray(value) ? value.map(span => typeof span?.[0] === 'string' ? span[0] : '').join('') : '';
function entry(value) {
  for (let at = 0; at < 4 && object(value); at++, value = value.value)
    if (value.value?.id && typeof value.role === 'string') return value;
}
class AiBlockDatabaseReader {
  constructor({ store, remember }) {
    this.store = store; this.remember = remember; this.metadata = new Map(); this.queries = [];
  }
  async records(table, ids, signal) {
    if (!['collection', 'collection_view'].includes(table) || ids.some(id => !uuid(id)) || ids.length > 128 ||
        typeof this.store.api !== 'function' || !uuid(this.store.userId)) fail('原生读取会话尚未就绪。');
    const result = new Map();
    for (let at = 0; at < ids.length; at += 64) {
      signal?.throwIfAborted(); const batch = ids.slice(at, at + 64);
      const data = await this.store.api('getRecordValues', { requests: batch.map(id => ({ table, id, spaceId: this.store.spaceId })) },
        { signal, spaceId: this.store.spaceId });
      signal?.throwIfAborted();
      for (let i = 0; i < batch.length; i++) {
        const record = entry(data.results?.[i] || data.recordMap?.[table]?.[batch[i]]), value = record?.value;
        if (!value || uuid(value.id) !== batch[i] || uuid(value.space_id) !== this.store.spaceId || value.alive === false ||
            !['reader', 'commenter', 'editor', 'owner'].includes(record.role)) fail('来源无法读取或不属于当前工作区。');
        result.set(batch[i], structuredClone(value));
      }
    }
    return result;
  }
  keep(table, value) {
    const id = uuid(value.id), key = table + ':' + id;
    if (this.metadata.has(key) && JSON.stringify(this.metadata.get(key).value) !== JSON.stringify(value)) fail('来源在读取期间发生变化。');
    this.metadata.set(key, { table, id, value: structuredClone(value) }); this.remember(table, id, value);
  }
  async query(request, signal) {
    signal?.throwIfAborted();
    const data = await this.store.api('queryCollection', request, { signal, spaceId: this.store.spaceId });
    signal?.throwIfAborted();
    const result = data?.result?.reducerResults?.results;
    if (result?.type !== 'results' || result.hasMore !== false || !Array.isArray(result.blockIds) || result.blockIds.length > 200 ||
        result.blockIds.some(id => !uuid(id)) || new Set(result.blockIds.map(uuid)).size !== result.blockIds.length)
      fail('结果不完整、重复或超过 200 条；未使用部分记录生成。');
    return result.blockIds.map(uuid);
  }
  async load(source, signal) {
    const selected = (await this.store.records([source.pageId], signal)).get(source.pageId), block = selected?.value;
    if (!block || !['collection_view', 'collection_view_page'].includes(block.type) ||
        !['reader', 'commenter', 'editor', 'owner'].includes(selected.role)) fail('所选来源不是可读取的数据库块。');
    const pointers = [...(block.format?.collection_pointers || []), block.format?.collection_pointer,
      ...(block.collection_id ? [{ id: block.collection_id, spaceId: this.store.spaceId }] : [])].filter(Boolean);
    const matching = pointer => uuid(pointer.id) === source.collectionId && uuid(pointer.spaceId) === this.store.spaceId;
    if (!pointers.some(matching)) fail('标识与所选页面的来源不匹配。');
    this.remember('block', source.pageId, block);
    const collection = (await this.records('collection', [source.collectionId], signal)).get(source.collectionId);
    if (!object(collection.schema) || Object.keys(collection.schema).length > 1000) fail('字段结构缺失或范围过大。');
    this.keep('collection', collection);
    const ids = block.view_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 128 || ids.some(id => !uuid(id))) fail('缺少可核对的原生视图。');
    const views = await this.records('collection_view', [...new Set(ids.map(uuid))], signal);
    const distinct = new Set(pointers.map(pointer => uuid(pointer.spaceId) + ':' + uuid(pointer.id)));
    const view = [...views.values()].find(value => value.parent_table === 'block' && uuid(value.parent_id) === source.pageId &&
      (value.format?.collection_pointer ? matching(value.format.collection_pointer) : distinct.size === 1));
    if (!view) fail('视图归属与所选来源不匹配。');
    this.keep('collection_view', view);
    // The AI block context names a collection, not a view. The official
    // collection query helper likewise uses a native view pointer with an
    // explicit unfiltered loader; never borrow its saved or transient filters.
    const request = { clientType: 'notion_app', source: { type: 'collection', id: source.collectionId, spaceId: this.store.spaceId },
      collectionView: { id: uuid(view.id), spaceId: this.store.spaceId }, loader: {
        reducers: { results: { type: 'results', limit: 201, loadContentCover: false } },
        userId: this.store.userId, userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, archiveStatus: 'NON_ARCHIVED'
      } };
    const rowIds = await this.query(request, signal); this.queries.push({ request, rowIds });
    return { type: 'database', page_id: source.pageId, collection_id: source.collectionId, name: plain(collection.name),
      scope: { type: 'all_non_archived_records', complete: true, view_filter_applied: false, expand_child_pages: false,
        include_record_properties: true, include_record_body: true },
      fields: Object.entries(collection.schema).map(([id, field]) => {
        if (!object(field) || typeof field.name !== 'string' || typeof field.type !== 'string') fail('字段结构不完整。');
        return { id, name: field.name, type: field.type, ...(field.options ? { options: structuredClone(field.options) } : {}) };
      }), rowIds, rows: [] };
  }
  async verify(signal) {
    for (const table of ['collection', 'collection_view']) {
      const originals = [...this.metadata.values()].filter(value => value.table === table);
      if (!originals.length) continue;
      const fresh = await this.records(table, originals.map(value => value.id), signal);
      for (const record of originals) if (JSON.stringify(fresh.get(record.id)) !== JSON.stringify(record.value)) fail('字段或来源配置在生成期间发生变化，未返回过期结果。');
    }
    for (const { request, rowIds } of this.queries) {
      const fresh = await this.query(request, signal), expected = new Set(rowIds);
      if (fresh.length !== expected.size || fresh.some(id => !expected.has(id))) fail('记录范围在生成期间发生变化，未返回过期结果。');
    }
  }
}
module.exports = { AiBlockDatabaseReader };
