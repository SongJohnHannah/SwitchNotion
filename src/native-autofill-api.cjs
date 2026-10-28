const { createHash } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { simpleValuesEqual } = require('./notion-databases.cjs');
const fail = message => { throw Error('Notion Autofill ' + message); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const decoded = value => { try { return decodeURIComponent(value); } catch { return value; } };
const apiType = field => field.type === 'text' ? 'rich_text' : field.type === 'person' ? 'people' : field.type;
const stateHash = entry => hash([entry.property_revision, entry.properties]);
function nameFor(entry, fieldId) {
  const names = Object.keys(entry.property_ids || {}).filter(name => decoded(entry.property_ids[name]) === decoded(fieldId));
  if (names.length !== 1) fail('公开 API 与原生字段标识不匹配。');
  return names[0];
}
async function openApi(store, signal, { parentId, write = false, operationScope = 'native-autofill-properties' } = {}) {
  if (!store.workspace?.open) fail('关系填充需要当前工作区现有的 API 连接。');
  const session = await store.workspace.open({ signal, operationScope, nativeContext: { workspace_id: store.spaceId },
    ...(!write ? { readScope: { workspaceId: store.spaceId, ...(parentId ? { rootIds: [parentId] } : {}) } } : {}) });
  if (uuid(session?.context?.current_workspace_id) !== store.spaceId || !session.definitions?.some(value => value.function.name === (write ? 'update_database_entry' : 'read_database_entry'))) fail('当前工作区 API 未连接、不可读取或未启用字段写入。');
  return { ...session, execute: (name, args) => session.execute(name, { ...args, workspace_id: store.spaceId }) };
}
function checkedEntry(entry, rowId, collectionId) {
  if (uuid(entry?.page_id) !== rowId || uuid(entry.workspace_id) === null || uuid(entry.parent?.data_source_id) !== collectionId || entry.in_trash || entry.archived ||
      typeof entry.property_revision !== 'string' || !/^[a-f\d]{64}$/.test(entry.property_revision) || !entry.properties || !entry.property_ids) fail('公开 API 记录归属、状态或字段版本无效。');
  return entry;
}
async function loadApiProperties(store, snapshot, signal) {
  if (!snapshot.fields.some(field => field.type === 'relation')) return;
  const session = await openApi(store, signal, { parentId: snapshot.collection.parent_id });
  const schema = await session.execute('read_database', { data_source_id: snapshot.info.collectionId });
  if (uuid(schema.data_source_id) !== snapshot.info.collectionId || uuid(schema.parent?.database_id) !== uuid(snapshot.collection.parent_id) || !/^[a-f\d]{64}$/.test(schema.schema_revision || '')) fail('公开 API 数据源与原生数据库不匹配。');
  const mapping = {};
  for (const field of snapshot.fields) {
    const found = Object.entries(schema.properties || {}).filter(([, value]) => decoded(value.id) === decoded(field.id));
    if (found.length !== 1 || found[0][1].type !== apiType(field)) fail('公开 API 字段结构与原生字段不一致。');
    mapping[field.id] = found[0][0];
    if (field.type === 'relation' && uuid(found[0][1].relation?.data_source_id) !== field.target_collection_id) fail('公开 API 关系字段指向了不同数据源。');
  }
  snapshot.apiSchemaRevision = schema.schema_revision;
  for (const row of snapshot.rows) {
    const entry = checkedEntry(await session.execute('read_database_entry', { page_id: row.pageId }), row.pageId, snapshot.info.collectionId);
    if (uuid(entry.workspace_id) !== store.spaceId) fail('公开 API 返回了其他工作区。');
    if (snapshot.fields.some(field => nameFor(entry, field.id) !== mapping[field.id] || (entry.incomplete_properties || []).includes(nameFor(entry, field.id)))) fail('目标字段在读取中变化或包含未完整返回的分页值，未以截断内容生成或覆盖。');
    row.api = { revision: entry.property_revision, properties: entry.properties, propertyIds: entry.property_ids, mapping, stateHash: stateHash(entry) };
  }
}
function apiValue(field, value) {
  if (value === null) return ['text', 'title'].includes(field.type) ? '' : ['relation', 'multi_select', 'person'].includes(field.type) ? [] : field.type === 'checkbox' ? false : null;
  if (field.type === 'relation') return value.map(uuid);
  if (field.type === 'date' && value.time_zone) return { ...value, start: value.start.slice(0, 16) + ':00', ...(value.end ? { end: value.end.slice(0, 16) + ':00' } : {}) };
  return value;
}
function planApi(snapshot, row, output, propertyIds, contextHash) {
  if (!row.api) return;
  const fields = snapshot.fields.filter(field => propertyIds.includes(field.id)), properties = Object.create(null), before = Object.create(null), targets = [];
  for (const field of fields) {
    const name = row.api.mapping[field.id]; properties[name] = apiValue(field, output[field.id]); before[name] = row.api.properties[name];
    if (field.type === 'relation') for (const id of properties[name]) targets.push({ id, collectionId: field.target_collection_id });
  }
  return { version: 1, collectionId: snapshot.info.collectionId, parentId: snapshot.collection.parent_id, revision: row.api.revision, contextHash,
    fields: fields.map(field => ({ id: field.id, name: row.api.mapping[field.id], type: apiType(field) })), properties, before, targets };
}
async function submitApi(store, plan, snapshot, signal, onSubmit) {
  const session = await openApi(store, signal, { write: true, operationScope: 'native-autofill:' + plan.id }), scope = plan.api;
  if (scope.version !== 1 || scope.collectionId !== snapshot.info.collectionId || scope.parentId !== snapshot.collection.parent_id || !Array.isArray(scope.fields) ||
      hash(scope.fields.map(field => field.id).sort()) !== hash([...plan.propertyIds].sort()) || hash(Object.keys(scope.properties).sort()) !== hash(scope.fields.map(field => field.name).sort()) ||
      scope.fields.some(field => !snapshot.fields.some(value => value.id === field.id && value.name === field.name && apiType(value) === field.type))) fail('公开 API 写回字段超出本次选择范围。');
  const expectedTargets = snapshot.fields.filter(field => field.type === 'relation' && plan.propertyIds.includes(field.id)).flatMap(field =>
    (scope.properties[field.name] || []).map(id => ({ id, collectionId: field.target_collection_id })));
  if (hash(scope.targets) !== hash(expectedTargets)) fail('关系目标记录与所选字段不匹配。');
  for (const target of scope.targets) {
    const row = checkedEntry(await session.execute('read_database_entry', { page_id: target.id }), target.id, target.collectionId);
    if (uuid(row.workspace_id) !== store.spaceId) fail('关系目标属于其他工作区。');
  }
  const current = checkedEntry(await session.execute('read_database_entry', { page_id: plan.rowId }), plan.rowId, scope.collectionId);
  if (uuid(current.workspace_id) !== store.spaceId || current.property_revision !== scope.revision) fail('记录在生成后发生变化，未提交关系字段。');
  for (const field of scope.fields) if (nameFor(current, field.id) !== field.name) fail('目标字段名称或结构已变化。');
  const native = (await store.read('block', [plan.rowId], signal, true)).get(plan.rowId), ids = plan.statusPropertyIds || plan.propertyIds;
  if (native.parent_table !== 'collection' || uuid(native.parent_id) !== scope.collectionId || plan.statusBefore && hash(Object.fromEntries([...ids].sort().map(id => [id, native.format?.agent_workflow_status?.[id] ?? null]))) !== hash(plan.statusBefore)) fail('关系填写前目标记录或字段任务已变化。');
  signal?.throwIfAborted(); onSubmit();
  const result = await session.execute('update_database_entry', { page_id: plan.rowId, property_revision: current.property_revision, properties: scope.properties });
  if (result.verified !== true) fail('公开 API 字段写入尚未核验，未重复提交。');
  plan.afterHash = hash([scope.contextHash, stateHash(result)]); scope.verified = true; onSubmit();
}
async function verifyApi(store, plan, signal) {
  const session = await openApi(store, signal, { parentId: plan.api.parentId });
  const entry = checkedEntry(await session.execute('read_database_entry', { page_id: plan.rowId }), plan.rowId, plan.api.collectionId);
  if (uuid(entry.workspace_id) !== store.spaceId) fail('字段核验工作区不匹配。');
  const equal = values => plan.api.fields.every(field => simpleValuesEqual(field.type, entry.properties[nameFor(entry, field.id)], values[field.name]));
  const ok = equal(plan.api.properties), unchanged = equal(plan.api.before);
  if (ok) { plan.afterHash = hash([plan.api.contextHash, stateHash(entry)]); plan.api.verified = true; }
  return { ok, unchanged };
}
module.exports = { loadApiProperties, planApi, submitApi, verifyApi, nameFor };
