import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { parse } from '../src/compat/parser.cjs';
import { adaptMacSpeech, speechModules } from '../src/compat/macos-speech.cjs';
import { adaptResponse } from '../src/compat/response.cjs';
import { verifiedClient, requestSpeechToken } from '../src/speech/client-state.cjs';
import { NativeSpeech } from '../src/speech/native.cjs';
import { uuid } from '../src/native-context.cjs';

const manifest = JSON.parse(fs.readFileSync(new URL('../src/compat/macos-speech-reviewed.json', import.meta.url)));
const options = { localSpeechEnabled: true, audioEndpoint: 'http://127.0.0.1:32123' };
const assets = { audio: '17521-131dcaeec5afd619.js', connection: '17048-5703c16bce2711ca.js', recording: '89269-dd1c58e7a46febaf.js' };
const cached = name => new URL('../research/.public-assets/' + name, import.meta.url);
const skip = Object.values(assets).some(name => !fs.existsSync(cached(name))) && 'Optional public Mac meeting fixtures unavailable';
const client = inputMode => ({ version: 1, inputMode, ...Object.fromEntries(Object.values(manifest.modules).map(record => [record.kind, record.hash])) });

test('page-local readiness accepts only reviewed roles and the current input mode', () => {
  const stamp = client('meeting');
  assert.equal(verifiedClient(JSON.stringify(stamp), 'meeting'), true);
  assert.equal(verifiedClient(JSON.stringify(stamp), 'microphone'), false);
  for (const role of ['audio', 'connection', 'recording']) {
    assert.equal(verifiedClient(JSON.stringify({ ...stamp, [role]: 'unreviewed' }), 'meeting'), false);
    const missing = { ...stamp }; delete missing[role]; assert.equal(verifiedClient(JSON.stringify(missing), 'meeting'), false);
  }
  for (const value of ['', null, 'null', '{}', '[]', 'x'.repeat(513), JSON.stringify({ ...stamp, extra: true })]) assert.equal(verifiedClient(value, 'meeting'), false);
});

test('independent meeting pages do not borrow readiness and a not-ready page never requests a token', async () => {
  let requests = 0, header;
  const environment = { api: { async callApi(request) { requests++; header = request.headers['x-notion-switch-speech-client']; return { type: 'success', data: { accessToken: 'synthetic-ticket' } }; } } };
  const page = state => vm.runInNewContext('(' + requestSpeechToken.toString() + ')', { ...(state ? { __notionSwitchSpeechClient: state } : {}), JSON, Error });
  const ready = page(client('meeting')), unready = page();
  await assert.rejects(unready(environment, {}), /录音组件尚未加载完整/);
  assert.equal(requests, 0);
  assert.equal((await ready(environment, { headers: { existing: 'retained' } })).type, 'success');
  assert.equal(verifiedClient(header, 'meeting'), true); assert.equal(requests, 1);
  await assert.rejects(unready(environment, {}), /录音组件尚未加载完整/); assert.equal(requests, 1);
});

test('a verified page can start after an unrelated window rejects a script, while changed sources and legacy clients stay blocked', async t => {
  const events = [], provider = { runtime: {}, probe: async () => {} };
  const service = new NativeSpeech({ speech: { enabled: true, inputMode: 'meeting', provider }, log: event => events.push(event) });
  t.after(() => service.close());
  assert.equal(service.lifecycleReady, false);
  const token = await service.token({ client: JSON.stringify(client('meeting')) });
  assert.equal(typeof token.accessToken, 'string');
  await assert.rejects(service.token(), /录音组件未就绪/);
  await assert.rejects(service.token({ client: '{}' }), /录音组件未就绪/);
  service.speech.inputMode = 'microphone';
  await assert.rejects(service.token({ client: JSON.stringify(client('meeting')) }), /录音来源已改变/);
  assert.equal(typeof (await service.token({ client: JSON.stringify(client('microphone')) })).accessToken, 'string');
  assert.ok(!JSON.stringify(events).includes(token.accessToken));
});

test('the production token route retains the page proof after an unrelated script failure', async t => {
  const service = new NativeSpeech({ speech: { enabled: true, inputMode: 'meeting', provider: { runtime: {}, probe: async () => {} } } });
  t.after(() => service.close());
  service.transportReady = service.lifecycleReady = service.drainTransportReady = true;
  const source = fs.readFileSync(new URL('../src/desktop-hook.cjs', import.meta.url), 'utf8');
  const context = { Request, Response, Headers, URL, uuid, nativeSpeech: service, settings: { speech: { enabled: true } },
    meetingBridge: { observe() {} }, recordings: { wake() {} }, log() {}, isNotion: host => host === 'app.notion.com',
    localUploadPrefix: '/notion-switch-local-upload/', compatibility: { unsupportedAssets: [] },
    json: (value, status = 200) => Response.json(value, { status }), adaptResponse: async () => { throw Error('unrelated changed module'); } };
  const route = vm.runInNewContext(source.slice(source.indexOf('async function route('), source.indexOf('\nfunction install(ses)')) + '\nroute', context);
  await route(new Request('https://app.notion.com/_assets/90002-0123456789abcdef.js'), async () => new Response('ordinary original source'));
  assert.equal(service.lifecycleReady, false);
  const call = headers => route(new Request('https://app.notion.com/api/v3/getAudioProcessorAuthToken', { method: 'POST', headers }), () => assert.fail('A local recording token must not go upstream'));
  const accepted = await call({ 'x-notion-switch-speech-client': JSON.stringify(client('meeting')) });
  assert.equal(accepted.status, 200); assert.equal(typeof (await accepted.json()).accessToken, 'string');
  assert.equal((await call({ 'x-notion-switch-speech-client': '{}' })).status, 503);
  assert.equal((await call({})).status, 503);
});

for (const [kind, name] of Object.entries(assets)) test(`current Mac ${kind} adapts through the real response route`, { skip }, async () => {
  const source = fs.readFileSync(cached(name), 'utf8');
  const result = await adaptResponse(new Response(source), name, options);
  assert.deepEqual(result.kinds, [kind]); assert.equal(result.changed, true);
  const patched = await result.response.text(); new vm.Script(patched);
  assert.match(patched, new RegExp('__notionSwitchSpeechClient\\?\\?=\\{\\}\\)\\.' + kind));
  assert.equal(adaptMacSpeech(source, name), source);
  if (kind === 'audio') assert.match(patched, /let l="http:\/\/127\.0\.0\.1:32123"/);
  if (kind === 'connection') { assert.match(patched, /x-notion-switch-speech-client/); assert.match(patched, /watchdog_ms:3e4/); assert.match(patched, /meetingCallDetectionExperimentGroup/); }
  if (kind === 'recording') {
    assert.match(patched, /transport:i\(697264\)/); assert.match(patched, /stopDictationAfterLocalFlush/);
    assert.match(patched, /includeSystemAudio:!0/); assert.match(patched, /this.deadlineAtMs=e.clock.now\(\)\+12e3/);
    assert.match(patched, /new\(i\(998296\)\)\.AudioRecorder/);
    assert.match(adaptMacSpeech(source, name, { ...options, inputMode: 'microphone' }), /includeSystemAudio:!1/);
  }
});

test('reviewed module bodies survive renamed chunks and unrelated neighbor updates; changed recording or encoder bodies fail closed', { skip }, async () => {
  const modules = Object.values(assets).flatMap(name => speechModules(fs.readFileSync(cached(name), 'utf8')));
  const chunk = extra => '"use strict";(globalThis.rspackChunknotion_next||=[]).push([[90001],{' + [...modules.map(m => m.source), '90002(e,t,n){t.value=' + JSON.stringify(extra) + '}'].join(',') + '}]);';
  const name = '90001-0123456789abcdef.js';
  for (const neighbor of ['old neighbor', 'updated neighbor']) {
    const source = chunk(neighbor), result = await adaptResponse(new Response(source), name, options);
    assert.deepEqual(result.kinds.sort(), ['audio', 'connection', 'recording']);
    const output = await result.response.text(); new vm.Script(output); assert.ok(output.includes(JSON.stringify(neighbor)));
    const ast = parse(output, { ecmaVersion: 2024 }), context = {};
    for (const module of ast.body[1].expression.arguments[0].elements[1].properties) {
      const statements = module.value.body.body;
      for (const statement of statements) if (output.slice(statement.start, statement.end).includes('__notionSwitchSpeechClient') && statement.type === 'ExpressionStatement') {
        vm.runInNewContext(output.slice(statement.start, statement.end), context);
      }
    }
    assert.equal(verifiedClient(JSON.stringify({ version: 1, ...context.__notionSwitchSpeechClient }), 'meeting'), true);
  }
  for (const module of modules) {
    const original = chunk('neighbor');
    const modified = original.replace(module.source, () => module.source.replace('{', '{;'));
    assert.throws(() => adaptMacSpeech(modified, name, options), /Changed Mac speech module/);
    assert.equal(createHash('sha256').update(module.source).digest('hex'), manifest.modules[module.id]?.hash || manifest.encoder.hash);
  }
  assert.throws(() => adaptMacSpeech(chunk('neighbor'), name, { ...options, audioEndpoint: 'https://example.com' }), /local audio endpoint/);
});

test('the current native stop wrapper releases capture and drains all tail samples on consecutive recordings', { skip }, async () => {
  const source = adaptMacSpeech(fs.readFileSync(cached(assets.recording), 'utf8'), assets.recording, options);
  const ast = parse(source, { ecmaVersion: 2024 }), module = ast.body[1].expression.arguments[0].elements[1].properties.find(node => node.key.value === 372201);
  const native = source.slice(module.start, module.end), alias = /\b([A-Za-z_$][\w$]*)=\(\)=>i\(585823\)/.exec(native)[1];
  const recorder = module.value.body.body.find(node => node.type === 'ClassDeclaration' && node.body.body.some(method => method.key?.name === 'stopDictation'));
  const method = recorder.body.body.find(node => node.key?.name === 'stopDictation');
  const state = { state: {}, setState(value) { this.state = value; } }, events = [];
  const load = id => {
    if (id === 697264) return { H1: () => 'owner', Tg: async owner => { assert.equal(owner, 'owner'); events.push('drained'); } };
    if (id === 216735) return { $g: async value => events.push('audio:' + value.base64Audio) };
    if (id === 392719) return { Rk: async pieces => String(pieces[0].length), c9: () => events.push('capture-flag-cleared') };
    assert.fail('Unexpected native stop import: ' + id);
  };
  const actions = vm.runInNewContext('(class {' + source.slice(method.start, method.end) + '})', { i: load, [alias]: () => ({ Ay: state }), setTimeout, clearTimeout, Float32Array });
  let release;
  Object.assign(actions, { sessionOwnership: { getCurrentGeneration: () => 1, isCurrentGeneration: () => true },
    audioEncoderQueue: { afterFlush: () => new Promise(resolve => { release = resolve; }), enqueue: run => run() },
    resetAudioBuffers() { this.audioBuffer = []; this.sourceAudioBuffers = {}; },
    stopDictationAfterLocalFlush(input) { assert.equal(input.error, undefined); events.push('native-stop'); return { revisionDrain: Promise.resolve(), startBarrier: Promise.resolve() }; } });
  for (let round = 0; round < 3; round++) {
    events.length = 0; state.state = { rootBlock: { id: 'meeting', pointer: { spaceId: 'workspace' } }, enabled: true, audioRecorder: { stop: () => events.push('released') } };
    actions.audioBuffer = [0.1, 0.2]; actions.sourceAudioBuffers = { microphone: [0.3], system_audio: [0.4] };
    const stopped = actions.stopDictation({ environment: {} });
    assert.deepEqual(events, ['released', 'capture-flag-cleared']); assert.equal(state.state.enabled, false);
    release(); await stopped.revisionDrain; await stopped.startBarrier;
    assert.deepEqual(events, ['released', 'capture-flag-cleared', 'audio:2', 'audio:1', 'audio:1', 'drained', 'native-stop']);
    assert.equal(actions.localAudioStop, undefined);
  }
});
