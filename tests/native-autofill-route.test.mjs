import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { autofillFixture } from './helpers/native-autofill.mjs';
import { autofillViewFixture } from './helpers/native-autofill-view.mjs';
const require = createRequire(import.meta.url), { NativeAutofillJobs, isLocalId } = require('../src/native-autofill-jobs.cjs');
const { localRecords } = require('../src/local-records.cjs'), { adaptResponse } = require('../src/compat/response.cjs');
const { assetName } = require('../src/compat/autofill.cjs');
const publicSample = new URL('../research/.public-assets/' + assetName, import.meta.url);
function fixture(t, makeFixture = autofillFixture) {
  const f = makeFixture(), parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-autofill-route-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek' }), async* generate() { yield '{"summary":"青色927","category":"研发","tags":["青色"]}'; } };
  const autofill = new NativeAutofillJobs({ root, provider, storeFactory: () => f.createStore() }); t.after(() => autofill.close());
  const source = fs.readFileSync(new URL('../src/desktop-hook.cjs', import.meta.url), 'utf8');
  const routeSource = source.slice(source.indexOf('async function route('), source.indexOf('\nfunction install(ses)'));
  const forwarded = [], context = { Request, Response, Headers, URL, autofill, provider, isLocalAutofillId: isLocalId, localRecords,
    settings: { speech: { enabled: false }, isLoginSyncing: () => false }, nativeSpeech: { enabled: false, lifecycleReady: true },
    meetingBridge: { observe() {} }, recordings: { wake() {} }, log: () => {}, compatibility: { unsupportedAssets: [], adaptedAssets: [], automaticAssets: [] },
    localUploadPrefix: '/notion-switch-local-upload/', isNotion: host => host === 'app.notion.com',
    endpoints: new Set(['runInferenceTranscript']), aiRecords: { record: (id, table, scope) => autofill.record(id, table, scope) },
    json: (value, status = 200) => new Response(JSON.stringify(value), { status }), adaptResponse,
    mock: { handle: () => assert.fail('No chat fallback for Autofill') }
  };
  const route = vm.runInNewContext(routeSource + '\nroute', context);
  const call = (endpoint, data, headers = {}) => route(new Request('https://app.notion.com/api/v3/' + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-notion-active-user-header': f.ids.user, ...headers }, body: JSON.stringify(data)
  }), async request => {
    const endpoint = new URL(request.url).pathname.split('/').at(-1); forwarded.push(endpoint);
    if (endpoint !== 'getRecordValues') assert.fail('No hosted AI request may escape: ' + endpoint);
    return new Response(JSON.stringify(await f.native.api(endpoint, await request.json(), { spaceId: f.ids.space })));
  });
  return { ...f, root, provider, autofill, forwarded, call, context, route };
}

test('unadapted Autofill requests fail locally and never reach hosted generation', async t => {
  const f = fixture(t), response = await f.call('triggerLiteAgentAutofill', f.input);
  assert.equal(response.status, 501); assert.match((await response.json()).message, /适配/);
  assert.equal(f.forwarded.length, 0); assert.equal(f.writes().length, 0); assert.equal(f.autofill.active, 0);
});

test('mock mode rejects Autofill locally without leaking view scope to a hosted AI endpoint', async t => {
  const f = fixture(t, autofillViewFixture); f.provider.status = () => ({ mode: 'mock' });
  const response = await f.call('triggerLiteAgentAutofill', f.input, { 'x-notion-switch-autofill-client': '1' });
  assert.equal(response.status, 400); assert.match((await response.json()).message, /DeepSeek/);
  assert.equal(f.forwarded.length, 0); assert.equal(f.calls.length, 0);
});

test('both original viewFill UI branches capture their own effective query and complete through the actual route', { skip: !fs.existsSync(publicSample) && 'Reviewed public frontend sample is not installed' }, async t => {
  for (const fair of [true, false]) {
    const f = fixture(t, autofillViewFixture), source = await (await adaptResponse(new Response(fs.readFileSync(publicSample, 'utf8')), assetName)).response.text();
    const updates = [], queued = [], apiRequests = [], environment = { currentUser: { id: f.ids.user }, api: { async callCellCompatibleApi(options) {
      apiRequests.push(structuredClone(options.data));
      const response = await f.call(options.eventName, options.data, options.headers || {}), data = await response.json();
      return { type: response.ok ? 'success' : 'failed', data, handleRecordMapForResponsePromise: Promise.resolve() };
    } } };
    const context = vm.createContext({ setTimeout, clearTimeout, Date, Symbol, Map,
      // No visible rows have loaded yet. The complete scoped query still has two.
      p: () => [], I: () => [], u: () => true, n: () => ({ C0E: 'workflow' }),
      r: id => {
        if (id === 218744) return { default: { checkGate: () => fair } };
        if (id === 418819) return { S: { initializeStatus: (id, count) => queued.push({ id, count }), updateStatus: (id, counts) => updates.push({ id, counts }) } };
        if (id === 599231) return { YH() {} };
        if (id === 436555) return { D6: value => assert.fail('Unexpected native toast: ' + value.label) };
        assert.fail('Unexpected native dependency: ' + id);
      }
    });
    const begin = source.indexOf('async function b(e)'), end = source.indexOf('async function k(e)', begin);
    vm.runInContext(source.slice(begin, end), context);
    const at = source.indexOf('async function S(e)'), until = source.indexOf('function _(e)', at);
    const run = vm.runInContext('(' + source.slice(at, until) + ')', context);
    let began = 0, completed;
    const result = await run({ workflowStore: { id: f.ids.workflow }, currentCollectionStore: { id: f.ids.collection },
      collectionContextStore: { remoteRequestStore: { state: f.snapshot.request }, collectionViewStore: () => ({ id: f.viewId,
        getType: () => f.view.type, getVersion: () => f.view.version, getRawQuery: () => f.view.query2, getFormat: () => f.view.format }) },
      environment, intl: {}, spaceId: f.ids.space, properties: f.input.propertyIds, fillMode: 'all', entryPoint: 'database_agent_preview',
      onEnqueueStart: () => { began++; }, onEnqueueComplete: n => { completed = n; } });
    assert.equal(result.success, true); assert.equal(result.totalBlocks, 2); assert.equal(began, 1); assert.equal(completed, 2);
    assert.equal(queued[0].count, 2); assert.deepEqual(apiRequests[0].notionSwitchView, f.snapshot);
    const polls = vm.runInContext('globalThis[Symbol.for("notion-switch-autofill-pollers-v1")]', context);
    await Promise.all([...polls.values()]);
    assert.equal(updates.at(-1).counts.success, 2); assert.equal(f.writes().length, 2); assert.equal(f.forwarded.length, 0);
    assert.deepEqual(f.autofill.jobs.get(queued[0].id).info.rowIds, [f.ids.second, f.ids.first]);
    assert.ok(!f.calls.some(call => call.endpoint === 'getRecordValues' && call.payload.requests.some(pointer => pointer.id === f.ids.unselected)));
  }
});

test('real desktop route serves owned run records, preserves ordinary reads and enforces account scope', async t => {
  const f = fixture(t), response = await f.call('triggerLiteAgentAutofill', f.input, { 'x-notion-switch-autofill-client': '1' });
  const queued = await response.json(); assert.equal(response.status, 200); await f.autofill.wait(queued.groupId);
  const runId = queued.workflowAutomationRunIds[0];
  const reads = await (await f.call('getRecordValues', { requests: [{ table: 'workflow_automation_run', id: runId, spaceId: f.ids.space },
    { table: 'block', id: f.ids.first, spaceId: f.ids.space }] })).json();
  assert.equal(reads.results[0].value.status, 'success'); assert.match(reads.results[1].value.properties.summary[0][0], /927/);
  assert.deepEqual(f.forwarded, ['getRecordValues']);
  assert.equal((await f.call('notionSwitchGetAutofillStatus', { jobId: queued.groupId, spaceId: f.ids.space }, { 'x-notion-active-user-header': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).status, 404);
});

test('an unsupported Autofill frontend does not disable existing recording readiness', async t => {
  const f = fixture(t); f.context.adaptResponse = async () => { throw Object.assign(Error('Changed Autofill code'), { notionSwitchKind: 'autofill' }); };
  const response = await f.route(new Request('https://app.notion.com/_assets/' + assetName), async () => new Response('original-public-code'));
  assert.equal(await response.text(), 'original-public-code'); assert.equal(f.context.nativeSpeech.lifecycleReady, true);
});

test('reviewed native UI → actual route → scoped fill → native progress and record maps completes without hosted AI', { skip: !fs.existsSync(publicSample) && 'Reviewed public frontend sample is not installed' }, async t => {
  const f = fixture(t); let release, began;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; });
  f.provider.generate = async function* () { began(); await gate; yield '{"summary":"青色927","category":"研发","tags":["青色"]}'; };
  let audioPreparation = 0;
  const result = await adaptResponse(new Response(fs.readFileSync(publicSample, 'utf8')), assetName, { prepare: () => { audioPreparation++; } });
  assert.deepEqual(result.kinds, ['autofill']); assert.equal(result.automatic.length, 0); assert.equal(audioPreparation, 0);
  const source = await result.response.text(), begin = source.indexOf('async function b(e)'), end = source.indexOf('async function k(e)', begin);
  const updates = [], records = new Map(), environment = { currentUser: { id: f.ids.user }, api: { async callCellCompatibleApi(options) {
    const response = await f.call(options.eventName, options.data, options.headers || {}), data = await response.json();
    if (!response.ok) return { type: 'failed', error: data };
    return { type: 'success', data, handleRecordMapForResponsePromise: Promise.resolve().then(() => {
      for (const [table, entries] of Object.entries(data.recordMap || {})) if (table !== '__version__')
        for (const [id, entry] of Object.entries(entries)) records.set(table + ':' + id, entry.value.value);
    }) };
  } } };
  const context = vm.createContext({ setTimeout, clearTimeout, Date, Symbol, Map, r: id => {
    if (id === 418819) return { S: { updateStatus: (id, counts) => updates.push({ id, counts }) } };
    if (id === 436555) return { D6: () => assert.fail('Unexpected progress timeout') };
    assert.fail('Original task output subscriptions must not be used for a local job: ' + id);
  } });
  const run = vm.runInContext('(' + source.slice(begin, end) + ')', context), initial = [];
  const queued = await run({ environment, spaceId: f.ids.space, request: f.input, onStatus: value => initial.push(value) });
  assert.equal(queued.success, true); assert.equal(initial[0].totalBlocks, 2); await started;
  assert.equal(f.get('block', f.ids.first).properties.summary[0][0], '旧摘要', 'Queued does not mean written');
  release();
  const polls = vm.runInContext('globalThis[Symbol.for("notion-switch-autofill-pollers-v1")]', context);
  await Promise.race([Promise.all([...polls.values()]), new Promise((_, reject) => setTimeout(() => reject(Error('Native progress did not finish')), 3000))]);
  assert.equal(updates.at(-1).counts.success, 2); assert.equal(records.get('workflow_automation_run:' + initial[0].workflowAutomationRunIds[0]).status, 'success');
  assert.equal(records.get('block:' + f.ids.first).properties.summary[0][0], '青色927');
  assert.equal(f.forwarded.length, 0); assert.equal(f.writes().length, 2);
});
