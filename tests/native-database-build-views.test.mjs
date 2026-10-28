import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { databaseBuildDraft, buildIds } from './helpers/native-database-build.mjs';
import { databaseBuildStoreFixture } from './helpers/native-database-build-store.mjs';
const { parseBuildOutput, prepareBuildPreview } = createRequire(import.meta.url)('../src/native-database-build.cjs');
const layouts = ['table', 'board', 'calendar', 'list', 'gallery', 'timeline'];
function draft() {
  const value = databaseBuildDraft(), status = value.columns.find(column => column.type === 'status').name, date = value.columns.find(column => column.type === 'date').name;
  value.views = layouts.map(type => ({ name: type, type, ...(type === 'board' ? { groupBy: status } : {}),
    ...(['calendar', 'timeline'].includes(type) ? { dateBy: date } : {}) }));
  return value;
}
const prepare = value => prepareBuildPreview(value, { spaceId: buildIds.space, userId: buildIds.user, parentPointer: { table: 'block', id: buildIds.parent, spaceId: buildIds.space } });
const views = plan => plan.step.threadOperations.map(item => item.operation).filter(op => op.pointer.table === 'collection_view' && op.command === 'set').map(op => op.args);

test('an AI build draft retains all six requested layouts and binds each view to program-generated field and record IDs', () => {
  const value = draft(); assert.deepEqual(parseBuildOutput(JSON.stringify(value)), value);
  const plan = prepare(value), result = views(plan);
  assert.deepEqual(result.map(view => view.type), layouts); assert.equal(new Set(plan.viewIds).size, layouts.length);
  assert.deepEqual(plan.step.result.viewIds, plan.viewIds); assert.deepEqual(plan.step.threadOperations[0].operation.args.view_ids, plan.viewIds);
  const schema = plan.step.threadOperations.find(item => item.operation.pointer.table === 'collection').operation.args.schema;
  const status = Object.keys(schema).find(id => schema[id].type === 'status'), date = Object.keys(schema).find(id => schema[id].type === 'date');
  assert.equal(result[1].format.board_columns_by.property, status); assert.equal(result[2].query2.calendar_by, date); assert.equal(result[5].query2.timeline_by, date);
  assert.equal(result[1].format.board_columns.length, schema[status].options.length);
  assert.ok(result.every(view => view.parent_id === plan.databaseId && view.format.collection_pointer.id === plan.collectionId));
});

test('unknown, duplicated, incorrectly typed and unbound layout fields are rejected before preview or model output is accepted', () => {
  for (const mutate of [d => { d.views = []; }, d => { d.views[1].groupBy = '不存在'; }, d => { d.views[1].groupBy = d.columns[0].name; },
    d => { d.views[2].dateBy = d.columns[0].name; }, d => { d.views[3].id = buildIds.parent; }, d => { d.views[3].type = 'chart'; },
    d => { d.views[3].name = d.views[0].name; }, d => { d.views[3].properties = ['不存在']; }, d => { d.views[0].sort = { property: '不存在', direction: 'ascending' }; },
    d => { d.views[0].dateBy = d.columns.at(-1).name; }]) {
    const value = draft(); mutate(value); assert.throws(() => parseBuildOutput(JSON.stringify(value)), /布局|视图|字段/);
  }
});

test('confirmed multi-layout writes verify every view and never accept a wrong layout, grouping or date binding', async () => {
  for (const mutate of [() => {}, (f, plan) => { f.records.get('collection_view:' + plan.viewIds[1]).format.board_columns_by.property = 'title'; },
    (f, plan) => { f.records.get('collection_view:' + plan.viewIds[2]).query2.calendar_by = 'title'; },
    (f, plan) => { f.records.get('collection_view:' + plan.viewIds[4]).type = 'table'; },
    (f, plan) => { f.records.get('collection_view:' + plan.viewIds[0]).query2.filter = { property: 'title', value: 'unexpected' }; },
    (f, plan) => { f.records.get('collection_view:' + plan.viewIds[0]).query2.sort = [{ property: 'title', direction: 'descending' }]; },
    (f, plan) => { f.records.get('block:' + plan.databaseId).view_ids.pop(); }]) {
    const f = databaseBuildStoreFixture(), plan = await f.store.prepare(draft(), f.parentPointer);
    assert.equal(f.writes().length, 0); await f.store.submit(plan, { confirmation: f.confirmation(plan) });
    assert.equal((await f.store.verify(plan)).ok, true); mutate(f, plan);
    if (mutate.length) assert.equal((await f.store.verify(plan)).ok, false);
    else { assert.equal((await f.store.submit(plan, { confirmation: f.confirmation(plan) })).reused, true); assert.equal(f.writes().length, 1); }
  }
});

test('view properties, sorting and timeline end dates preserve the requested field order and bindings', () => {
  const value = draft(), title = value.columns[0].name, date = value.columns.at(-1).name;
  value.views[0].properties = [date, title]; value.views[0].sort = { property: date, direction: 'descending' }; value.views[5].endDateBy = date;
  const plan = prepare(value), result = views(plan), schema = plan.step.threadOperations.find(item => item.operation.pointer.table === 'collection').operation.args.schema;
  const dateId = Object.keys(schema).find(id => schema[id].name === date);
  assert.deepEqual(result[0].format.table_properties.map(property => property.property), [dateId, 'title']);
  assert.deepEqual(result[0].query2.sort, [{ property: dateId, direction: 'descending' }]); assert.equal(result[5].query2.timeline_by_end, dateId);
});

const sample = new URL('../research/.public-assets/73900-a65537ccfd465a3a.js', import.meta.url);
test('table, board, list and gallery view formats agree with the reviewed native database-spec compiler', { skip: !fs.existsSync(sample) && 'Reviewed public frontend sample is not installed' }, () => {
  const source = fs.readFileSync(sample, 'utf8'), at = source.indexOf('buildViewPropertiesFormat(e,t,r){'), end = source.indexOf('buildCollectionTemplate(', at);
  assert.ok(at > 0 && end > at); const native = vm.runInNewContext('({' + source.slice(at, end) + '}).buildViewPropertiesFormat', { no: options => options });
  const value = draft(), plan = prepare(value), schema = plan.step.threadOperations.find(item => item.operation.pointer.table === 'collection').operation.args.schema;
  const ids = Object.keys(schema).filter(id => id !== 'title'), properties = ids.map(key => ({ key, ...schema[key] }));
  for (const view of views(plan).filter(view => ['table', 'board', 'list', 'gallery'].includes(view.type))) {
    const expected = native({ properties }, { type: view.type, groupByPropertyKey: ids.find(id => schema[id].type === 'status') }, ids);
    for (const [key, expectedValue] of Object.entries(expected)) assert.deepEqual(view.format[key], JSON.parse(JSON.stringify(expectedValue)));
  }
});
