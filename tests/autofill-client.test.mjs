import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { adaptAutofill, pollNativeAutofill, invokeLiteAutofill, captureViewSnapshot, assetName } = createRequire(import.meta.url)('../src/compat/autofill.cjs');
const jobId = 'addf11ed-aaaa-4aaa-8aaa-aaaaaaaaaaaa', spaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const marker = { version: 1, jobId, initial: { value: { groupId: jobId, totalBlocks: 1, workflowAutomationRunIds: ['synthetic-run'] } } };
const counts = status => ({ success: status === 'success' ? 1 : 0, in_progress: status === 'in_progress' ? 1 : 0, failure: 0, paused: 0, cancelled: 0, skipped: 0 });
function fixture() {
  const calls = [], updates = []; let handled = 0;
  const environment = { currentUser: { id: 'synthetic-user' }, api: { async callCellCompatibleApi(request) {
    calls.push(request.eventName);
    if (request.eventName.startsWith('trigger')) return { type: 'success', data: { notionSwitchAutofill: marker }, handleRecordMapForResponsePromise: Promise.resolve().then(() => { handled++; }) };
    const status = calls.filter(name => name === 'notionSwitchGetAutofillStatus').length > 1 ? 'success' : 'in_progress';
    return { type: 'success', data: { version: status === 'success' ? 2 : 1, status, counts: counts(status), value: { totalBlocks: 1 } }, handleRecordMapForResponsePromise: Promise.resolve().then(() => { handled++; }) };
  } } };
  const requireNative = id => {
    if (id === 418819) return { S: { updateStatus: (id, value) => updates.push({ id, value }) } };
    if (id === 436555) return { D6: () => assert.fail('Unexpected task timeout') };
    assert.fail('Must not use original task output subscriptions: ' + id);
  };
  return { environment, requireNative, calls, updates, handled: () => handled };
}
test('Autofill progress uses the native scoped API, applies record maps, then updates existing counters', async () => {
  const f = fixture(); assert.equal(await pollNativeAutofill(f.environment, f.requireNative, marker, spaceId, 1), true);
  assert.deepEqual(f.calls, ['notionSwitchGetAutofillStatus', 'notionSwitchGetAutofillStatus']);
  assert.equal(f.handled(), 2); assert.equal(f.updates.at(-1).value.success, 1);
});
test('the local queue wrapper preserves ordinary server responses and starts progress only for local jobs', async () => {
  const f = fixture(); let polls = 0;
  await invokeLiteAutofill(f.environment, f.requireNative, async (...args) => { polls++; assert.equal(args[3], spaceId); }, { eventName: 'triggerLiteAgentAutofill', data: { spaceId } });
  assert.equal(polls, 1); assert.equal(f.handled(), 1);
  f.environment.api.callCellCompatibleApi = async () => ({ type: 'success', data: { groupId: 'ordinary-server-group' } });
  await invokeLiteAutofill(f.environment, f.requireNative, async () => { polls++; }, { eventName: 'triggerLiteAgentAutofill', data: { spaceId } });
  assert.equal(polls, 1);
  assert.equal(await pollNativeAutofill(f.environment, f.requireNative, { version: 1, jobId: 'ordinary' }, spaceId, 1), false);
});
test('Autofill compatibility rejects changed code instead of partially patching a new protocol', () => {
  assert.throws(() => adaptAutofill('"use strict";changed();', assetName), /Unreviewed/);
});
const sample = new URL('../research/.public-assets/' + assetName, import.meta.url);

test('view capture freezes the originating context and fails closed when the effective query is unavailable', () => {
  const query = { loader: { filter: { transient: true } } }, view = { id: 'synthetic-view', getType: () => 'table',
    getVersion: () => 1, getRawQuery: () => ({}), getFormat: () => ({}) };
  const snapshot = captureViewSnapshot({ collectionViewStore: () => view, remoteRequestStore: { state: query } });
  query.loader.filter.transient = false; assert.equal(snapshot.request.loader.filter.transient, true);
  assert.equal(captureViewSnapshot({ collectionViewStore: () => view }), null);
  assert.equal(captureViewSnapshot({ collectionViewStore: () => { throw Error('unavailable'); } }), null);
});
test('reviewed native Autofill producer enqueues locally and receives progress without original task subscriptions', { skip: !fs.existsSync(sample) && 'Reviewed public frontend sample is not installed' }, async () => {
  const source = fs.readFileSync(sample, 'utf8'), adapted = adaptAutofill(source, assetName);
  new vm.Script(adapted); assert.throws(() => adaptAutofill(source + '\n', assetName), /Unreviewed/);
  const begin = adapted.indexOf('async function b(e)'), end = adapted.indexOf('async function k(e)', begin), f = fixture(), notifications = [];
  const run = vm.runInNewContext('(' + adapted.slice(begin, end) + ')', { r: f.requireNative, setTimeout, clearTimeout, Date, Symbol, Map });
  const result = await run({ environment: f.environment, spaceId, request: { type: 'blockFill' }, onStatus: value => notifications.push(value) });
  assert.equal(result.success, true); assert.equal(notifications[0].groupId, jobId);
  const symbol = Symbol.for('notion-switch-autofill-pollers-v1');
  // The producer has returned queued run IDs before its asynchronous poll.
  assert.equal(f.updates.length, 0);
  for (let n = 0; n < 20 && f.updates.at(-1)?.value.success !== 1; n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.updates.at(-1).value.success, 1); assert.equal(f.calls[0], 'triggerAgentOverCollection');
  void symbol;
});
