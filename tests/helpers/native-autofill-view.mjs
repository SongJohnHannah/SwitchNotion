import { autofillFixture, autofillId } from './native-autofill.mjs';
export function autofillViewFixture() {
  const f = autofillFixture(), viewId = autofillId(30), filter = { operator: 'and', filters: [
    { property: 'category', filter: { operator: 'enum_is', value: '研发' } }
  ] };
  f.get('block', f.ids.first).properties.title = [['所选 A']];
  f.get('block', f.ids.second).properties.title = [['所选 B']];
  f.get('block', f.ids.unselected).properties.category = [['市场']];
  f.records.set('block:' + f.ids.parent, { id: f.ids.parent, space_id: f.ids.space, alive: true, version: 1,
    type: 'collection_view_page', collection_id: f.ids.collection, view_ids: [viewId] });
  const view = { id: viewId, space_id: f.ids.space, parent_table: 'block', parent_id: f.ids.parent,
    type: 'table', version: 1, alive: true, query2: { filter: structuredClone(filter) }, format: { table_wrap: true } };
  f.records.set('collection_view:' + viewId, view);
  const snapshot = { request: { clientType: 'notion_app', source: { type: 'collection', id: f.ids.collection, spaceId: f.ids.space },
    collectionView: { id: viewId, spaceId: f.ids.space }, loader: { reducers: { table_group_results: { type: 'results', limit: 25, startCursor: { stack: ['old-page'] } } },
      filter: structuredClone(filter), sort: [{ property: 'title', direction: 'descending' }], searchQuery: '所选',
      archiveStatus: 'NON_ARCHIVED', userId: f.ids.user, userTimeZone: 'Asia/Shanghai' } },
    view: { id: viewId, type: view.type, version: view.version, query2: structuredClone(view.query2), format: structuredClone(view.format) } };
  const input = { ...f.input, type: 'viewFill', viewId, notionSwitchView: snapshot }; delete input.blockIds;
  const queries = [], originalApi = f.native.api; let override;
  f.native.api = async (endpoint, payload, options) => {
    if (endpoint !== 'queryCollection') return originalApi(endpoint, payload, options);
    queries.push(structuredClone(payload)); f.calls.push({ endpoint, payload: structuredClone(payload) });
    if (override) return override(payload, options);
    if (options.spaceId !== f.ids.space) throw Error('Wrong query workspace');
    const onlyEmpty = payload.loader.filter.filters.some(item => item.property === 'summary' && item.filter.operator === 'is_empty');
    const ids = [f.ids.first, f.ids.second, f.ids.unselected].filter(id => {
      const row = f.get('block', id), props = row.properties, text = props.title?.[0]?.[0] || '';
      return text.includes(payload.loader.searchQuery || '') && props.category?.[0]?.[0] === '研发' && (!onlyEmpty || !props.summary?.[0]?.[0]);
    }).sort((a, b) => f.get('block', b).properties.title[0][0].localeCompare(f.get('block', a).properties.title[0][0]));
    return { result: { reducerResults: { results: { type: 'results', blockIds: ids, hasMore: false } } } };
  };
  return { ...f, viewId, view, snapshot, input, queries, setQuery: fn => { override = fn; } };
}
