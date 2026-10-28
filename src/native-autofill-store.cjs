const { createHash, randomUUID } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { normalizeViewSnapshot, resolveViewInfo } = require('./native-autofill-view.cjs');
const { dateProperty } = require('./native-autofill-date.cjs');
const fail = message => { throw Error('Notion Autofill ' + message); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const plain = value => Array.isArray(value) ? value.map(span => typeof span?.[0] === 'string' ? span[0] : '').join('') : '';
const types = new Set(['text', 'title', 'select', 'multi_select', 'status', 'email', 'url', 'phone_number', 'number', 'checkbox', 'date']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function autofillInput(input) {
  const spaceId = uuid(input?.spaceId), collectionId = uuid(input?.collectionId), workflowId = uuid(input?.workflowPointer?.id);
  if (!spaceId || !collectionId || !workflowId || input.workflowPointer.table !== 'workflow' || uuid(input.workflowPointer.spaceId) !== spaceId) fail('工作区、数据库或工作流标识无效。');
  if (!['blockFill', 'viewFill'].includes(input.type)) fail('填充范围类型尚未支持。');
  if (!Array.isArray(input.propertyIds) || !input.propertyIds.length || input.propertyIds.length > 16) fail('目标字段范围无效或过大。');
  if (input.type === 'blockFill' && (!Array.isArray(input.blockIds) || !input.blockIds.length || input.blockIds.length > 200)) fail('记录范围无效或过大。');
  const rowIds = input.type === 'viewFill' ? undefined : input.blockIds.map(pointer => {
    if (pointer?.table !== 'block' || !uuid(pointer.id) || uuid(pointer.spaceId) !== spaceId) fail('记录指针不属于当前工作区。');
    return uuid(pointer.id);
  });
  if (input.propertyIds.some(id => typeof id !== 'string' || !id || id.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(id))) fail('目标字段标识无效。');
  if (input.fillMode !== undefined && input.fillMode !== 'emptyTargetProperties') fail('填充范围类型尚未支持。');
  let view;
  if (input.type === 'viewFill') {
    const viewId = uuid(input.viewId);
    if (!viewId || input.blockIds !== undefined) fail('视图填充范围不完整或含混。');
    view = { type: 'viewFill', viewId, viewSnapshot: normalizeViewSnapshot(input.notionSwitchView, { spaceId, collectionId, viewId }) };
  }
  return { spaceId, collectionId, workflowId, ...(view || { rowIds: [...new Set(rowIds)] }), propertyIds: [...new Set(input.propertyIds)],
    ...(input.fillMode ? { fillMode: input.fillMode } : {}) };
}
function semanticBlock(value, properties = value.properties) {
  return { id: value.id, type: value.type, parent_id: value.parent_id, parent_table: value.parent_table,
    space_id: value.space_id, alive: value.alive, properties, content: value.content || [] };
}
function sourceHash(snapshot, row, properties) {
  const data = [snapshot.info.spaceId, snapshot.info.collectionId, snapshot.info.workflowId, snapshot.collection.schema,
    snapshot.workflow.data, row.records.map(value => semanticBlock(value, value.id === row.pageId && properties ? properties : value.properties))];
  if (snapshot.info.type === 'viewFill') data.push(snapshot.info.viewSnapshot);
  return hash(data);
}
function nativeEntry(value) {
  for (let depth = 0; depth < 4 && object(value); depth++) {
    if (value.value?.id && typeof value.role === 'string') return value;
    value = value.value;
  }
}
class NativeAutofillStore {
  constructor({ native }) {
    this.native = native; this.spaceId = uuid(native.spaceId); this.userId = uuid(native.userId); this.roles = new Map();
    if (!this.spaceId || !this.userId || typeof native.api !== 'function') fail('当前账号的原生读取会话尚未就绪。');
  }
  async read(table, ids, signal, editable = false) {
    signal?.throwIfAborted();
    if (!['block', 'collection', 'collection_view', 'workflow'].includes(table) || !Array.isArray(ids) || ids.length > 1000 || ids.some(id => !uuid(id))) fail('记录读取范围无效。');
    const result = new Map();
    for (let at = 0; at < ids.length; at += 64) {
      const batch = ids.slice(at, at + 64), response = await this.native.api('getRecordValues', {
        requests: batch.map(id => ({ table, id, spaceId: this.spaceId }))
      }, { signal, spaceId: this.spaceId });
      signal?.throwIfAborted();
      for (let n = 0; n < batch.length; n++) {
        const entry = nativeEntry(response.results?.[n] || response.recordMap?.[table]?.[batch[n]]), value = entry?.value;
        if (!value || uuid(value.id) !== batch[n] || uuid(value.space_id) !== this.spaceId || value.alive === false ||
            !['reader', 'commenter', 'editor', 'owner'].includes(entry.role) || editable && !['editor', 'owner'].includes(entry.role)) fail('记录不可读取、不可编辑或工作区不匹配。');
        result.set(batch[n], structuredClone(value)); this.roles.set(table + ':' + batch[n], entry.role);
      }
    }
    return result;
  }
  async load(info, signal) {
    signal?.throwIfAborted();
    if (info.spaceId !== this.spaceId) fail('请求不属于当前登录工作区。');
    if (info.type === 'viewFill') info = await this.resolveInfo(info, signal);
    const collection = (await this.read('collection', [info.collectionId], signal)).get(info.collectionId);
    const workflow = (await this.read('workflow', [info.workflowId], signal)).get(info.workflowId);
    if (!object(collection.schema) || workflow.parent_table !== 'block' || workflow.parent_id !== collection.parent_id ||
        workflow.data?.isLite !== true || !Array.isArray(workflow.data.modules) || workflow.data.modules.length !== 1 || workflow.data.modules[0].type !== 'notion') fail('工作流不属于此数据库或不是已支持的基础填充模式。');
    const owned = workflow.data.modules[0].state?.ownedByDatabasePropertyIds;
    if (!Array.isArray(owned) || info.propertyIds.some(id => !owned.includes(id))) fail('目标字段未授权给所选填充工作流。');
    const fields = info.propertyIds.map(id => {
      const field = collection.schema[id];
      if (!field || typeof field.name !== 'string' || !types.has(field.type) || field.derived_property_record_metadata) fail('目标字段类型尚未支持或不允许填充。');
      const options = ['select', 'multi_select', 'status'].includes(field.type) ? field.options : undefined;
      if (options && (!Array.isArray(options) || options.some(option => typeof option.value !== 'string' || option.value.includes(',')))) fail('分类字段选项格式无效。');
      return { id, name: field.name, type: field.type, ...(options ? { options: options.map(option => option.value) } : {}),
        ...(field.ai_inference || field.select_ai_inference ? { configuration: structuredClone(field.ai_inference || field.select_ai_inference) } : {}) };
    });
    const instructionSpans = workflow.data.instructions || [];
    if (!Array.isArray(instructionSpans) || instructionSpans.some(span => !Array.isArray(span) || typeof span[0] !== 'string' ||
        span[1]?.some(annotation => !['b', 'i', 's', 'u', 'c', 'a', '_'].includes(annotation[0])))) fail('工作流指令含尚未读取的引用，未忽略来源继续填充。');
    const instructions = plain(instructionSpans).trim() || '根据记录正文和字段配置填充明确选择的字段。';
    if (instructions.length > 12000) fail('工作流指令过长。');
    const rows = [];
    for (const pageId of info.rowIds) {
      const root = (await this.read('block', [pageId], signal, true)).get(pageId);
      if (root.type !== 'page' || root.parent_table !== 'collection' || uuid(root.parent_id) !== info.collectionId) fail('所选记录不属于目标数据库。');
      const values = new Map([[pageId, root]]), pending = (root.content || []).map(id => ({ id: uuid(id), parent: pageId }));
      while (pending.length) {
        if (values.size + pending.length > 800) fail('记录正文过大，未使用截断资料填充。');
        const batch = pending.splice(0, 64), found = await this.read('block', batch.map(item => item.id), signal);
        for (const request of batch) {
          const value = found.get(request.id);
          if (values.has(request.id) || uuid(value.parent_id) !== request.parent || value.parent_table !== 'block') fail('记录正文归属或顺序已经变化。');
          values.set(request.id, value);
          if (!['page', 'collection_view', 'collection_view_page', 'link_to_page'].includes(value.type))
            pending.push(...(value.content || []).map(id => ({ id: uuid(id), parent: request.id })));
        }
      }
      const lines = [];
      const visit = id => {
        const value = values.get(id), properties = value.properties || {};
        const text = value.type === 'table_row' ? Object.values(properties).map(plain).join(' | ') : plain(properties.title);
        if (text.trim()) lines.push(text);
        if (id !== pageId && ['page', 'collection_view', 'collection_view_page', 'link_to_page'].includes(value.type)) return;
        for (const child of value.content || []) visit(uuid(child));
      };
      visit(pageId);
      const row = { pageId, properties: structuredClone(root.properties || {}), text: lines.join('\n'), records: [...values.values()],
        unreadMedia: [...values.values()].filter(value => ['image', 'file', 'pdf', 'audio', 'video', 'bookmark', 'embed'].includes(value.type))
          .map(value => ({ block_id: value.id, type: value.type, body_available: false })) };
      if (JSON.stringify(row).length > 200000) fail('记录正文或字段过长，未使用截断资料填充。');
      rows.push(row);
    }
    const snapshot = { info: structuredClone(info), collection, workflow, fields, instructions, rows };
    if (JSON.stringify(snapshot).length > 4000000) fail('本批记录资料过长，请减少所选记录。');
    for (const row of rows) row.sourceHash = sourceHash(snapshot, row);
    return snapshot;
  }
  async resolveInfo(info, signal) {
    if (info.spaceId !== this.spaceId) fail('请求不属于当前登录工作区。');
    return info.type === 'viewFill' ? resolveViewInfo(this, info, signal) : info;
  }
  plan(snapshot, row, output) {
    if (!snapshot.rows.some(value => value.pageId === row.pageId) || !object(output) ||
        Object.keys(output).length !== snapshot.fields.length || snapshot.fields.some(field => !Object.hasOwn(output, field.id))) fail('模型结果字段不完整或包含未选择字段。');
    const properties = {};
    for (const field of snapshot.fields) {
      const value = output[field.id];
      if (value === null) { properties[field.id] = []; continue; }
      if (field.type === 'date') { properties[field.id] = dateProperty(value); continue; }
      if (field.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) fail('数字字段必须返回有限 JSON 数字，未写入。');
        properties[field.id] = [[String(value)]]; continue;
      }
      if (field.type === 'checkbox') {
        if (typeof value !== 'boolean') fail('复选框字段必须返回 JSON true 或 false，未写入。');
        properties[field.id] = [[value ? 'Yes' : 'No']]; continue;
      }
      if (field.type === 'multi_select') {
        if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || !field.options?.includes(item)) || new Set(value).size !== value.length) fail('模型结果含不存在或重复的分类选项。');
        properties[field.id] = value.length ? [[value.join(',')]] : []; continue;
      }
      if (typeof value !== 'string' || value.length > 16000) fail('模型字段结果类型无效或过长。');
      if (['select', 'status'].includes(field.type) && !field.options?.includes(value)) fail('模型结果含不存在的分类选项。');
      if (field.type === 'url' && value && !/^https?:\/\/[^\s]+$/i.test(value)) fail('模型 URL 字段结果格式无效。');
      properties[field.id] = value ? [[value]] : [];
    }
    return { id: randomUUID(), transactionId: randomUUID(), spaceId: this.spaceId, userId: this.userId,
      rowId: row.pageId, propertyIds: [...snapshot.info.propertyIds], info: { ...snapshot.info, rowIds: [row.pageId] },
      sourceHash: row.sourceHash, before: Object.fromEntries(snapshot.info.propertyIds.map(id => [id, row.properties[id] || []])), properties,
      afterHash: sourceHash(snapshot, row, { ...row.properties, ...properties }) };
  }
  async submit(snapshot, plan, signal, onSubmit = () => {}) {
    signal?.throwIfAborted();
    if (plan.spaceId !== this.spaceId || plan.userId !== this.userId || snapshot.info.collectionId !== plan.info.collectionId) fail('字段写回范围已变化。');
    const fresh = await this.load(plan.info, signal);
    if (fresh.rows[0].sourceHash !== plan.sourceHash) fail('记录、字段结构或指令在生成期间发生变化，未提交旧结果。');
    const pointer = { table: 'block', id: plan.rowId, spaceId: this.spaceId };
    const operations = [
      { pointer, command: 'update', path: ['properties'], args: plan.properties },
      { pointer, command: 'update', path: ['format', 'agent_workflow_status'], args: Object.fromEntries(plan.propertyIds.map(id => [id, null])) },
      { pointer, command: 'update', path: [], args: { last_edited_time: Date.now(), last_edited_by_table: 'notion_user', last_edited_by_id: this.userId } }
    ];
    const payload = { requestId: plan.id, transactions: [{ id: plan.transactionId, spaceId: this.spaceId, operations }] };
    if (Buffer.byteLength(JSON.stringify(payload)) > 400000) fail('字段结果过长，未提交。');
    signal?.throwIfAborted(); onSubmit();
    await this.native.api('saveTransactionsFanout', payload, { signal, spaceId: this.spaceId });
  }
  async verify(plan, signal) {
    const values = await this.read('block', [plan.rowId], signal), row = values.get(plan.rowId);
    const equal = expected => plan.propertyIds.every(id => hash(row.properties?.[id] || []) === hash(expected[id] || []));
    const cleared = plan.propertyIds.every(id => row.format?.agent_workflow_status?.[id] == null);
    return { ok: equal(plan.properties) && cleared, unchanged: equal(plan.before), recordMap: { __version__: 3,
      block: { [plan.rowId]: { spaceId: this.spaceId, value: { role: this.roles.get('block:' + plan.rowId), value: row } } } } };
  }
  async clearPending(snapshot, rowId, signal) {
    const original = snapshot.rows.find(row => row.pageId === rowId)?.records.find(value => value.id === rowId);
    if (!original) fail('任务状态不属于本次所选记录。');
    const row = (await this.read('block', [rowId], signal, true)).get(rowId);
    if (row.parent_table !== 'collection' || uuid(row.parent_id) !== snapshot.info.collectionId) return false;
    const fields = snapshot.info.propertyIds.filter(id => original.format?.agent_workflow_status?.[id]?.type === 'creatingTask' &&
      JSON.stringify(original.format.agent_workflow_status[id]) === JSON.stringify(row.format?.agent_workflow_status?.[id]));
    if (!fields.length) return true;
    await this.native.api('saveTransactionsFanout', { requestId: randomUUID(), transactions: [{ id: randomUUID(), spaceId: this.spaceId,
      operations: [{ pointer: { table: 'block', id: rowId, spaceId: this.spaceId }, command: 'update',
        path: ['format', 'agent_workflow_status'], args: Object.fromEntries(fields.map(id => [id, null])) }] }] }, { signal, spaceId: this.spaceId });
    const after = (await this.read('block', [rowId], signal)).get(rowId);
    return fields.every(id => after.format?.agent_workflow_status?.[id] == null);
  }
}
module.exports = { autofillInput, NativeAutofillStore, sourceHash };
