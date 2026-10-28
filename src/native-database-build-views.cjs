const { randomUUID } = require('node:crypto');
const fail = message => { throw Error('Notion AI 建库视图' + message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const layouts = new Set(['table', 'board', 'calendar', 'list', 'gallery', 'timeline']);
const dates = new Set(['date', 'created_time', 'last_edited_time']);

function validateViews(views, columns) {
  if (views === undefined) return;
  if (!Array.isArray(views) || views.length < 1 || views.length > 8) fail('数量必须为 1 至 8 个。');
  const fields = new Map(columns.map(column => [column.name, column])), names = new Set();
  const field = name => { if (typeof name !== 'string' || !fields.has(name)) fail('引用了不存在的字段。'); return fields.get(name); };
  return views.map(view => {
    if (!keys(view, ['name', 'type', 'properties', 'groupBy', 'dateBy', 'endDateBy', 'sort']) || !layouts.has(view.type) ||
        typeof view.name !== 'string' || !view.name.trim() || view.name.length > 200 || view.name.includes('\0')) fail('布局类型、名称或配置无效。');
    const name = view.name.trim(), key = name.normalize('NFC'); if (names.has(key)) fail('名称重复。'); names.add(key);
    const value = { name, type: view.type };
    if (view.properties !== undefined) {
      if (!Array.isArray(view.properties) || view.properties.length > columns.length || new Set(view.properties).size !== view.properties.length) fail('显示字段重复或过多。');
      view.properties.forEach(field); value.properties = [...view.properties];
      if (view.type === 'table' && !value.properties.some(name => field(name).type === 'title')) fail('表格必须显示标题字段。');
    }
    if (view.type === 'board') {
      if (!['status', 'select'].includes(field(view.groupBy).type)) fail('看板须按状态或单选字段分组。'); value.groupBy = view.groupBy;
    } else if (view.groupBy !== undefined) fail('此布局不使用看板分组字段。');
    if (['calendar', 'timeline'].includes(view.type)) {
      if (!dates.has(field(view.dateBy).type)) fail('日历和时间轴须绑定日期字段。'); value.dateBy = view.dateBy;
    } else if (view.dateBy !== undefined) fail('此布局不使用日期字段。');
    if (view.endDateBy !== undefined) {
      if (view.type !== 'timeline' || !dates.has(field(view.endDateBy).type)) fail('结束日期只能绑定时间轴的日期字段。'); value.endDateBy = view.endDateBy;
    }
    if (view.sort !== undefined) {
      if (!keys(view.sort, ['property', 'direction']) || !['ascending', 'descending'].includes(view.sort.direction)) fail('排序配置无效。');
      field(view.sort.property); value.sort = { property: view.sort.property, direction: view.sort.direction };
    }
    return value;
  });
}

function createViews(views, schema, { common, source, databaseId }) {
  const byName = new Map(Object.entries(schema).map(([id, value]) => [value.name, id])), fields = Object.keys(schema);
  return (views || [{ name: 'Table', type: 'table' }]).map(view => {
    const selected = view.properties ? view.properties.map(name => byName.get(name)) : view.type === 'table' ? fields : fields.filter(id => id !== 'title');
    const format = { collection_pointer: source }, query2 = {};
    const visible = ids => ids.map(property => ({ property, visible: true }));
    if (view.type === 'table') Object.assign(format, { table_properties: visible(selected), table_wrap: true, table_frozen_column_index: -1 });
    if (view.type === 'list') format.list_properties = visible(selected);
    if (view.type === 'gallery') format.gallery_properties = visible(selected);
    if (view.type === 'board') {
      const id = byName.get(view.groupBy), field = schema[id];
      format.board_columns_by = { property: id, type: field.type, ...(field.type === 'status' ? { groupBy: 'option' } : {}),
        sort: { type: 'ascending' }, disableBoardColorColumns: false };
      format.board_columns = (field.options || []).map(option => ({ property: id,
        value: field.type === 'status' ? { type: 'status', value: { type: 'by_option', option: option.value } } : { type: 'select', value: option.value } }));
      format.board_properties = [{ property: id, visible: false }, ...visible(selected.filter(property => property !== id))];
    }
    if (view.type === 'calendar') { format.calendar_properties = visible(selected); query2.calendar_by = byName.get(view.dateBy); }
    if (view.type === 'timeline') {
      format.timeline_properties = visible(selected); query2.timeline_by = byName.get(view.dateBy);
      if (view.endDateBy) query2.timeline_by_end = byName.get(view.endDateBy);
    }
    if (view.sort) query2.sort = [{ property: byName.get(view.sort.property), direction: view.sort.direction }];
    return { ...common, id: randomUUID(), parent_table: 'block', parent_id: databaseId, type: view.type, name: view.name, format, query2 };
  });
}
// Query only a program-created, empty preview. This never reads source rows.
function emptyPreviewReducers(reducers, schema, locale) {
  if (!object(reducers) || !Object.keys(reducers).length || Object.keys(reducers).length > 32 || JSON.stringify(reducers).length > 100000) fail('预览查询缺失或过大。');
  const count = aggregation => {
    if (!object(aggregation) || aggregation.aggregator !== 'count' || Object.keys(aggregation).some(key => !['aggregator', 'property', 'enforceMaxAggregationLimit'].includes(key)) ||
        aggregation.property !== undefined && !Object.hasOwn(schema, aggregation.property)) fail('预览统计当前仅支持记录计数。');
    return { type: 'number', value: 0 };
  };
  const result = { type: 'results', blockIds: [], hasMore: false }, entries = [];
  const collator = new Intl.Collator(locale || undefined);
  const groupKey = value => value.value === undefined ? value.type + ':uncategorized' : value.type === 'status'
    ? 'status:' + value.value.type + '-' + (value.value.option ?? value.value.group) : value.type + ':' + value.value;
  for (const [key, reducer] of Object.entries(reducers)) {
    if (reducer?.type === 'results') { entries.push([key, { ...result }]); continue; }
    if (reducer?.type === 'aggregation') { entries.push([key, { type: 'aggregation', aggregationResult: count(reducer.aggregation) }]); continue; }
    if (reducer?.type !== 'groups' || reducer.subGroup || reducer.propertyAggregations || reducer.omitZeroAggregationGroups ||
        !Number.isSafeInteger(reducer.limit) || reducer.limit < 1 || reducer.limit > 1000 || !Array.isArray(reducer.groupSortPreference) || reducer.groupSortPreference.length > 101) fail('预览分组查询类型尚未支持或范围无效。');
    const group = reducer.groupBy, field = object(group) && schema[group.property];
    if (!field || !['select', 'status'].includes(field.type) || group.type !== field.type ||
        !['ascending', 'descending', 'manual'].includes(group.sort?.type) || field.type === 'status' && !['option', 'group'].includes(group.groupBy)) fail('预览分组字段或排序无效。');
    let values = field.type === 'select' ? [{ type: 'select' }, ...(field.options || []).map(option => ({ type: 'select', value: option.value }))]
      : group.groupBy === 'group' ? (field.groups || []).map(value => ({ type: 'status', value: { type: 'by_group', group: value.name } }))
        : (field.options || []).map(option => ({ type: 'status', value: { type: 'by_option', option: option.value } }));
    if (field.type === 'status' && !(field.options || []).some(option => option.value === field.defaultOption)) values.unshift({ type: 'status' });
    const known = new Map(values.map(value => [groupKey(value), value])), preferences = new Map();
    for (const preference of reducer.groupSortPreference) {
      if (!object(preference) || preference.property !== group.property || !object(preference.value) || !known.has(groupKey(preference.value)) ||
          preference.hidden !== undefined && typeof preference.hidden !== 'boolean' || preference.hiddenByDefault !== undefined && typeof preference.hiddenByDefault !== 'boolean' ||
          preference.pinned !== undefined && typeof preference.pinned !== 'boolean') fail('预览分组选项不匹配。');
      preferences.set(groupKey(preference.value), preference);
    }
    if (group.sort.type === 'manual') values = [...preferences.keys()].map(key => known.get(key)).concat(values.filter(value => !preferences.has(groupKey(value))));
    else if (field.type === 'select') values.sort((left, right) => left.value === undefined ? -1 : right.value === undefined ? 1 :
      collator.compare(left.value, right.value) * (group.sort.type === 'descending' ? -1 : 1));
    else if (group.sort.type === 'descending') values = values.filter(value => value.value === undefined).concat(values.filter(value => value.value !== undefined).reverse());
    const groups = values.map(value => { const preference = preferences.get(groupKey(value));
      return { value, visible: !(preference?.hidden ?? preference?.hiddenByDefault ?? !!group.hideEmptyGroups) }; });
    const ordered = groups.filter(value => value.visible).concat(reducer.returnHiddenGroups ? groups.filter(value => !value.visible) : []), selected = ordered.slice(0, reducer.limit);
    const grouped = { type: 'groups', version: 'v2', results: selected, hasMore: ordered.length > selected.length };
    if (reducer.aggregation) {
      if (reducer.aggregation.type !== 'independent' || reducer.aggregation.subGroupAggregation || reducer.aggregation.intersectionAggregation) fail('预览不支持嵌套统计。');
      const zero = count(reducer.aggregation.groupAggregation);
      grouped.aggregationResults = Object.fromEntries(selected.map(value => [groupKey(value.value), { aggregationResult: { ...zero } }]));
    }
    if (reducer.blockResults) {
      if (reducer.blockResults.type !== 'independent') fail('预览不支持交叉分组查询。');
      grouped.blockResults = Object.fromEntries(selected.map(value => [groupKey(value.value), { blockIds: [], hasMore: false }]));
    }
    if (reducer.returnPinnedGroups) {
      const pinned = [...preferences.entries()].filter(([, value]) => value.pinned).map(([key]) => groups.find(value => groupKey(value.value) === key)).slice(0, 20);
      grouped.pinnedResults = { groupResults: pinned, aggregationResults: Object.fromEntries(pinned.map(value => [groupKey(value.value), 0])) };
    }
    entries.push([key, grouped]);
  }
  return Object.fromEntries(entries);
}
module.exports = { validateViews, createViews, emptyPreviewReducers };
