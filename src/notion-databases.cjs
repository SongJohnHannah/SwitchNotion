const { createHash } = require('node:crypto');

// Official Notion API 2026-03-11: databases contain data sources; rows are pages.
const fieldTypes = ['title', 'rich_text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url', 'email', 'phone_number', 'people', 'relation', 'formula', 'created_time', 'last_edited_time', 'created_by', 'last_edited_by'];
const writeTools = new Set(['create_database', 'update_database', 'trash_database', 'restore_database', 'update_database_schema', 'create_database_entry', 'update_database_entry']);
const str = description => ({ type: 'string', description });
const array = items => ({ type: 'array', maxItems: 100, items });
const column = { type: 'object', properties: { name: str('字段名称'), type: { type: 'string', enum: fieldTypes }, options: array(str('选项名称；仅 select/multi_select')), number_format: str('数字显示格式，如 number/percent/dollar'), expression: str('formula 表达式'), related_data_source_id: str('relation 目标数据源 UUID，仅单向关联') }, required: ['name', 'type'], additionalProperties: false };
const values = { type: 'object', description: '字段名到普通值的映射，如 {"词汇":"协同","解释":"共同完成目标","标签":["教育"]}。类型从已读取的数据源识别；日期用 {start,end?}，关联和人员用 UUID 数组。', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }, array({ type: 'string' }), { type: 'object', properties: { start: { type: 'string' }, end: { type: ['string', 'null'] }, time_zone: { type: ['string', 'null'] } }, required: ['start'], additionalProperties: false }] } };
const tool = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const definitions = [
  tool('search_databases', '搜索当前连接已授权的数据库/数据源标题，返回 database_id 和 data_source_id；按 next_cursor 继续。不会扫描数据库行。', { query: str('标题关键词，空字符串列出'), start_cursor: str('上一批的 next_cursor') }, ['query']),
  tool('read_database', '读取数据库及各数据源字段定义；已有 data_source_id 也可直接读取。返回 schema_revision 和 database_revision，更新前必须使用本轮读取结果。', { database_id: str('数据库 UUID；与 data_source_id 二选一'), data_source_id: str('数据源 UUID；与 database_id 二选一') }, []),
  tool('query_database', '分页读取数据库行，支持 Notion 官方 filter、sorts；结果含每行普通字段值和 property_revision。数据源 ID 来自 read_database/search_databases。', { data_source_id: str('数据源 UUID'), filter: { type: 'object', description: 'Notion 数据源筛选条件，可用 and/or 和字段类型条件' }, sorts: array({ type: 'object', properties: { property: str('字段名'), timestamp: { type: 'string', enum: ['created_time', 'last_edited_time'] }, direction: { type: 'string', enum: ['ascending', 'descending'] } }, required: ['direction'], additionalProperties: false }), start_cursor: str('上一批 next_cursor'), page_size: { type: 'integer', minimum: 1, maximum: 100 } }, ['data_source_id']),
  tool('create_database', '用户明确要求时，在已授权父页面下面新建真正的 Notion 数据库及表格视图。columns 指定字段；必须恰有一个 title，未提供时自动添加“名称”。不会在工作区顶层创建。', { parent_page_id: str('父页面 UUID；current 指原生当前页'), title: str('数据库名称'), columns: array(column), is_inline: { type: 'boolean', description: '是否在父页内嵌显示，默认 true' } }, ['parent_page_id', 'title']),
  tool('update_database', '修改数据库名称或说明；必须先本轮 read_database 并提供 database_revision。不删除数据库。', { database_id: str('数据库 UUID'), database_revision: str('本轮 read_database 返回的 database_revision'), title: str('新名称'), description: str('新说明，可空字符串清除') }, ['database_id', 'database_revision']),
  tool('trash_database', '仅在用户明确要求删除整个数据库时，将数据库及其记录移至垃圾箱，不永久删除。必须先本轮 read_database 并提供 database_revision；不会自动重试。', { database_id: str('数据库 UUID'), database_revision: str('本轮 read_database 返回的 database_revision') }, ['database_id', 'database_revision']),
  tool('restore_database', '按用户明确要求将数据库从垃圾箱恢复。先 read_database 读取垃圾箱状态和 database_revision，恢复后独立核验。', { database_id: str('数据库 UUID'), database_revision: str('本轮 read_database 返回的 database_revision') }, ['database_id', 'database_revision']),
  tool('update_database_schema', '按用户要求添加、重命名或移除数据源字段。先本轮 read_database 获取 schema_revision；删除字段会影响该列数据，仅在用户明确要求时使用，不能删除 title。', { data_source_id: str('数据源 UUID'), schema_revision: str('本轮读取返回的 schema_revision'), add_columns: array(column), rename_columns: array({ type: 'object', properties: { from: str('原字段名'), to: str('新字段名') }, required: ['from', 'to'], additionalProperties: false }), remove_columns: array(str('要删除的字段名')) }, ['data_source_id', 'schema_revision']),
  tool('create_database_entry', '在现有数据库中新建一条记录。先读取数据源字段；properties 使用普通值，不是 Notion 内部 rich_text JSON。可附带 Markdown 正文；创建后独立读回核验。', { data_source_id: str('数据源 UUID'), properties: values, content: str('记录正文 Markdown，可省略') }, ['data_source_id', 'properties']),
  tool('read_database_entry', '读取一条数据库记录的字段值、property_ids 及 property_revision。记录正文另外用 read_page；incomplete_properties 中的字段要用 read_database_entry_property 分页读取，不能把截断字段当全文。', { page_id: str('数据库记录的页面 UUID') }, ['page_id']),
  tool('read_database_entry_property', '读取一个记录字段的完整值或单批分页值。property_id 使用读取记录返回的 property_ids；保留已编码 ID。has_more=true 时继续 next_cursor，直到 complete=true；不能只凭第一批声明完整。', { page_id: str('记录页面 UUID'), property_id: str('字段 ID（优先）或字段名称；编码 ID 按返回值传入'), start_cursor: str('上一批 next_cursor'), page_size: { type: 'integer', minimum: 1, maximum: 100 } }, ['page_id', 'property_id']),
  tool('update_database_entry', '只修改指定数据库字段，保留未指定字段。必须先在本轮 read_database_entry/query_database，使用 property_revision。properties 接受普通类型值。', { page_id: str('记录的页面 UUID'), property_revision: str('本轮读取返回的 property_revision'), properties: values }, ['page_id', 'property_revision'])
];

const plain = spans => (spans || []).map(span => span.plain_text ?? span.text?.content ?? '').join('');
const stable = value => JSON.stringify(canonical(value));
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
const revision = value => createHash('sha256').update(stable(value)).digest('hex');
const urlFor = id => `https://www.notion.so/${id.replaceAll('-', '')}`;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, label, max = 20000, allowEmpty = false) { if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw Error(`Notion ${label} 必须是${allowEmpty ? '' : '非空'}文字（最多 ${max} 字符）。`); return value; }
function nameOf(value) { text(value, '字段名称', 200); if (['__proto__', 'constructor', 'prototype'].includes(value)) throw Error('Notion 字段名称无效。'); return value; }
function uuid(value) { if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) throw Error('Notion 返回了无效资源 ID。'); return value.toLowerCase(); }
function richText(value) { const result = []; for (let offset = 0; offset < value.length; offset += 2000) result.push({ type: 'text', text: { content: value.slice(offset, offset + 2000) } }); return result; }
function typeOf(property) { return property?.type || fieldTypes.find(type => Object.hasOwn(property || {}, type)); }
function simpleValue(property) {
  const type = typeOf(property), value = property?.[type];
  if (type === 'title' || type === 'rich_text') return plain(value);
  if (type === 'select' || type === 'status') return value?.name ?? null;
  if (type === 'multi_select') return (value || []).map(option => option.name).sort();
  if (type === 'relation' || type === 'people') return (value || []).map(item => item.id).sort();
  if (type === 'date') return value ? { start: value.start, end: value.end || null, time_zone: value.time_zone || null } : null;
  return value ?? null;
}
function entryResult(page) {
  if (!object(page.properties)) throw Error('Notion 数据库记录字段格式异常。');
  const fields = Object.fromEntries(Object.entries(page.properties).map(([name, property]) => [name, simpleValue(property)]));
  const incomplete = Object.entries(page.properties).filter(([, property]) => property.has_more).map(([name]) => name);
  return { page_id: uuid(page.id), url: page.url || urlFor(page.id), in_trash: page.in_trash === true, archived: page.archived === true, properties: fields, property_ids: Object.fromEntries(Object.entries(page.properties).map(([name, property]) => [name, property.id])), property_types: Object.fromEntries(Object.entries(page.properties).map(([name, property]) => [name, typeOf(property)])), property_revision: revision(page.properties), incomplete_properties: incomplete, parent: page.parent };
}
const databaseRevision = database => revision({ title: database.title, description: database.description, parent: database.parent, is_inline: database.is_inline, in_trash: database.in_trash === true, archived: database.archived === true, data_sources: database.data_sources });
const schemaResult = source => ({ data_source_id: uuid(source.id), title: plain(source.title), url: source.url || urlFor(source.parent?.database_id || source.id), properties: source.properties, schema_revision: revision(source.properties), parent: source.parent });
const columnsMatch = (actual, expected) => Object.entries(expected).every(([key, field]) => {
  const type = typeOf(field), actualField = actual?.[key], settings = field[type], saved = actualField?.[type];
  if (!actualField || typeOf(actualField) !== type) return false;
  if (settings.options && stable((saved?.options || []).map(option => option.name).sort()) !== stable(settings.options.map(option => option.name).sort())) return false;
  if (settings.format && saved?.format !== settings.format) return false;
  if (settings.expression && saved?.expression !== settings.expression) return false;
  if (settings.data_source_id && saved?.data_source_id !== settings.data_source_id) return false;
  return true;
});
function validateArgs(name, args) {
  const definition = definitions.find(item => item.function.name === name);
  if (!definition || !object(args) || Object.keys(args).some(key => !Object.hasOwn(definition.function.parameters.properties, key)) || definition.function.parameters.required.some(key => !Object.hasOwn(args, key))) throw Error('Notion 数据库工具参数不完整或包含未知字段。');
}

function createSession({ request, authorize, mutate, signal }) {
  const seenEntries = new Map(), seenSchemas = new Map(), seenDatabases = new Map();
  const sourceById = async value => {
    const id = await authorize(value, 'data_source');
    const source = await request('GET', `data_sources/${id}`, null);
    if (!object(source.properties)) throw Error('Notion 数据源未返回有效字段定义。');
    seenSchemas.set(id, revision(source.properties));
    return source;
  };
  const rememberEntry = page => { const result = entryResult(page); seenEntries.set(result.page_id, result.property_revision); return result; };
  const buildColumns = async (columns, creating = false) => {
    if (columns === undefined) columns = [];
    if (!Array.isArray(columns) || columns.length > 100) throw Error('Notion 数据库字段列表无效。');
    const result = Object.create(null);
    for (const field of columns) {
      if (!object(field) || Object.keys(field).some(key => !Object.hasOwn(column.properties, key)) || !fieldTypes.includes(field.type)) throw Error('Notion 字段类型或配置无效。');
      const name = nameOf(field.name);
      if (Object.hasOwn(result, name)) throw Error('Notion 字段名称不能重复。');
      let settings = {};
      if (field.type === 'select' || field.type === 'multi_select') {
        if (field.options !== undefined && (!Array.isArray(field.options) || field.options.length > 100 || field.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 100) || new Set(field.options).size !== field.options.length)) throw Error('Notion 选项名称无效或重复。');
        settings = { options: (field.options || []).map(name => ({ name })) };
      } else if (field.options !== undefined) throw Error('Notion 只有单选/多选字段可设置 options。');
      if (field.type === 'number' && field.number_format !== undefined) settings.format = text(field.number_format, '数字格式', 40);
      else if (field.number_format !== undefined) throw Error('Notion 只有数字字段可设置显示格式。');
      if (field.type === 'formula') settings.expression = text(field.expression, '公式', 2000);
      else if (field.expression !== undefined) throw Error('Notion 只有公式字段可设置 expression。');
      if (field.type === 'relation') settings = { data_source_id: await authorize(field.related_data_source_id, 'data_source'), type: 'single_property', single_property: {} };
      else if (field.related_data_source_id !== undefined) throw Error('Notion 只有关联字段可指定目标数据源。');
      result[name] = { [field.type]: settings };
    }
    const titles = Object.values(result).filter(field => field.title).length;
    if (creating && !titles) { if (Object.hasOwn(result, '名称')) throw Error('Notion 缺少 title 字段；“名称”已被其他类型占用。'); result['名称'] = { title: {} }; }
    if (titles > 1) throw Error('Notion 数据库只能有一个 title 字段。');
    return result;
  };
  const propertyBody = async (input, schema, creating) => {
    if (!object(input) || !Object.keys(input).length || Object.keys(input).length > 100) throw Error('Notion 记录字段必须是非空对象。');
    const properties = Object.create(null);
    for (const [key, value] of Object.entries(input)) {
      nameOf(key);
      const field = schema[key] || Object.values(schema).find(item => item.id === key);
      if (!field) throw Error(`Notion 数据源没有字段“${key}”，请先读取字段定义。`);
      const type = typeOf(field);
      let converted;
      if (type === 'title' || type === 'rich_text') converted = richText(text(value, '文字字段', 20000, true));
      else if (['number', 'checkbox'].includes(type)) { if (type === 'number' ? value !== null && (typeof value !== 'number' || !Number.isFinite(value)) : typeof value !== 'boolean') throw Error('Notion 数字或复选框字段类型错误。'); converted = value; }
      else if (['select', 'status'].includes(type)) converted = value === null ? null : { name: text(value, '选项', 100) };
      else if (type === 'multi_select') { if (!Array.isArray(value) || value.length > 100 || new Set(value).size !== value.length) throw Error('Notion 多选字段必须为不重复的名称数组。'); converted = value.map(name => ({ name: text(name, '选项', 100) })); }
      else if (['url', 'email', 'phone_number'].includes(type)) converted = value === null ? null : text(value, '链接/联系字段', 2000, true);
      else if (type === 'date') {
        if (value === null) converted = null;
        else { if (!object(value) || Object.keys(value).some(key => !['start', 'end', 'time_zone'].includes(key)) || !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value.start) || value.end != null && !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value.end) || value.time_zone != null && typeof value.time_zone !== 'string') throw Error('Notion 日期字段格式错误。'); converted = { ...value }; }
      } else if (type === 'relation' || type === 'people') {
        if (!Array.isArray(value) || value.length > 100 || new Set(value).size !== value.length) throw Error('Notion 关联/人员字段必须为 UUID 数组。');
        converted = [];
        for (const valueId of value) converted.push({ id: type === 'relation' ? await authorize(valueId, 'page') : uuid(valueId) });
      } else throw Error(`Notion 字段类型 ${type || 'unknown'} 不能通过当前记录工具写入；公式、汇总、创建/编辑时间由 Notion 计算。`);
      properties[field.name || key] = { [type]: converted };
    }
    if (creating) {
      const titleField = Object.entries(schema).find(([, field]) => typeOf(field) === 'title');
      if (!titleField || !Object.values(properties).some(property => property.title?.length && plain(property.title).trim())) throw Error('Notion 新记录需要非空标题字段。');
    }
    return properties;
  };
  const propertiesMatch = (actual, expected) => Object.entries(expected).every(([name, value]) => {
    const found = actual[name] || Object.values(actual).find(field => field.id === name);
    if (found && typeOf(value) === 'date') {
      const normalized = property => {
        const date = simpleValue(property);
        const instant = text => text && /T/.test(text) && /(?:Z|[+-]\d{2}:\d{2})$/.test(text) && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : text;
        return date && { ...date, start: instant(date.start), end: instant(date.end) };
      };
      return stable(normalized(found)) === stable(normalized(value));
    }
    return !!found && stable(simpleValue(found)) === stable(simpleValue(value));
  });
  const execute = async (name, args = {}) => {
    signal?.throwIfAborted(); validateArgs(name, args);
    if (name === 'search_databases') {
      text(args.query, '搜索词', 200, true);
      if (args.start_cursor !== undefined) text(args.start_cursor, '搜索游标', 2000);
      const data = await request('POST', 'search', { query: args.query, filter: { value: 'data_source', property: 'object' }, page_size: 25, ...(args.start_cursor ? { start_cursor: args.start_cursor } : {}) });
      const results = [], skipped = [];
      for (const source of data.results || []) {
        try { await authorize(source.id, 'data_source'); } catch (error) { if (signal?.aborted) throw error; if (error.code !== 'NOTION_RESEARCH_SCOPE') skipped.push({ data_source_id: source.id, error: 'Notion 数据源不在本地授权范围。' }); continue; }
        results.push({ data_source_id: uuid(source.id), database_id: source.parent?.database_id || null, title: plain(source.title), url: source.url || urlFor(source.parent?.database_id || source.id) });
      }
      return { results, scanned: (data.results || []).length, skipped, incomplete_pages: [], has_more: !!data.has_more, next_cursor: data.next_cursor || null, complete: !data.has_more && !skipped.length };
    }
    if (name === 'read_database') {
      if (!!args.database_id === !!args.data_source_id) throw Error('Notion database_id 与 data_source_id 必须二选一。');
      if (args.data_source_id) return schemaResult(await sourceById(args.data_source_id));
      const id = await authorize(args.database_id, 'database'), database = await request('GET', `databases/${id}`, null);
      const sources = [];
      if (!database.in_trash && !database.archived) for (const source of (database.data_sources || []).slice(0, 25)) sources.push(schemaResult(await sourceById(source.id)));
      const token = databaseRevision(database); seenDatabases.set(id, token);
      return { database_id: id, title: plain(database.title), description: plain(database.description), url: database.url || urlFor(id), in_trash: database.in_trash === true || database.archived === true, database_revision: token, data_source_id: database.data_sources?.length === 1 ? database.data_sources[0].id : null, data_source_ids: (database.data_sources || []).map(source => source.id), data_sources: sources, incomplete: (database.data_sources || []).length > 25, ...(database.in_trash || database.archived ? { note: '数据库在垃圾箱中，仅返回元数据；恢复后可读取字段和记录。' } : {}) };
    }
    if (name === 'query_database') {
      const source = await sourceById(args.data_source_id), id = uuid(source.id);
      if (args.page_size !== undefined && (!Number.isInteger(args.page_size) || args.page_size < 1 || args.page_size > 100)) throw Error('Notion 查询分页大小无效。');
      if (args.start_cursor !== undefined) text(args.start_cursor, '查询游标', 2000);
      if (args.filter !== undefined && (!object(args.filter) || JSON.stringify(args.filter).length > 20000)) throw Error('Notion 数据库筛选条件无效。');
      if (args.sorts !== undefined && (!Array.isArray(args.sorts) || args.sorts.length > 100 || args.sorts.some(sort => !object(sort) || Object.keys(sort).some(key => !['property', 'timestamp', 'direction'].includes(key)) || !['ascending', 'descending'].includes(sort.direction) || !!sort.property === !!sort.timestamp || sort.timestamp && !['created_time', 'last_edited_time'].includes(sort.timestamp) || sort.property && typeof sort.property !== 'string'))) throw Error('Notion 数据库排序条件无效。');
      const body = { page_size: args.page_size || 25, ...(args.start_cursor ? { start_cursor: args.start_cursor } : {}), ...(args.filter ? { filter: args.filter } : {}), ...(args.sorts ? { sorts: args.sorts } : {}) };
      const data = await request('POST', `data_sources/${id}/query`, body);
      return { data_source_id: id, results: (data.results || []).map(rememberEntry), has_more: !!data.has_more, next_cursor: data.next_cursor || null, complete: !data.has_more };
    }
    if (name === 'create_database') {
      const parent = await authorize(args.parent_page_id, 'page'), title = text(args.title, '数据库名称', 500), properties = await buildColumns(args.columns, true);
      if (args.is_inline !== undefined && typeof args.is_inline !== 'boolean') throw Error('Notion is_inline 必须为布尔值。');
      const body = { parent: { type: 'page_id', page_id: parent }, title: richText(title), is_inline: args.is_inline !== false, initial_data_source: { properties } };
      return mutate({ name, target: parent, args, method: 'POST', endpoint: 'databases', body, verify: async created => {
        const id = uuid(created.id), database = await request('GET', `databases/${id}`, null), first = database.data_sources?.[0];
        if (!first) return { verified: false, database_id: id, url: database.url || urlFor(id), note: '数据库已提交，但未返回可核验的数据源；请勿重复创建。' };
        const source = await request('GET', `data_sources/${uuid(first.id)}`, null);
        const verified = plain(database.title) === title && database.parent?.page_id === parent && database.is_inline === body.is_inline && columnsMatch(source.properties, properties);
        const schema = schemaResult(source); seenSchemas.set(schema.data_source_id, schema.schema_revision); seenDatabases.set(id, databaseRevision(database));
        return { verified, database_id: id, url: database.url || urlFor(id), title, data_source_id: schema.data_source_id, data_sources: [schema], database_revision: databaseRevision(database) };
      } });
    }
    if (name === 'update_database') {
      const id = await authorize(args.database_id, 'database'); text(args.database_revision, '数据库版本', 64);
      if (seenDatabases.get(id) !== args.database_revision) throw Error('Notion 必须先在本轮 read_database，再修改数据库。');
      const before = await request('GET', `databases/${id}`, null);
      if (databaseRevision(before) !== args.database_revision) throw Error('Notion 数据库在读取后已变化，请重新读取。');
      const body = {};
      if (args.title !== undefined) body.title = richText(text(args.title, '数据库名称', 500));
      if (args.description !== undefined) body.description = richText(text(args.description, '数据库说明', 20000, true));
      if (!Object.keys(body).length) throw Error('Notion 没有指定数据库修改内容。');
      return mutate({ name, target: id, args, method: 'PATCH', endpoint: `databases/${id}`, body, verify: async () => {
        const after = await request('GET', `databases/${id}`, null), token = databaseRevision(after); seenDatabases.set(id, token);
        return { verified: (!body.title || plain(after.title) === args.title) && (!body.description || plain(after.description) === args.description), database_id: id, title: plain(after.title), url: after.url || urlFor(id), database_revision: token };
      } });
    }
    if (name === 'trash_database' || name === 'restore_database') {
      const id = await authorize(args.database_id, 'database'); text(args.database_revision, '数据库版本', 64);
      if (seenDatabases.get(id) !== args.database_revision) throw Error('Notion 必须先在本轮 read_database，再修改数据库垃圾箱状态。');
      const before = await request('GET', `databases/${id}`, null);
      if (databaseRevision(before) !== args.database_revision) throw Error('Notion 数据库在读取后已变化，请重新读取。');
      const inTrash = name === 'trash_database';
      return mutate({ name, target: id, args, method: 'PATCH', endpoint: `databases/${id}`, body: { in_trash: inTrash }, verify: async () => {
        const after = await request('GET', `databases/${id}`, null), token = databaseRevision(after); seenDatabases.set(id, token);
        return { verified: (after.in_trash === true || after.archived === true) === inTrash && stable(after.parent) === stable(before.parent) && plain(after.title) === plain(before.title), database_id: id, title: plain(after.title), url: after.url || urlFor(id), in_trash: after.in_trash === true || after.archived === true, database_revision: token };
      } });
    }
    if (name === 'update_database_schema') {
      const id = await authorize(args.data_source_id, 'data_source'); text(args.schema_revision, '字段版本', 64);
      if (seenSchemas.get(id) !== args.schema_revision) throw Error('Notion 必须先在本轮 read_database，再修改数据源字段。');
      const before = await request('GET', `data_sources/${id}`, null);
      if (revision(before.properties) !== args.schema_revision) throw Error('Notion 数据源字段在读取后已变化，请重新读取。');
      const additions = await buildColumns(args.add_columns), patch = { ...additions }, used = new Set();
      for (const key of Object.keys(additions)) if (Object.hasOwn(before.properties, key) || additions[key].title) throw Error('Notion 添加字段不能覆盖已有字段或另建 title。');
      if (args.rename_columns !== undefined && (!Array.isArray(args.rename_columns) || args.rename_columns.length > 100)) throw Error('Notion 字段重命名列表无效。');
      for (const rename of args.rename_columns || []) {
        if (!object(rename) || Object.keys(rename).some(key => !['from', 'to'].includes(key))) throw Error('Notion 字段重命名格式无效。');
        const from = nameOf(rename.from), to = nameOf(rename.to);
        if (!Object.hasOwn(before.properties, from) || Object.hasOwn(before.properties, to) || Object.hasOwn(patch, to) || used.has(from)) throw Error('Notion 重命名字段不存在、重复或与已有名称冲突。');
        patch[from] = { name: to }; used.add(from); used.add(to);
      }
      if (args.remove_columns !== undefined && (!Array.isArray(args.remove_columns) || args.remove_columns.length > 100)) throw Error('Notion 删除字段列表无效。');
      for (const key of args.remove_columns || []) {
        nameOf(key);
        if (!Object.hasOwn(before.properties, key) || used.has(key) || typeOf(before.properties[key]) === 'title') throw Error('Notion 不能删除 title、重复操作或不存在的字段。');
        patch[key] = null; used.add(key);
      }
      if (!Object.keys(patch).length) throw Error('Notion 没有指定字段修改。');
      return mutate({ name, target: id, args, method: 'PATCH', endpoint: `data_sources/${id}`, body: { properties: patch }, verify: async () => {
        const after = await request('GET', `data_sources/${id}`, null), result = schemaResult(after); seenSchemas.set(id, result.schema_revision);
        const removed = new Set(args.remove_columns || []), renamed = new Map((args.rename_columns || []).map(change => [change.from, change.to]));
        const preserved = Object.entries(before.properties).every(([key, field]) => removed.has(key) || typeOf(after.properties[renamed.get(key) || key]) === typeOf(field));
        const verified = columnsMatch(after.properties, additions) && preserved && (args.rename_columns || []).every(change => !Object.hasOwn(after.properties, change.from) && Object.hasOwn(after.properties, change.to)) && (args.remove_columns || []).every(key => !Object.hasOwn(after.properties, key));
        return { ...result, verified };
      } });
    }
    if (name === 'read_database_entry') { const id = await authorize(args.page_id, 'page'); return rememberEntry(await request('GET', `pages/${id}`, null)); }
    if (name === 'read_database_entry_property') {
      const id = await authorize(args.page_id, 'page'); text(args.property_id, '字段 ID', 200);
      let decoded; try { decoded = decodeURIComponent(args.property_id); } catch { decoded = args.property_id; }
      if (['.', '..'].includes(decoded) || /[\u0000-\u001f\u007f]/.test(decoded)) throw Error('Notion 字段 ID 无效。');
      if (args.start_cursor !== undefined) text(args.start_cursor, '字段游标', 2000);
      if (args.page_size !== undefined && (!Number.isInteger(args.page_size) || args.page_size < 1 || args.page_size > 100)) throw Error('Notion 字段分页大小无效。');
      const query = new URLSearchParams({ page_size: String(args.page_size || 100), ...(args.start_cursor ? { start_cursor: args.start_cursor } : {}) });
      const data = await request('GET', `pages/${id}/properties/${encodeURIComponent(decoded)}?${query}`, null);
      if (data.object === 'property_item') return { page_id: id, property_id: data.id || args.property_id, property_type: data.type, value: simpleValue(data), has_more: false, next_cursor: null, complete: true };
      if (data.object !== 'list' || !Array.isArray(data.results)) throw Error('Notion 字段分页返回格式异常。');
      const type = data.property_item?.type || data.results[0]?.type, more = data.has_more === true;
      const items = data.results.map(item => {
        if (['title', 'rich_text'].includes(item.type)) return plain([item[item.type]]);
        if (['people', 'relation'].includes(item.type)) return item[item.type]?.id || null;
        return simpleValue(item);
      });
      const value = ['title', 'rich_text'].includes(type) ? items.join('') : type === 'rollup' ? more ? null : data.property_item?.rollup : items;
      return { page_id: id, property_id: data.property_item?.id || args.property_id, property_type: type, value, items, has_more: more, next_cursor: data.next_cursor || null, complete: !more, ...(type === 'rollup' ? { rollup: data.property_item?.rollup, note: more ? '汇总仍需后续分页，当前不能用作最终结果。' : '已读取本次字段的最后一批；需结合此前批次。' } : {}) };
    }
    if (name === 'create_database_entry') {
      const source = await sourceById(args.data_source_id), id = uuid(source.id), properties = await propertyBody(args.properties, source.properties, true);
      if (args.content !== undefined) text(args.content, '记录正文', 20000, true);
      const body = { parent: { type: 'data_source_id', data_source_id: id }, properties, ...(args.content ? { markdown: args.content, allow_async: false } : {}) };
      return mutate({ name, target: id, args, method: 'POST', endpoint: 'pages', body, verify: async created => {
        const page = await request('GET', `pages/${uuid(created.id)}`, null), result = rememberEntry(page);
        let verified = page.parent?.data_source_id === id && propertiesMatch(page.properties, properties);
        if (args.content) { const content = await request('GET', `pages/${uuid(created.id)}/markdown`, null); verified &&= !content.truncated && !content.unknown_block_ids?.length && content.markdown?.replace(/\r\n/g, '\n').trim() === args.content.replace(/\r\n/g, '\n').trim(); }
        return { ...result, data_source_id: id, verified };
      } });
    }
    if (name === 'update_database_entry') {
      const id = await authorize(args.page_id, 'page'); text(args.property_revision, '记录字段版本', 64);
      if (seenEntries.get(id) !== args.property_revision) throw Error('Notion 必须先在本轮读取或查询记录，再修改字段。');
      const before = await request('GET', `pages/${id}`, null);
      if (revision(before.properties) !== args.property_revision) throw Error('Notion 记录字段在读取后已变化，请重新读取。');
      if (!before.parent?.data_source_id) throw Error('Notion 此页面不是数据库记录。');
      const source = await sourceById(before.parent.data_source_id), properties = await propertyBody(args.properties, source.properties, false);
      if (Object.values(before.properties).some(property => property.has_more) && Object.entries(properties).some(([key]) => before.properties[key]?.has_more)) throw Error('Notion 要修改的字段尚未完整读取，拒绝覆盖截断字段。');
      return mutate({ name, target: id, args, method: 'PATCH', endpoint: `pages/${id}`, body: { properties }, verify: async () => { const after = await request('GET', `pages/${id}`, null); return { ...rememberEntry(after), verified: propertiesMatch(after.properties, properties) }; } });
    }
    throw Error('Notion 数据库工具尚未实现。');
  };
  return { execute };
}

module.exports = { definitions, writeTools, createSession };
