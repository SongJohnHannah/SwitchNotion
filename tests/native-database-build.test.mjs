import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { databaseBuildInput, databaseBuildDraft, buildIds, buildId } from './helpers/native-database-build.mjs';
const { isDatabaseBuild, buildMessages, parseBuildOutput, prepareBuildPreview } = createRequire(import.meta.url)('../src/native-database-build.cjs');

test('the native onboarding database entry is recognized independently of writer, formula and other workflow types', () => {
  const input = databaseBuildInput(); assert.equal(isDatabaseBuild(input), true);
  for (const type of ['formulas', 'writer', 'researcher']) {
    const other = databaseBuildInput(); other.transcript[0].value.type = type; assert.equal(isDatabaseBuild(other), false);
  }
  input.transcript[0].value.onboardingAgentVersion = 'work_with_core_dbs'; assert.equal(isDatabaseBuild(input), false);
});

test('build planning sends the selected task and routing context without private profile or debug data', () => {
  const messages = buildMessages(databaseBuildInput());
  assert.match(messages.at(-1).content, /先给预览/); assert.match(messages[0].content, /确认/);
  assert.ok(!JSON.stringify(messages).includes('must-not-forward'));
  assert.match(JSON.stringify(messages), new RegExp(buildIds.parent));
});

test('unknown attachment/source steps and invalid workflow requests fail instead of losing build context', () => {
  const unknown = databaseBuildInput(); unknown.transcript.push({ type: 'computer-file', value: 'unread' });
  assert.throws(() => buildMessages(unknown), /来源|附件/);
  const invalid = databaseBuildInput(); invalid.spaceId = 'invalid'; assert.throws(() => buildMessages(invalid), /工作区|标识/);
  const large = databaseBuildInput(); large.transcript[2].value = [['x'.repeat(32001)]]; assert.throws(() => buildMessages(large), /过长/);
});

test('database model drafts support text, existing option lists, status groups and clarification without arbitrary record IDs', () => {
  const draft = databaseBuildDraft(); assert.deepEqual(parseBuildOutput(JSON.stringify(draft)), draft);
  assert.deepEqual(parseBuildOutput('```json\n{"type":"chat","message":"希望在哪个页面下创建？"}\n```'), { type: 'chat', message: '希望在哪个页面下创建？' });
  for (const change of [d => { d.databaseId = buildId(90); }, d => { d.columns.push({ name: '名称', type: 'text' }); },
    d => { d.columns[2].options = ['高', '高']; }, d => { d.columns[3].groups[2].options = ['处理中']; },
    d => { d.columns.push({ name: '__proto__', type: 'text' }); }, d => { d.columns.push({ name: '未知', type: 'future_field' }); }]) {
    const bad = databaseBuildDraft(); change(bad); assert.throws(() => parseBuildOutput(JSON.stringify(bad)));
  }
});

test('empty category lists and an empty status group remain empty instead of inventing unwanted choices', () => {
  const draft = databaseBuildDraft(); draft.columns[2].options = []; draft.columns[3].groups[1].options = [];
  const result = parseBuildOutput(JSON.stringify(draft)); assert.deepEqual(result.columns[2].options, []); assert.deepEqual(result.columns[3].groups[1].options, []);
  const plan = prepareBuildPreview(result, { spaceId: buildIds.space, userId: buildIds.user,
    parentPointer: { table: 'block', id: buildIds.parent, spaceId: buildIds.space } });
  const schema = plan.step.threadOperations.find(item => item.operation.pointer.table === 'collection').operation.args.schema;
  assert.deepEqual(Object.values(schema).find(field => field.type === 'status').groups[1].optionIds, []);
});

test('a native build preview is a new empty database graph and only inserts its own block under the selected parent', () => {
  const plan = prepareBuildPreview(databaseBuildDraft(), { spaceId: buildIds.space, userId: buildIds.user,
    parentPointer: { table: 'block', id: buildIds.parent, spaceId: buildIds.space } });
  assert.equal(plan.step.type, 'agent-tool-result'); assert.equal(plan.step.toolType, 'create-database');
  assert.equal(plan.step.state, 'confirmation:requested'); assert.equal(plan.step.done, false);
  const operations = plan.step.threadOperations.map(item => item.operation), ownIds = new Set([plan.databaseId, plan.collectionId, plan.viewId]);
  assert.ok(operations.every(operation => operation.pointer.spaceId === buildIds.space));
  const parent = operations.filter(operation => operation.pointer.id === buildIds.parent);
  assert.equal(parent.length, 1); assert.equal(parent[0].command, 'listAfter'); assert.deepEqual(parent[0].path, ['content']);
  assert.equal(parent[0].args.id, plan.databaseId);
  assert.ok(operations.filter(operation => operation.pointer.id !== buildIds.parent).every(operation => ownIds.has(operation.pointer.id)));
  assert.equal(operations.filter(operation => operation.command === 'set').length, 3);
  const collection = operations.find(operation => operation.pointer.table === 'collection').args;
  assert.equal(Object.values(collection.schema).filter(field => field.type === 'title').length, 1);
  const status = Object.values(collection.schema).find(field => field.type === 'status');
  assert.equal(status.groups.length, 3); assert.deepEqual(status.options.map(option => option.value), ['未开始', '处理中', '阻塞', '完成']);
  assert.equal(plan.step.result.collectionViewBlockId, plan.databaseId);
  assert.ok(!operations.some(operation => operation.pointer.table === 'workflow' || operation.pointer.table === 'automation'));
});

test('build preview identity, parent scope and transaction size are validated before a native operation is produced', () => {
  for (const options of [{ spaceId: 'invalid', userId: buildIds.user, parentPointer: { table: 'block', id: buildIds.parent, spaceId: buildIds.space } },
    { spaceId: buildIds.space, userId: buildIds.user, parentPointer: { table: 'block', id: buildIds.parent, spaceId: buildId(90) } },
    { spaceId: buildIds.space, userId: buildIds.user, parentPointer: { table: 'collection', id: buildIds.parent, spaceId: buildIds.space } }]) {
    assert.throws(() => prepareBuildPreview(databaseBuildDraft(), options));
  }
});

const sample = new URL('../research/.public-assets/42968-3f44bc15b3fbb9a7.js', import.meta.url);
test('the reviewed native preview operation consumer reconstructs the full new database graph without a remote commit', { skip: !fs.existsSync(sample) && 'Reviewed public frontend sample is not installed' }, () => {
  const plan = prepareBuildPreview(databaseBuildDraft(), { spaceId: buildIds.space, userId: buildIds.user,
    parentPointer: { table: 'block', id: buildIds.parent, spaceId: buildIds.space } });
  const records = new Map([['block:' + buildIds.parent, { id: buildIds.parent, content: ['existing-child'] }]]), source = fs.readFileSync(sample, 'utf8');
  const begin = source.indexOf('function eG(e)'), end = source.indexOf('async function ej(', begin);
  assert.ok(begin >= 0 && end > begin);
  const apply = (_environment, operation) => {
    const key = operation.pointer.table + ':' + operation.pointer.id;
    if (operation.command === 'set') records.set(key, structuredClone(operation.args));
    else if (operation.command === 'update') Object.assign(records.get(key), structuredClone(operation.args));
    else if (operation.command === 'listAfter') records.get(key).content.push(operation.args.id);
    else assert.fail('Unexpected preview operation: ' + operation.command);
  };
  const modules = id => {
    if (id === 166029) return { ph: () => false };
    if (id === 918300) return { Wv: args => { const value = { id: args.id, type: args.type, properties: args.properties, format: args.format, permissions: args.permissions };
      const store = { pointer: { table: 'block', id: args.id, spaceId: args.spaceId } }; records.set('block:' + args.id, value); return store; } };
    if (id === 857796) return { I: ({ environment, operation }) => apply(environment, operation) };
    if (id === 517013) return { pm: class { constructor(options) { Object.assign(this, options); } } };
    if (id === 48697) return { HB: () => assert.fail('Unexpected preview type') };
    assert.fail('Unexpected native dependency: ' + id);
  };
  const run = vm.runInNewContext('(' + source.slice(begin, end) + ')', { r: modules,
    s: () => ({ y: ({ operation }) => apply({}, operation) }),
    m: () => ({ op: { shallowMerge: value => ({ ...value, command: 'update' }) }, $Y: () => true, mP: () => false }) });
  for (const { operation } of plan.step.threadOperations) run({ environment: { defaultRecordCache: { inMemoryRecordCache: {} } }, operation, transaction: {}, recordCache: {} });
  assert.equal(records.get('block:' + plan.databaseId).collection_id, plan.collectionId);
  assert.deepEqual(records.get('block:' + plan.databaseId).view_ids, [plan.viewId]);
  assert.equal(records.get('collection:' + plan.collectionId).parent_id, plan.databaseId);
  assert.equal(records.get('collection_view:' + plan.viewId).format.collection_pointer.id, plan.collectionId);
  assert.deepEqual(records.get('block:' + buildIds.parent).content, ['existing-child', plan.databaseId]);
});
