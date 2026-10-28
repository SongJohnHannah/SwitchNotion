const { randomUUID, createHash } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { prepareBuildPreview } = require('./native-database-build.cjs');
const fail = message => { throw Error('Notion AI 建库' + message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
const plain = value => Array.isArray(value) ? value.map(span => typeof span?.[0] === 'string' ? span[0] : '').join('') : '';
const fingerprint = plan => { const { planHash, ...rest } = plan; return hash(rest); };
const viewIds = plan => plan.viewIds || [plan.viewId];
const includes = (actual, expected) => Array.isArray(expected) ? Array.isArray(actual) && actual.length === expected.length && expected.every((value, at) => includes(actual[at], value))
  : object(expected) ? object(actual) && Object.entries(expected).every(([key, value]) => includes(actual[key], value)) : actual === expected;
function nativeEntry(value) {
  for (let at = 0; at < 4 && object(value); at++, value = value.value)
    if (value.value?.id && typeof value.role === 'string') return value;
}
const parentHash = entry => hash({ role: entry.role, id: entry.value.id, type: entry.value.type,
  parent_table: entry.value.parent_table, parent_id: entry.value.parent_id, space_id: entry.value.space_id,
  alive: entry.value.alive, properties: entry.value.properties, permissions: entry.value.permissions, content: entry.value.content });
class NativeBuildStore {
  constructor({ native }) {
    this.native = native; this.spaceId = uuid(native?.spaceId); this.userId = uuid(native?.userId);
    if (!this.spaceId || !this.userId || typeof native.api !== 'function') fail('原生登录账号尚未就绪。');
  }
  async read(pointers, signal, allowMissing = false) {
    if (!Array.isArray(pointers) || pointers.length > 100 || pointers.some(pointer => !['block', 'space', 'collection', 'collection_view'].includes(pointer.table) ||
        !uuid(pointer.id) || pointer.spaceId !== this.spaceId)) fail('原生记录范围或工作区无效。');
    signal?.throwIfAborted();
    const response = await this.native.api('getRecordValues', { requests: pointers }, { signal, spaceId: this.spaceId });
    signal?.throwIfAborted(); const result = new Map();
    for (let at = 0; at < pointers.length; at++) {
      const pointer = pointers[at], entry = nativeEntry(response.results?.[at] || response.recordMap?.[pointer.table]?.[pointer.id]), value = entry?.value;
      if (!value && allowMissing) continue;
      if (!value || uuid(value.id) !== pointer.id || value.alive === false ||
          (pointer.table === 'space' ? pointer.id !== this.spaceId : uuid(value.space_id) !== this.spaceId) ||
          !['reader', 'commenter', 'editor', 'owner'].includes(entry.role)) fail('记录不可读取或工作区不匹配。');
      result.set(pointer.table + ':' + pointer.id, { role: entry.role, value: structuredClone(value) });
    }
    return result;
  }
  async parent(pointer, signal, editable = true) {
    if (!pointer || !['block', 'space'].includes(pointer.table) || !uuid(pointer.id) || pointer.spaceId !== this.spaceId ||
        pointer.table === 'space' && pointer.id !== this.spaceId) fail('父级不属于当前工作区。');
    const record = (await this.read([pointer], signal)).get(pointer.table + ':' + pointer.id);
    if (editable && !['editor', 'owner'].includes(record.role) || pointer.table === 'block' && !['page', 'collection_view_page', 'meeting_note_page'].includes(record.value.type))
      fail('父级不是可编辑的目标页面或工作区。');
    if (pointer.table === 'block' && (!Array.isArray(record.value.content || []) || (record.value.content || []).some(id => !uuid(id)))) fail('父页面结构不完整。');
    return record;
  }
  pointers(plan) {
    return [{ table: 'block', id: plan.databaseId, spaceId: this.spaceId }, { table: 'collection', id: plan.collectionId, spaceId: this.spaceId },
      ...viewIds(plan).map(id => ({ table: 'collection_view', id, spaceId: this.spaceId }))];
  }
  check(plan) {
    if (!object(plan) || plan.spaceId !== this.spaceId || plan.userId !== this.userId ||
        !Array.isArray(viewIds(plan)) || viewIds(plan).length < 1 || viewIds(plan).length > 8 || viewIds(plan)[0] !== plan.viewId ||
        ![plan.databaseId, plan.collectionId, ...viewIds(plan), plan.transactionId, plan.requestId].every(uuid) ||
        new Set([plan.databaseId, plan.collectionId, ...viewIds(plan), plan.parentPointer?.id]).size !== viewIds(plan).length + 3 ||
        !/^[a-f\d]{64}$/.test(plan.parentHash || '') || plan.planHash !== fingerprint(plan)) fail('预览身份、范围或已确认方案发生变化。');
    if (Buffer.byteLength(JSON.stringify(plan)) > 500000) fail('预览方案过长。');
  }
  async prepare(draft, parentPointer, signal) {
    const parent = await this.parent(parentPointer, signal), before = parent.value.content || [];
    const plan = prepareBuildPreview(draft, { spaceId: this.spaceId, userId: this.userId, parentPointer,
      ...(before.length ? { afterId: before.at(-1) } : {}) });
    Object.assign(plan, { parentHash: parentHash(parent), parentContent: [...before], transactionId: randomUUID(), requestId: randomUUID() });
    plan.planHash = fingerprint(plan); this.check(plan); return plan;
  }
  async submit(plan, { signal, confirmation, onSubmit = () => {} } = {}) {
    this.check(plan); signal?.throwIfAborted();
    if (!confirmation || confirmation.decision !== 'confirmed' || confirmation.stepId !== plan.step.id || confirmation.planHash !== plan.planHash ||
        uuid(confirmation.userId) !== this.userId || uuid(confirmation.spaceId) !== this.spaceId) fail('必须先取得当前账号、工作区和原始方案对应的原生确认，未创建数据库。');
    const existing = await this.read(this.pointers(plan), signal, true);
    if (existing.size) {
      const actual = await this.verify(plan, signal);
      if (actual.ok) return { reused: true, ...actual };
      fail('预览记录已存在但结果不完整或不匹配；只核对，不重复创建或覆盖。');
    }
    const current = await this.parent(plan.parentPointer, signal);
    if (parentHash(current) !== plan.parentHash) fail('父页面内容、位置或权限在预览期间发生变化，请重新生成预览。');
    const operations = structuredClone(plan.step.threadOperations.map(item => item.operation));
    if (plan.parentPointer.table === 'block') operations.push({ pointer: plan.parentPointer, command: 'update', path: [], args: {
      last_edited_time: Date.now(), last_edited_by_table: 'notion_user', last_edited_by_id: this.userId
    } });
    const payload = { requestId: plan.requestId, transactions: [{ id: plan.transactionId, spaceId: this.spaceId, operations }] };
    if (Buffer.byteLength(JSON.stringify(payload)) > 450000) fail('创建事务过长。');
    signal?.throwIfAborted(); onSubmit();
    await this.native.api('saveTransactionsFanout', payload, { signal, spaceId: this.spaceId });
    return { reused: false };
  }
  async verify(plan, signal) {
    this.check(plan);
    const pointers = this.pointers(plan), actual = await this.read([...pointers, plan.parentPointer], signal, true);
    const expected = Object.fromEntries(plan.step.threadOperations.map(item => item.operation).filter(operation => operation.command === 'set')
      .map(operation => [operation.pointer.table, operation.args]));
    const block = actual.get('block:' + plan.databaseId), collection = actual.get('collection:' + plan.collectionId),
      parent = actual.get(plan.parentPointer.table + ':' + plan.parentPointer.id);
    const schema = collection?.value.schema;
    const fieldsMatch = object(schema) && Object.keys(schema).length === Object.keys(expected.collection.schema).length &&
      Object.entries(expected.collection.schema).every(([id, field]) => {
        const saved = schema[id];
        return saved?.type === field.type && saved.name === field.name && (!field.options || hash(saved.options) === hash(field.options)) &&
          (!field.groups || hash(saved.groups) === hash(field.groups)) && (!field.number_format || saved.number_format === field.number_format);
      });
    const parentLinked = !!parent && (plan.parentPointer.table === 'space' || Array.isArray(parent.value.content) &&
      parent.value.content.filter(id => id === plan.databaseId).length === 1 && plan.parentContent.every(id => parent.value.content.includes(id)));
    const viewsMatch = viewIds(plan).every(id => {
      const record = actual.get('collection_view:' + id), value = record?.value, expectedView = plan.step.threadOperations.find(({ operation }) =>
        operation.command === 'set' && operation.pointer.table === 'collection_view' && operation.pointer.id === id)?.operation.args;
      if (!expectedView || !value) return false;
      const query = value.query2 || {}, expectedQuery = expectedView.query2 || {};
      const noExtraQuery = ['sort', 'filter', 'calendar_by', 'timeline_by', 'timeline_by_end', 'group_by'].every(key => {
        if (Object.hasOwn(expectedQuery, key) || query[key] == null) return true;
        if (key === 'sort') return Array.isArray(query[key]) && !query[key].length;
        if (key === 'filter') return object(query[key]) && (!Object.keys(query[key]).length ||
          query[key].operator === 'and' && Array.isArray(query[key].filters) && !query[key].filters.length && Object.keys(query[key]).every(key => ['operator', 'filters'].includes(key)));
        return key === 'group_by' && expectedView.type === 'board' && query[key] === expectedView.format.board_columns_by.property;
      });
      return !!expectedView && !!value && ['editor', 'owner'].includes(record.role) && value.parent_table === 'block' && uuid(value.parent_id) === plan.databaseId &&
        value.type === expectedView.type && value.name === expectedView.name && includes(value.format, expectedView.format) && noExtraQuery && includes(query, expectedQuery);
    });
    const ok = !!block && !!collection && [block, collection].every(record => ['editor', 'owner'].includes(record.role)) && viewsMatch && parentLinked &&
      block.value.type === expected.block.type && block.value.collection_id === plan.collectionId &&
      plain(block.value.properties?.title) === plan.draft.title &&
      (plan.parentPointer.table !== 'space' || hash(block.value.permissions) === hash(expected.block.permissions)) &&
      block.value.parent_table === plan.parentPointer.table && uuid(block.value.parent_id) === plan.parentPointer.id &&
      hash(block.value.view_ids) === hash(viewIds(plan)) &&
      collection.value.parent_table === 'block' && uuid(collection.value.parent_id) === plan.databaseId && plain(collection.value.name) === plan.draft.title && fieldsMatch;
    const recordMap = { __version__: 3 };
    for (const pointer of [...pointers, plan.parentPointer]) {
      const record = actual.get(pointer.table + ':' + pointer.id); if (!record) continue;
      recordMap[pointer.table] ||= {}; recordMap[pointer.table][pointer.id] = { spaceId: this.spaceId, value: record };
    }
    return { ok: !!ok, absent: pointers.every(pointer => !actual.has(pointer.table + ':' + pointer.id)), recordMap,
      databaseId: plan.databaseId, collectionId: plan.collectionId, viewId: plan.viewId };
  }
}
module.exports = { NativeBuildStore };
