import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import compatibility from '../src/client-compat.cjs';
import macClient from '../src/compat/macos-client.cjs';
import { parse } from '../src/compat/parser.cjs';
import { modulesIn } from '../src/compat/automatic.cjs';
import { inspect } from '../src/compat/semantic.cjs';
import { adaptResponse } from '../src/compat/response.cjs';

const manifest = JSON.parse(fs.readFileSync(new URL('../src/compat/macos-reviewed.json', import.meta.url)));
const baseline = JSON.parse(fs.readFileSync(new URL('../src/compat/reviewed.json', import.meta.url))).modules;
const options = { localSpeechEnabled: true, audioEndpoint: 'http://127.0.0.1:32123' };

test('Mac compatibility records extend existing recording and connection kinds', () => {
  assert.deepEqual(Object.keys(manifest.modules).sort(), ['241978', '331787']);
  for (const [id, record] of Object.entries(manifest.modules)) {
    assert.match(record.moduleHash, /^[a-f\d]{64}$/);
    assert.match(record.fingerprint, /^[a-f\d]{64}$/);
    assert.notEqual(record.fingerprint, baseline[id].fingerprint);
  }
});

for (const [id, record] of Object.entries(manifest.modules)) {
  test(`Mac ${baseline[id].kind} supports the reviewed release and repacked chunks`, async t => {
    const file = new URL('../research/.public-assets/' + record.asset, import.meta.url);
    if (!fs.existsSync(file)) return t.skip('Public Notion fixture not cached locally');
    const source = fs.readFileSync(file, 'utf8');
    const module = modulesIn(source).find(module => module.id === id);
    assert.equal(createHash('sha256').update(module.source).digest('hex'), record.moduleHash);
    const info = inspect(module.source);
    assert.equal(info.fingerprint, record.fingerprint);
    for (const [role, name] of [['start', 'startDictation'], ['recorder', 'getDictationAudioRecorder'], ['stop', 'stopDictation']]) {
      if (id === '331787') assert.equal(info.at(baseline[id].selectors[role]).key.name, name);
    }
    const result = await adaptResponse(new Response(source), record.asset, options);
    assert.deepEqual(result.kinds, [baseline[id].kind]);
    const patched = await result.response.text();
    new vm.Script(patched);
    assert.equal(compatibility.adaptClient(source, record.asset), source, 'Disabled local speech preserves the official module');
    if (id === '331787') {
      assert.equal(result.changed, true);
      assert.match(patched, /stopDictationAfterLocalFlush/);
      assert.match(patched, /includeSystemAudio:!0/);
      assert.match(compatibility.adaptClient(source, record.asset, { ...options, inputMode: 'microphone' }), /includeSystemAudio:!1/);
      assert.match(patched, /\.dk\)\(e\.stopSource\?\?e\.from\)/, 'Preserve the new stop-source telemetry');
      assert.match(patched, /this.deadlineAtMs=e.clock.now\(\)\+12e3/);
    } else {
      assert.equal(patched, source);
      assert.match(patched, /watchdog_ms:3e4/);
      assert.match(patched, /recordStopSource/);
    }
    // Force the semantic path with a different chunk ID, formatting and
    // module parameter name. No downloaded third-party code is executed.
    const renamed = module.source.replace(/^(\d+)\(([^,]+),/, '$1(_macModule,');
    assert.equal(inspect(renamed).fingerprint, record.fingerprint);
    const repacked = '"use strict";(globalThis.rspackChunknotion_next||=[]).push([[60002],{' + renamed + '}]);';
    const automatic = await adaptResponse(new Response(repacked), '60002-0123456789abcdef.js', options);
    assert.deepEqual(automatic.kinds, [baseline[id].kind]);
    assert.equal(automatic.automatic[0].moduleId, id);
    new vm.Script(await automatic.response.text());
    const before = id === '331787' ? 'this.deadlineAtMs=e.clock.now()+12e3' : 'watchdog_ms:3e4';
    assert.ok(source.includes(before));
    const changed = source.replace(before, before + '+1');
    const original = new Response(changed);
    await assert.rejects(adaptResponse(original, record.asset, options), /Unreviewed/);
    assert.equal(await original.text(), changed);
  });
}

const currentAssets = {
  connection: '17048-b38a7b8f431620b1.js', recording: '89269-451ea294ba9323c0.js',
  attachments: '51103-1249b090dd731220.js', autofill: '57590-3242f968a3670cd0.js'
};
const cached = name => new URL('../research/.public-assets/' + name, import.meta.url);
const fixtureMissing = name => !fs.existsSync(cached(name)) && 'Optional public macOS client fixture unavailable';
function functionSource(source, moduleId, name) {
  const ast = parse(source, { ecmaVersion: 2024 });
  const module = ast.body[1].expression.arguments[0].elements[1].properties.find(node => node.key.value === moduleId);
  const fn = module?.value.body.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
  assert.ok(fn, 'Native function must exist: ' + name);
  return source.slice(fn.start, fn.end);
}

test('current Mac assets enter the production response adapter and changed bytes remain rejected', { skip: Object.values(currentAssets).some(name => fixtureMissing(name)) && 'Optional public macOS client fixtures unavailable' }, async () => {
  for (const [kind, name] of Object.entries(currentAssets)) {
    const source = fs.readFileSync(cached(name), 'utf8');
    const result = await adaptResponse(new Response(source), name, { ...options, prepare: () => {
      assert.ok(!['attachments', 'autofill'].includes(kind), 'File and field adapters must not prepare recording');
    } });
    assert.deepEqual(result.kinds, [kind]); new vm.Script(await result.response.text());
    assert.throws(() => macClient.adaptMacClient(source + '\n', name, options), /Unreviewed/);
    if (kind === 'recording') assert.equal(macClient.adaptMacClient(source, name), source);
    if (kind === 'connection') assert.equal(result.changed, false, 'Native watchdog and connection behavior stay intact');
  }
});

test('the Mac dispatch does not enable these new assets on the unchanged Windows compatibility path', { skip: Object.values(currentAssets).some(name => fixtureMissing(name)) && 'Optional public macOS client fixtures unavailable' }, () => {
  const require = createRequire(new URL('../src/client-compat.cjs', import.meta.url));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../src/client-compat.cjs', import.meta.url), 'utf8'), { require, module, process: { platform: 'win32' } });
  for (const name of Object.values(currentAssets)) {
    const source = fs.readFileSync(cached(name), 'utf8');
    assert.throws(() => module.exports.adaptClient(source, name, options), /Unreviewed/);
  }
});

test('the current Mac stop wrapper releases capture then sends the final audio through the renamed native transport twice', { skip: fixtureMissing(currentAssets.recording) }, async () => {
  const source = macClient.adaptMacClient(fs.readFileSync(cached(currentAssets.recording), 'utf8'), currentAssets.recording, options);
  const info = inspect(modulesIn(source).find(module => module.id === '331787').source);
  const method = info.nodes.find(node => node.type === 'MethodDefinition' && node.static && node.key.name === 'stopDictation');
  const module = modulesIn(source).find(module => module.id === '331787').source;
  const entry = module.slice(method.start - 2, method.end - 2), events = [], state = { state: {}, setState(value) { this.state = value; } };
  let release;
  const requireNative = id => {
    if (id === 697264) return { H1: () => 'current-owner', Tg: async owner => { assert.equal(owner, 'current-owner'); events.push('drained'); } };
    if (id === 216735) return { $g: async value => { assert.equal(value.blockId, 'synthetic-block'); events.push('sent:' + value.base64Audio); } };
    if (id === 392719) return { Rk: async value => String(value[0].length), c9: () => events.push('capture-stopped') };
    assert.fail('Stop must not import the obsolete transport: ' + id);
  };
  const actions = vm.runInNewContext('(class {' + entry + '})', { i: requireNative, S: () => ({ Ay: state }), setTimeout, clearTimeout, Float32Array });
  Object.assign(actions, {
    sessionOwnership: { getCurrentGeneration: () => 1, isCurrentGeneration: () => true },
    audioEncoderQueue: { afterFlush: () => new Promise(resolve => { release = resolve; }), enqueue: run => run() },
    resetAudioBuffers() { this.audioBuffer = []; this.sourceAudioBuffers = {}; },
    stopDictationAfterLocalFlush() { events.push('native-stop'); return { revisionDrain: Promise.resolve(), startBarrier: Promise.resolve() }; }
  });
  for (let round = 0; round < 2; round++) {
    events.length = 0; state.state = { rootBlock: { id: 'synthetic-block', pointer: { spaceId: 'synthetic-space' } }, audioRecorder: { stop: () => events.push('capture-released') }, enabled: true };
    actions.audioBuffer = [0.1, 0.2]; actions.sourceAudioBuffers = { microphone: [0.3] };
    const stopped = actions.stopDictation({ environment: {} });
    assert.deepEqual(events, ['capture-released', 'capture-stopped']); assert.equal(state.state.enabled, false);
    release(); await stopped.revisionDrain; await stopped.startBarrier;
    assert.deepEqual(events, ['capture-released', 'capture-stopped', 'sent:2', 'sent:1', 'drained', 'native-stop']);
    assert.equal(actions.localAudioStop, undefined);
  }
  assert.match(source, /finishOpenMossSourceCapture/); assert.match(source, /this.deadlineAtMs=e.clock.now\(\)\+12e3/);
});

test('the current Mac attachment consumer uses its renamed converter for local documents and retains ordinary task subscriptions', { skip: fixtureMissing(currentAssets.attachments) }, async () => {
  const source = macClient.adaptMacClient(fs.readFileSync(cached(currentAssets.attachments), 'utf8'), currentAssets.attachments);
  let subscriptions = 0, received;
  const origin = 'https://app.notion.com', url = origin + '/notion-switch-inline-document/synthetic-file';
  const value = { contentType: 'application/pdf', fileSizeBytes: 927, numPages: 1 };
  const nativeRequire = id => {
    if (id === 296328) return { tX: args => ({ fileName: args.fileName, numPages: args.result.numPages }) };
    if (id === 80279) return { Q: { success: data => ({ success: true, data }), fail: data => ({ success: false, data }) } };
    if (id === 655696) return { cK: async () => { subscriptions++; return { value: { result: { type: 'success', data: value } } }; }, W$: () => true };
    if (id === 324497) return { A: error => ({ message: error.message }) };
    assert.fail('Unexpected attachment dependency: ' + id);
  };
  const run = vm.runInNewContext('(' + functionSource(source, 175529, 'c') + ')', { a: nativeRequire, l: {}, n: 'user_upload', URL, location: { origin } });
  const environment = { api: { async callCellCompatibleApi(request) {
    received = request;
    return { type: 'success', data: request.data.url === url ? { notionSwitchDocument: { version: 1, result: value } } : { outputKey: 'ordinary-task' } };
  } } };
  const args = { environment, taskArgs: { url }, fileName: '合成文档.pdf', originalFileUrl: url, threadPointer: { id: 'synthetic-thread' } };
  const local = await run(args); assert.equal(local.success, true); assert.equal(local.data.numPages, 1);
  assert.equal(received.headers['x-notion-switch-inline-documents-client'], '1'); assert.equal(subscriptions, 0);
  assert.equal((await run({ ...args, taskArgs: { url: 'https://file.notion.so/image.png' } })).success, true);
  assert.equal(received.headers, undefined); assert.equal(subscriptions, 1);
});

test('both current Mac Autofill view branches preserve the originating query and progress without pending writes or hosted tasks', { skip: fixtureMissing(currentAssets.autofill) }, async () => {
  const source = macClient.adaptMacClient(fs.readFileSync(cached(currentAssets.autofill), 'utf8'), currentAssets.autofill);
  for (const lite of [false, true]) {
    const calls = [], updates = [], initialized = [], completed = [], notifications = [], jobId = 'addf11ed-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const marker = { version: 1, jobId, initial: { value: { groupId: jobId, totalBlocks: 1, workflowAutomationRunIds: ['synthetic-run'] } } };
    const environment = { currentUser: { id: 'synthetic-user' }, api: { async callCellCompatibleApi(request) {
      calls.push(request);
      return { type: 'success', handleRecordMapForResponsePromise: Promise.resolve(), data: request.eventName === 'notionSwitchGetAutofillStatus'
        ? { version: 1, status: 'success', value: { totalBlocks: 1 }, counts: { success: 1, in_progress: 0, failure: 0, paused: 0, cancelled: 0, skipped: 0 } }
        : { ...marker.initial.value, notionSwitchAutofill: marker } };
    } } };
    const r = id => {
      if (id === 218744) return { default: { checkGate: () => lite } };
      if (id === 418819) return { S: { initializeStatus: (...args) => initialized.push(args), updateStatus: (...args) => updates.push(args) } };
      if (id === 599231) return { YH() {} };
      if (id === 436555) return { D6: value => notifications.push(value) };
      assert.fail('No hosted task or pending-cell writes: ' + id);
    };
    const run = vm.runInNewContext('const b=' + functionSource(source, 414741, 'b') + ';(' + functionSource(source, 414741, 'P') + ')', {
      r, n: () => ({ C0E: 'workflow' }), p: () => [], u: () => true, I: () => [], setTimeout, clearTimeout,
      E: () => assert.fail('No pending-cell mutations before the verified view scope')
    });
    const view = { id: 'synthetic-view', getRawQuery: () => ({ filter: { synthetic: true } }), getFormat: () => ({}), getVersion: () => 1, getType: () => 'table' };
    const args = { workflowStore: { id: 'synthetic-workflow' }, currentCollectionStore: { id: 'synthetic-collection' },
      collectionContextStore: { collectionViewStore: () => view, remoteRequestStore: { state: { loader: { filter: { synthetic: true } } } } },
      environment, spaceId: 'synthetic-space', properties: ['synthetic-field'], onEnqueueStart() {}, onEnqueueComplete: count => completed.push(count), fillMode: 'all' };
    assert.equal((await run(args)).success, true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls[0].headers['x-notion-switch-autofill-client'], '1');
    assert.equal(calls[0].data.notionSwitchView.request.loader.filter.synthetic, true);
    assert.equal(calls[0].data.notionSwitchView.view.id, view.id);
    assert.equal(updates.at(-1)[1].success, 1); assert.equal(initialized.length, 1); assert.deepEqual(completed, [1]);
    const before = calls.length;
    assert.equal((await run({ ...args, collectionContextStore: { collectionViewStore: () => view } })).success, false);
    assert.equal(calls.length, before); assert.equal(notifications.length, 1);
  }
});
