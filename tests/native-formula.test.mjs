import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { NativeMock } from '../src/native-mock.cjs';
import { formulaInput, formulaId as id, formulaIds } from './helpers/native-formula.mjs';
const { space: SPACE, collection: COLLECTION } = formulaIds;
function fixture() {
  const requests = [], logs = [];
  const input = formulaInput();
  const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek' }), async* generate(args) {
    requests.push(args); yield '{"type":"formula","formula":"prop(\\"单价\\") * prop(\\"数量\\") + 927"}';
  } };
  const native = new NativeMock({ provider, workspace: { open: () => assert.fail('Formula preview must not open write tools') }, log: value => logs.push(value) });
  return { input, provider, native, requests, logs };
}
async function result(f, signal) {
  const response = await f.native.handle('runInferenceTranscript', f.input, signal);
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);
  const frame = events.findLast(frame => frame.type === 'generate-formula');
  return { frame, value: frame && JSON.parse(frame.value), events };
}

test('native formula editor receives its exact generate-formula JSON protocol and only schema context', async () => {
  const f = fixture(), before = structuredClone(f.input), { frame, value } = await result(f);
  assert.equal(value.type, 'formula'); assert.match(value.formula, /927/);
  assert.equal(frame.traceId, f.input.traceId);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].tools, undefined);
  const prompt = JSON.stringify(f.requests[0].messages);
  assert.match(prompt, /单价/); assert.match(prompt, /数量/); assert.match(prompt, /将合计增加/);
  assert.ok(!prompt.includes('must-not-forward')); assert.deepEqual(f.input, before);
  assert.ok(!JSON.stringify(f.logs).includes('将合计增加'));
  assert.equal(f.native.status().activeTurns, 0); assert.equal(f.native.status().completedTurns, 1);
});

test('formula editor forwards existing formula and compiler errors as data for a repair request', async () => {
  const f = fixture(); f.input.transcript[0].value.formulaErrors = ['合计字段不能引用自身'];
  f.input.transcript[0].value.existingFormula = 'prop("合计") + 927';
  await result(f);
  const prompt = JSON.stringify(f.requests[0].messages);
  assert.match(prompt, /合计字段不能引用自身/); assert.match(prompt, /existing_formula/);
});

test('formula editor supports native record wrappers, related schemas and fragmented JSON output', async () => {
  const f = fixture(), map = f.input.transcript[1].threadRecordMap.recordMap.collection;
  map[COLLECTION] = { spaceId: SPACE, value: map[COLLECTION] };
  map[COLLECTION].value.value.schema.state = { name: '状态', type: 'select', options: [{ value: '完成', id: id(12), metadata: 'must-not-forward' }] };
  map[id(13)] = { role: 'reader', value: { id: id(13), space_id: SPACE, name: [['相关资料']], schema: { title: { name: '名称', type: 'title' } } } };
  const requests = f.requests;
  f.provider.generate = async function* (args) { requests.push(args); yield '```json\n{"type":"formula",'; yield '"formula":"1 + 2","format":"bar"}\n```'; };
  const { value } = await result(f); assert.deepEqual(value, { type: 'formula', formula: '1 + 2', format: 'bar' });
  const prompt = JSON.stringify(f.requests[0].messages); assert.match(prompt, /相关资料/); assert.match(prompt, /完成/); assert.ok(!prompt.includes('must-not-forward'));
});

test('invalid or incomplete formula contexts show a native chat message before invoking the model', async () => {
  for (const change of [
    f => { delete f.input.transcript[1].threadRecordMap.recordMap.collection[COLLECTION]; },
    f => { f.input.transcript[1].threadRecordMap.recordMap.collection[COLLECTION].value.space_id = id(99); },
    f => { f.input.transcript.splice(2, 0, { id: id(10), type: 'attachment', fileUrl: 'https://example.test/private.pdf' }); },
    f => { f.input.transcript[0].value.existingFormula = 'x'.repeat(40000); }
  ]) {
    const f = fixture(); change(f); const { value } = await result(f);
    assert.equal(value.type, 'chat'); assert.match(value.message, /Notion 公式/);
    assert.equal(f.requests.length, 0);
  }
});

test('model refusals display in the formula assistant and invalid output is never sent as a formula', async () => {
  for (const output of ['{"type":"chat","message":"请说明需要计算的字段。"}',
    '{"type":"formula","formula":"1 + 2","saveTransactionsFanout":{}}', '这里是答案：1 + 2', '{"type":"formula","formula":""}']) {
    const f = fixture(); f.provider.generate = async function* () { yield output; };
    const { value } = await result(f); assert.equal(value.type, 'chat'); assert.ok(value.message);
  }
});

test('a provider failure becomes a native formula assistant message without leaking internal errors', async () => {
  const f = fixture(); f.provider.generate = async function* () { throw Error('private-provider-debug-value'); };
  const { value } = await result(f); assert.equal(value.type, 'chat'); assert.ok(!value.message.includes('private-provider'));
});

test('stopping formula generation aborts the model and emits no formula to apply', async () => {
  const f = fixture(), controller = new AbortController(); let start, received;
  const began = new Promise(resolve => { start = resolve; });
  f.provider.generate = async function* ({ signal }) {
    received = signal; start(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted();
  };
  const response = await f.native.handle('runInferenceTranscript', f.input, controller.signal);
  await Promise.race([began, new Promise((_, reject) => setTimeout(() => reject(Error('Formula model was not invoked')), 500))]);
  assert.equal(f.native.status().activeTurns, 1, 'Runtime updates must see the active formula task');
  controller.abort(); assert.equal(received.aborted, true); assert.equal(await response.text(), '');
  assert.equal(f.native.status().activeTurns, 0); assert.equal(f.native.status().stoppedTurns, 1);
});

test('the actual desktop request route sends a formula request to the local adapter without upstream inference', async () => {
  const f = fixture(), forwarded = [], source = fs.readFileSync(new URL('../src/desktop-hook.cjs', import.meta.url), 'utf8');
  const routeSource = source.slice(source.indexOf('async function route('), source.indexOf('\nfunction install(ses)'));
  const route = vm.runInNewContext(routeSource + '\nroute', {
    Request, Response, Headers, URL, provider: f.provider, mock: f.native,
    settings: { speech: { enabled: false }, isLoginSyncing: () => false }, nativeSpeech: { enabled: false },
    meetingBridge: { observe() {} }, recordings: { wake() {} }, log: () => {},
    localUploadPrefix: '/notion-switch-local-upload/', isNotion: host => host === 'app.notion.com',
    createNativeImageAdapter: () => ({}), endpoints: new Set(['runInferenceTranscript']),
    json: (value, status = 200) => new Response(JSON.stringify(value), { status })
  });
  const response = await route(new Request('https://app.notion.com/api/v3/runInferenceTranscript', {
    method: 'POST', body: JSON.stringify(f.input), headers: { 'content-type': 'application/json' }
  }), async request => { forwarded.push(request.url); return new Response('{}'); });
  assert.equal(JSON.parse((await response.text()).trim()).type, 'generate-formula');
  assert.equal(f.requests.length, 1); assert.equal(forwarded.length, 0);
});
