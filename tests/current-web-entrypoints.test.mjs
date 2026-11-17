import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parse } = require('../src/compat/parser.cjs');
const { adaptClient } = require('../src/client-compat.cjs');
const assets = {
  availability: '95271-3b930ea252348c71.js',
  autofill: '57590-1ff6559994fff905.js',
  attachments: '51103-2e3dc6cde9c9f009.js'
};
const sample = kind => new URL('../research/.public-assets/' + assets[kind], import.meta.url);
const fixtureOptions = kind => fs.existsSync(sample(kind)) ? {} : { skip: 'Official public client fixture is not distributed.' };
function reviewedModule(kind, id) {
  const source = adaptClient(fs.readFileSync(sample(kind), 'utf8'), assets[kind]);
  const ast = parse(source, { ecmaVersion: 2024 });
  const property = ast.body[1].expression.arguments[0].elements[1].properties.find(item => String(item.key.value) === id);
  assert.ok(property);
  return { source, node: property.value };
}
function entrypoint(module, name, context) {
  const fn = module.node.body.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
  assert.ok(fn); return vm.runInNewContext('(' + module.source.slice(fn.start, fn.end) + ')', context);
}

test('current AI availability preserves workspace restrictions and ordinary feature decisions', fixtureOptions('availability'), () => {
  const module = reviewedModule('availability', '811656'), exports = {};
  const nativeRequire = id => {
    if (id === 48697) return { Xk: (restrictions, type) => restrictions.includes(type), HB: () => assert.fail('Unexpected feature type') };
    if (id === 900989) return { N8: () => false };
    if (id === 337174) return { hj: value => value };
    return {};
  };
  nativeRequire.d = (target, getters) => { for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get }); };
  const factory = vm.runInNewContext('(function' + module.source.slice(module.node.start, module.node.end) + ')', { Math: { random: () => 1 } });
  factory({}, exports, nativeRequire);
  const definitions = { ai_usage: { type: 'per_use', workspaceRestrictions: ['policy'] }, ordinary: { type: 'check' } };
  let nativeCalls = 0;
  const decisions = { ai_usage: () => { nativeCalls++; return { type: 'unavailable' }; }, ordinary: () => { nativeCalls++; return { type: 'unavailable', upsell: { type: 'none' } }; } };
  const context = { name: 'ai_usage', scope: { id: 'fixture-space', billingData: {}, premiumFeatureOverrides: {}, workspaceRestrictions: [] }, data: {}, environment: { logFunction() {}, trackFunction() {} } };
  assert.equal(exports.jx(definitions, decisions, context).limit.amount, 'unlimited'); assert.equal(nativeCalls, 0);
  context.scope.workspaceRestrictions = [{ type: 'policy' }];
  assert.equal(exports.jx(definitions, decisions, context).type, 'unavailable'); assert.equal(nativeCalls, 0);
  context.scope.workspaceRestrictions = []; context.name = 'ordinary';
  assert.equal(exports.jx(definitions, decisions, context).type, 'unavailable'); assert.equal(nativeCalls, 1);
});

test('current Autofill uses local progress and preserves named subscriptions for ordinary responses', fixtureOptions('autofill'), async () => {
  const module = reviewedModule('autofill', '414741'), updates = [], calls = [];
  const jobId = 'addf11ed-1111-4111-8111-111111111111'; let local = true, subscriptions = 0;
  const environment = { currentUser: { id: 'fixture-user' }, api: { async callCellCompatibleApi(request) {
    calls.push(request);
    if (request.eventName === 'notionSwitchGetAutofillStatus') return { type: 'success', handleRecordMapForResponsePromise: Promise.resolve(), data: { version: 1, status: 'success', counts: { success: 1, in_progress: 0, paused: 0, failure: 0, cancelled: 0, skipped: 0 }, value: { totalBlocks: 1 } } };
    return { type: 'success', handleRecordMapForResponsePromise: Promise.resolve(), data: local ? { notionSwitchAutofill: { version: 1, jobId, initial: { value: { totalBlocks: 1 } } } } : { outputKey: 'ordinary-task' } };
  } } };
  const nativeRequire = id => {
    if (id === 418819) return { S: { updateStatus: (_job, counts) => updates.push(counts) } };
    if (id === 655696) return { subscribeToTaskOutput: async () => { subscriptions++; return { status: 'success', value: { success: true } }; }, isTaskOutputSettled: () => true };
    assert.fail('Unexpected native dependency: ' + id);
  };
  const run = entrypoint(module, 'b', { r: nativeRequire, s: {}, setTimeout, Date, Symbol, Map });
  const args = { environment, spaceId: 'fixture-space', request: { type: 'blockFill' }, onStatus() {} };
  assert.equal((await run(args)).success, true);
  for (let i = 0; i < 50 && !updates.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(updates[0]?.success, 1); assert.equal(subscriptions, 0);
  assert.equal(calls[0].headers['x-notion-switch-autofill-client'], '1');
  local = false; assert.equal((await run(args)).success, true); assert.equal(subscriptions, 1);
});

test('current attachment consumer reads local documents and preserves the ordinary named task interface', fixtureOptions('attachments'), async () => {
  const module = reviewedModule('attachments', '175529'), origin = 'https://app.notion.com';
  const url = origin + '/notion-switch-inline-document/00000000-0000-4000-8000-000000000000/' + 'a'.repeat(64);
  const metadata = { attachmentRisk: 'skipped', contentType: 'application/pdf', fileSizeBytes: 1000, numPages: 2, stepMetadata: { numPages: 2 } };
  let request, subscriptions = 0;
  const nativeRequire = id => {
    if (id === 296328) return { tX: args => ({ fileName: args.fileName, contentType: args.result.contentType }) };
    if (id === 80279) return { Q: { success: data => ({ success: true, data }), fail: error => ({ success: false, error }) } };
    if (id === 655696) return { subscribeToTaskOutput: async () => { subscriptions++; return { value: { result: { type: 'success', data: metadata } } }; }, isTaskOutputSettled: () => true };
    if (id === 324497) return { A: error => ({ message: error.message }) };
    assert.fail('Unexpected native dependency: ' + id);
  };
  const environment = { api: { async callCellCompatibleApi(input) {
    request = input; return { type: 'success', data: input.data.url === url ? { notionSwitchDocument: { version: 1, result: metadata } } : { outputKey: 'ordinary-task', spaceId: 'fixture-space' } };
  } } };
  const run = entrypoint(module, 'c', { a: nativeRequire, l: {}, n: 'user_upload', URL, location: { origin } });
  const args = { environment, taskArgs: { url }, fileName: 'fixture.pdf', originalFileUrl: url, threadPointer: { id: 'fixture-thread' } };
  const result = await run(args);
  assert.equal(result.success, true); assert.equal(result.data.contentType, 'application/pdf'); assert.equal(subscriptions, 0);
  assert.equal(request.headers['x-notion-switch-inline-documents-client'], '1');
  const ordinary = await run({ ...args, taskArgs: { url: 'https://file.notion.so/file.pdf' } });
  assert.equal(ordinary.success, true); assert.equal(subscriptions, 1); assert.equal(request.headers, undefined);
});
