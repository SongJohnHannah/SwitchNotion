import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const autofillId = n => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
export const autofillIds = Object.fromEntries(['space', 'user', 'collection', 'workflow', 'parent', 'first', 'second', 'unselected', 'body1', 'body2'].map((name, n) => [name, autofillId(n + 1)]));
export function autofillFixture() {
  const ids = autofillIds, calls = [], records = new Map();
  const put = (table, id, value) => records.set(table + ':' + id, { id, space_id: ids.space, alive: true, version: 1, ...value });
  put('collection', ids.collection, { parent_id: ids.parent, parent_table: 'block', name: [['合成资料库']], schema: {
    title: { type: 'title', name: '名称' }, summary: { type: 'text', name: '摘要', default_workflow_id: ids.workflow },
    category: { type: 'select', name: '分类', options: [{ id: 'a', value: '研发' }, { id: 'b', value: '市场' }] },
    tags: { type: 'multi_select', name: '标签', options: [{ value: '青色' }, { value: '927' }] }
  } });
  put('workflow', ids.workflow, { parent_id: ids.parent, parent_table: 'block', data: { isLite: true, instructions: [['从资料提取摘要、分类和标签。']],
    modules: [{ id: autofillId(20), type: 'notion', state: { ownedByDatabasePropertyIds: ['summary', 'category', 'tags'] } }] } });
  for (const [row, body, label] of [[ids.first, ids.body1, '第一条青色927研发资料'], [ids.second, ids.body2, '第二条市场资料']]) {
    put('block', row, { type: 'page', parent_table: 'collection', parent_id: ids.collection,
      properties: { title: [[label]], summary: [['旧摘要']], category: [['研发']] }, content: [body],
      format: { agent_workflow_status: { summary: { type: 'creatingTask', createdAtMs: 1 }, untouched: { type: 'creatingTask', createdAtMs: 2 } } } });
    put('block', body, { type: 'text', parent_table: 'block', parent_id: row, properties: { title: [[label + '的正文。']] } });
  }
  put('block', ids.unselected, { type: 'page', parent_table: 'collection', parent_id: ids.collection, properties: { title: [['must-not-read-unselected']] } });
  let role = 'editor', behavior = 'ok';
  const api = async (endpoint, payload, options) => {
    calls.push({ endpoint, payload: structuredClone(payload) });
    if (options.spaceId !== ids.space) throw Error('Wrong API workspace');
    if (endpoint === 'getRecordValues') return { results: payload.requests.map(p => {
      if (p.spaceId !== ids.space) throw Error('Missing pointer workspace');
      const value = records.get(p.table + ':' + p.id); return value ? { role, value: structuredClone(value) } : {};
    }) };
    if (endpoint !== 'saveTransactionsFanout') throw Error('Unexpected API: ' + endpoint);
    if (behavior === 'reject') throw Object.assign(Error('Validation rejected'), { notSubmitted: true });
    if (behavior === 'before-error') throw Error('Unknown transport failure');
    for (const tx of payload.transactions) for (const op of tx.operations) {
      const value = records.get(op.pointer.table + ':' + op.pointer.id);
      if (!value || op.pointer.spaceId !== ids.space || op.pointer.table !== 'block') throw Error('Write outside selected records');
      let target = value;
      for (const field of op.path) target = target[field] ||= {};
      if (op.command === 'update') Object.assign(target, structuredClone(op.args));
      else if (op.command === 'set') throw Error('Full-record overwrite is forbidden');
      else throw Error('Unexpected command: ' + op.command);
      value.version++;
    }
    if (behavior === 'after-error') throw Error('Lost response after commit');
    return { recordMap: {} };
  };
  const native = { api, spaceId: ids.space, userId: ids.user };
  const input = { spaceId: ids.space, type: 'blockFill', workflowPointer: { table: 'workflow', id: ids.workflow, spaceId: ids.space },
    collectionId: ids.collection, blockIds: [ids.first, ids.second].map(id => ({ table: 'block', id, spaceId: ids.space })),
    propertyIds: ['summary', 'category', 'tags'], entryPoint: 'database_agent_preview' };
  return { ids, records, calls, native, input, get: (table, id) => records.get(table + ':' + id),
    writes: () => calls.filter(call => call.endpoint === 'saveTransactionsFanout'), setRole: value => { role = value; }, setBehavior: value => { behavior = value; },
    createStore() { const { NativeAutofillStore } = require('../../src/native-autofill-store.cjs'); return new NativeAutofillStore({ native }); } };
}
