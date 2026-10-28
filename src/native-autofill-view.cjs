const { uuid } = require('./native-context.cjs');
const fail = message => { throw Error('Notion Autofill 视图' + message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));

function normalizeViewSnapshot(value, { spaceId, collectionId, viewId, userId } = {}) {
  if (!object(value) || JSON.stringify(value).length > 200000) fail('查询范围缺失或过大。');
  const { request, view } = value;
  if (!only(value, ['request', 'view']) || !only(request, ['clientType', 'source', 'collectionView', 'loader']) ||
      request.clientType !== 'notion_app' || !only(request.source, ['type', 'id', 'spaceId']) || request.source.type !== 'collection' ||
      uuid(request.source.id) !== collectionId || uuid(request.source.spaceId) !== spaceId ||
      !only(request.collectionView, ['id', 'spaceId']) || uuid(request.collectionView.id) !== viewId || uuid(request.collectionView.spaceId) !== spaceId ||
      !only(request.loader, ['reducers', 'filter', 'sort', 'searchQuery', 'archiveStatus', 'userId', 'userTimeZone',
        'upwardTraversalRelation', 'currentPageInRelatedCollection', 'propertyAggregations']) || !object(request.loader.reducers) ||
      !uuid(request.loader.userId) || userId && uuid(request.loader.userId) !== userId ||
      typeof request.loader.userTimeZone !== 'string' || request.loader.userTimeZone.length > 100 ||
      request.loader.searchQuery !== undefined && (typeof request.loader.searchQuery !== 'string' || request.loader.searchQuery.length > 10000) ||
      request.loader.sort !== undefined && !Array.isArray(request.loader.sort) ||
      !only(view, ['id', 'type', 'version', 'query2', 'format']) || uuid(view.id) !== viewId || typeof view.type !== 'string' ||
      !Number.isSafeInteger(view.version) || view.version < 0 || !object(view.query2) || !object(view.format)) fail('查询不属于当前数据库、账号或完整范围。');
  const snapshot = structuredClone(value);
  snapshot.request.loader.reducers = { results: { type: 'results', limit: 201, loadContentCover: false } };
  return snapshot;
}

async function resolveViewInfo(store, info, signal) {
  const snapshot = normalizeViewSnapshot(info.viewSnapshot, { ...info, userId: store.userId });
  const view = (await store.read('collection_view', [info.viewId], signal)).get(info.viewId);
  if (view.type !== snapshot.view.type || view.version !== snapshot.view.version || !equal(view.query2 || {}, snapshot.view.query2) ||
      !equal(view.format || {}, snapshot.view.format)) fail('设置在请求期间发生变化，请重新选择填充。');
  let source;
  if (view.parent_table === 'collection') source = { id: uuid(view.parent_id), spaceId: store.spaceId };
  else if (view.parent_table === 'block' && uuid(view.parent_id)) {
    const parent = (await store.read('block', [uuid(view.parent_id)], signal)).get(uuid(view.parent_id));
    if (!['collection_view', 'collection_view_page'].includes(parent.type) || !parent.view_ids?.includes(info.viewId)) fail('不属于所选数据库视图。');
    const pointers = [view.format?.collection_pointer, parent.format?.collection_pointer].filter(Boolean);
    if (parent.collection_id) pointers.push({ id: parent.collection_id, spaceId: store.spaceId });
    if (!pointers.length || pointers.some(pointer => uuid(pointer.id) !== info.collectionId || uuid(pointer.spaceId) !== info.spaceId)) fail('来源数据库范围不匹配。');
    source = pointers[0];
  }
  if (!source || uuid(source.id) !== info.collectionId || uuid(source.spaceId) !== info.spaceId) fail('来源数据库范围不匹配。');
  const request = structuredClone(snapshot.request);
  // Reducers may contain a cursor into the visible page. Replay the effective
  // scope from its beginning and require a complete, bounded server result.
  request.loader.reducers = { results: { type: 'results', limit: 201, loadContentCover: false } };
  const response = await store.native.api('queryCollection', request, { signal, spaceId: info.spaceId });
  signal?.throwIfAborted();
  const result = response?.result?.reducerResults?.results;
  if (result?.type !== 'results' || result.hasMore !== false || !Array.isArray(result.blockIds) || result.blockIds.length > 200 ||
      result.blockIds.some(id => !uuid(id)) || new Set(result.blockIds.map(uuid)).size !== result.blockIds.length) fail('结果不完整、重复或超过 200 条，未执行部分填充。');
  const matching = result.blockIds.map(uuid);
  if (info.rowIds !== undefined && (!Array.isArray(info.rowIds) || info.rowIds.length > 200 ||
      info.rowIds.some(id => !uuid(id) || !matching.includes(id)) || new Set(info.rowIds).size !== info.rowIds.length)) fail('待填记录在生成期间离开原范围，未写入旧结果。');
  return { ...info, viewSnapshot: snapshot, rowIds: info.rowIds === undefined ? matching : [...info.rowIds] };
}
module.exports = { normalizeViewSnapshot, resolveViewInfo };
