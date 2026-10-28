import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { autofillFixture, autofillId } from './helpers/native-autofill.mjs';
const { autofillInput } = createRequire(import.meta.url)('../src/native-autofill-store.cjs');
const info = f => autofillInput(f.input);

test('Autofill reads only selected rows, owned fields and their content through scoped native records', async () => {
  const f = autofillFixture(), snapshot = await f.createStore().load(info(f));
  assert.equal(snapshot.rows.length, 2); assert.match(snapshot.rows[0].text, /第一条青色927研发资料的正文/);
  assert.deepEqual(snapshot.fields.map(field => field.id), ['summary', 'category', 'tags']);
  assert.equal(snapshot.instructions, '从资料提取摘要、分类和标签。');
  assert.ok(!JSON.stringify(f.calls).includes(f.ids.unselected)); assert.equal(f.writes().length, 0);
});

test('Autofill rejects inaccessible rows, unrelated collections and unowned fields before writing', async () => {
  for (const change of [f => f.setRole('reader'), f => { f.get('block', f.ids.second).parent_id = autofillId(90); },
    f => { f.get('workflow', f.ids.workflow).data.modules[0].state.ownedByDatabasePropertyIds = ['summary']; },
    f => { f.get('workflow', f.ids.workflow).space_id = autofillId(90); }]) {
    const f = autofillFixture(); change(f); await assert.rejects(f.createStore().load(info(f))); assert.equal(f.writes().length, 0);
  }
});

test('Autofill validates all output fields and select options before planning a write', async () => {
  const f = autofillFixture(), store = f.createStore(), snapshot = await store.load(info(f));
  for (const output of [{ summary: '摘要', category: '发明的新选项', tags: ['青色'] },
    { summary: '摘要', category: '研发' }, { summary: '摘要', category: '研发', tags: ['青色'], title: '偷偷改标题' }]) {
    assert.throws(() => store.plan(snapshot, snapshot.rows[0], output), /字段|选项|结果/);
  }
  assert.equal(f.writes().length, 0);
});

test('Autofill writes only target properties, clears their task state and reads back exact stored results', async () => {
  const f = autofillFixture(), store = f.createStore(), snapshot = await store.load(info(f));
  const before = structuredClone(f.get('block', f.ids.first)), plan = store.plan(snapshot, snapshot.rows[0], {
    summary: '青色927', category: '研发', tags: ['青色', '927']
  });
  let submitted = 0; await store.submit(snapshot, plan, undefined, () => { submitted++; });
  const result = await store.verify(plan);
  assert.equal(submitted, 1); assert.equal(result.ok, true); assert.equal(result.recordMap.block[f.ids.first].value.value.properties.summary[0][0], '青色927');
  assert.equal(result.recordMap.block[f.ids.first].value.role, 'editor', 'Successful fills must not turn editable rows read-only in the UI');
  const after = f.get('block', f.ids.first);
  assert.deepEqual(after.properties.title, before.properties.title); assert.deepEqual(after.content, before.content);
  assert.deepEqual(after.format.agent_workflow_status.untouched, before.format.agent_workflow_status.untouched);
  assert.equal(after.format.agent_workflow_status.summary, null);
  assert.ok(f.writes().every(call => call.payload.transactions.every(tx => tx.operations.every(op => op.pointer.id === f.ids.first))));
  assert.equal(f.get('block', f.ids.second).properties.summary[0][0], '旧摘要');
});

test('Autofill refuses a stale source, changed schema or changed instruction before submitting a transaction', async () => {
  for (const change of [f => { f.get('block', f.ids.body1).properties.title = [['已经修改']]; },
    f => { f.get('collection', f.ids.collection).schema.summary.name = '改名'; },
    f => { f.get('workflow', f.ids.workflow).data.instructions = [['改成另一条指令']]; }]) {
    const f = autofillFixture(), store = f.createStore(), snapshot = await store.load(info(f));
    const plan = store.plan(snapshot, snapshot.rows[0], { summary: '青色927', category: '研发', tags: [] });
    change(f); await assert.rejects(store.submit(snapshot, plan), /变化|修改/); assert.equal(f.writes().length, 0);
  }
});

test('Autofill preserves request scope, cancellation and rejects unsupported full-view inputs explicitly', async () => {
  const f = autofillFixture();
  for (const input of [{ ...f.input, blockIds: [{ table: 'block', id: f.ids.first, spaceId: autofillId(99) }] },
    { ...f.input, propertyIds: [] }, { ...f.input, type: 'viewFill', blockIds: undefined, viewId: autofillId(99) }]) assert.throws(() => autofillInput(input));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.createStore().load(info(f), controller.signal), /abort/i);
  assert.equal(f.calls.length, 0);
});
