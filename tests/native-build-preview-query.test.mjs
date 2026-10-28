import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { emptyPreviewReducers } = require('../src/native-database-build-views.cjs');
const { parse } = require('../src/compat/parser.cjs');
const schema = { title: { name: 'Name', type: 'title' }, status: { name: 'Status', type: 'status', defaultOption: 'Todo',
  options: [{ value: 'Todo' }, { value: 'Doing' }, { value: 'Done' }], groups: [{ name: 'To-do' }, { name: 'In progress' }, { name: 'Complete' }] },
  select: { name: 'Category', type: 'select', options: [{ value: 'B' }, { value: 'A' }] } };
const reducer = (type = 'status', groupBy = 'option') => ({ type: 'groups', limit: 100, groupBy: { property: type, type,
  ...(type === 'status' ? { groupBy } : {}), sort: { type: 'ascending' } }, groupSortPreference: [],
  aggregation: { type: 'independent', groupAggregation: { aggregator: 'count' } }, blockResults: { type: 'independent', defaultLimit: 50 } });
const run = value => emptyPreviewReducers({ groups: value }, schema, 'en').groups;

test('empty native previews return real empty row lists and zero counts for each schema-defined group', () => {
  const status = run(reducer()); assert.deepEqual(status.results.map(group => group.value.value.option), ['Todo', 'Doing', 'Done']);
  assert.equal(status.version, 'v2'); assert.equal(status.hasMore, false);
  assert.deepEqual(status.aggregationResults['status:by_option-Todo'], { aggregationResult: { type: 'number', value: 0 } });
  assert.deepEqual(status.blockResults['status:by_option-Todo'], { blockIds: [], hasMore: false });
  const select = run(reducer('select')); assert.deepEqual(select.results.map(group => group.value.value), [undefined, 'A', 'B']);
  const group = run(reducer('status', 'group')); assert.deepEqual(group.results.map(value => value.value.value.group), ['To-do', 'In progress', 'Complete']);
  const mixed = emptyPreviewReducers({ rows: { type: 'results' }, count: { type: 'aggregation', aggregation: { aggregator: 'count' } } }, schema);
  assert.deepEqual(mixed.rows, { type: 'results', blockIds: [], hasMore: false }); assert.equal(mixed.count.aggregationResult.value, 0);
});

test('empty group previews preserve explicit hidden, pinned, manual order and group limits without inventing records', () => {
  const value = reducer(); value.groupBy.sort.type = 'manual'; value.returnPinnedGroups = true; value.limit = 1;
  value.groupSortPreference = [{ property: 'status', value: { type: 'status', value: { type: 'by_option', option: 'Done' } }, pinned: true },
    { property: 'status', value: { type: 'status', value: { type: 'by_option', option: 'Doing' } }, hidden: true }];
  const result = run(value); assert.equal(result.hasMore, true); assert.equal(result.results[0].value.value.option, 'Done');
  assert.equal(result.pinnedResults.groupResults[0].value.value.option, 'Done'); assert.equal(result.pinnedResults.aggregationResults['status:by_option-Done'], 0);
  value.limit = 100; value.groupBy.hideEmptyGroups = true;
  assert.equal(run(value).results.length, 0); value.returnHiddenGroups = true;
  assert.equal(run(value).results.length, 3); assert.ok(run(value).results.every(group => group.visible === false));
});

test('unsupported statistics, nested queries and foreign group values fail before a preview result is produced', () => {
  for (const mutate of [value => { value.groupBy.property = 'foreign'; }, value => { value.groupBy.type = 'number'; },
    value => { value.limit = 0; }, value => { value.subGroup = {}; }, value => { value.aggregation.groupAggregation.aggregator = 'median'; },
    value => { value.blockResults.type = 'intersection'; }, value => { value.groupSortPreference = [{ property: 'status', value: { type: 'status', value: { type: 'by_option', option: 'Foreign' } } }]; }]) {
    const value = reducer(); mutate(value); assert.throws(() => run(value), /预览/);
  }
  assert.throws(() => emptyPreviewReducers({}, schema)); assert.throws(() => emptyPreviewReducers({ unknown: { type: 'future' } }, schema));
});

const sample = new URL('../research/.public-assets/66443-aec4a5ee6ea8e91c.js', import.meta.url);
test('empty group values match the reviewed native group seeder and the native row collector reads zero rows', { skip: !fs.existsSync(sample) && 'Reviewed public frontend sample is not installed' }, () => {
  const source = fs.readFileSync(sample, 'utf8'), modules = parse(source, { ecmaVersion: 'latest' }).body[1].expression.arguments[0].elements[1].properties;
  const groupModule = modules.find(module => module.key.value === 861044), seed = groupModule.value.body.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'W');
  const nativeSeed = vm.runInNewContext('(' + source.slice(seed.start, seed.end) + ')');
  for (const value of [reducer(), reducer('select'), reducer('status', 'group')]) {
    const expected = nativeSeed({ schema, groupBy: value.groupBy }); const actual = run(value).results.map(group => group.value);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      JSON.parse(JSON.stringify(expected)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }
  const collectorModule = modules.find(module => module.value.body.body.some(node => node.type === 'FunctionDeclaration' && source.slice(node.start, node.end).includes('reducerTypesToExclude')));
  const functions = collectorModule.value.body.body.filter(node => node.type === 'FunctionDeclaration');
  const collector = functions.find(node => source.slice(node.start, node.end).includes('reducerTypesToExclude'));
  const walk = functions.find(node => node.id.name === 'k'); assert.ok(collector && walk);
  const collect = vm.runInNewContext(source.slice(walk.start, walk.end) + ';' + source.slice(collector.start, collector.end) + ';' + collector.id.name,
    { o: id => { if (id === 48697) return { WP: Object.entries }; assert.fail('Unexpected native row collector import: ' + id); } });
  assert.deepEqual(Array.from(collect({ result: { type: 'reducer', reducerResults: { groups: run(reducer()) } } })), []);
});
