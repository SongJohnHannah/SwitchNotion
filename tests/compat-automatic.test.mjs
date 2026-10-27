import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { inspect, staticName } from '../src/compat/semantic.cjs';
import compatibility from '../src/client-compat.cjs';
import { adaptResponse } from '../src/compat/response.cjs';
const { adaptClient } = compatibility;

const entries = [
  ['811656', '95271-adc4a76136e50ec0.js'], ['459724', '96975-4c75c565bc617fbf.js'],
  ['60217', '32453-3994faac607efd3c.js'], ['328616', '17521-084ec2bc2599898c.js'],
  ['331787', '89269-f5f20fe25f8eec19.js'], ['241978', '17048-31dd3b95acbe5529.js']
];
function moduleOf(id, name) {
  const file = new URL('../research/.public-assets/' + name, import.meta.url);
  if (!fs.existsSync(file)) return null;
  const s = fs.readFileSync(file, 'utf8'), b = [...s.matchAll(/(?:^|[,{])(\d+)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{/g)];
  const i = b.findIndex(m => m[1] === id);
  return s.slice(b[i].index + 1, b[i + 1]?.index ?? s.lastIndexOf('}]);'));
}
function renameRequire(module) {
  const info = inspect(module), parameter = info.ast.body[0].expression.properties[0].value.params[2];
  const binding = info.bindings.get(parameter), edits = [], names = new Map([[binding, '_futureRequire']]);
  const id = String(info.ast.body[0].expression.properties[0].key.value);
  const record = JSON.parse(fs.readFileSync(new URL('../src/compat/reviewed.json', import.meta.url))).modules[id];
  const rename = node => { const key = info.bindings.get(node); if (key && !names.has(key)) names.set(key, '_future' + names.size); };
  if (record.kind === 'availability') for (const role of ['feature', 'context']) rename(info.at(record.selectors[role]));
  if (record.kind === 'recording') for (const role of ['start', 'recorder', 'stop']) rename(info.at(record.selectors[role]).value.params[0]);
  function visit(node, parent, key) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Identifier' && !staticName(parent, key) && names.has(info.bindings.get(node))) edits.push({ start: node.start - 2, end: node.end - 2, text: names.get(info.bindings.get(node)) });
    for (const [k, value] of Object.entries(node)) if (!['range', 'start', 'end'].includes(k) && value && typeof value === 'object') visit(value, node, k);
  }
  visit(info.ast, null, '');
  let renamed = module;
  for (const e of edits.sort((a, b) => b.start - a.start)) renamed = renamed.slice(0, e.start) + e.text + renamed.slice(e.end);
  renamed = renamed.replace(/^(\d+)\(([^)]+)\)/, (_, number, parameters) => number + ' ( ' + parameters.split(',').join(' , ') + ' )');
  const open = renamed.indexOf('{'); renamed = renamed.slice(0, open + 1) + '/* future minifier */\n' + renamed.slice(open + 1);
  assert.equal(inspect(renamed).fingerprint, info.fingerprint, 'Fixture must change only names and formatting');
  return renamed;
}
const chunk = modules => '"use strict";(globalThis.rspackChunknotion_next||=[]).push([[60001],{' + modules.join(',') + '}]);';
const future = '60001-0123456789abcdef.js';

test('all supported UI modules automatically adapt after import bindings and chunk filenames change', async t => {
  for (const [id, name] of entries) await t.test(id, () => {
    const source = moduleOf(id, name); if (!source) return t.skip('Private official fixture unavailable');
    const input = chunk([renameRequire(source)]), detected = [];
    const output = adaptClient(input, future, { localSpeechEnabled: true, audioEndpoint: 'http://127.0.0.1:32123', onAdaptation: item => detected.push(item) });
    new vm.Script(output);
    assert.equal(detected.length, 1); assert.equal(detected[0].moduleId, id); assert.equal(detected[0].mode, 'automatic');
    if (id !== '241978') assert.notEqual(output, input);
    if (id === '331787') assert.match(output, /static stopDictationAfterLocalFlush\([A-Za-z_$][\w$]*\)/);
    if (id === '328616') assert.ok(output.includes('http://127.0.0.1:32123'));
  });
});

test('repacking several supported modules together is automatic, while changed permissions or drain deadlines are rejected', t => {
  const availability = moduleOf(...entries[0]), recording = moduleOf(...entries[4]);
  if (!availability || !recording) return t.skip('Private official fixtures unavailable');
  assert.doesNotThrow(() => adaptClient(chunk([renameRequire(availability), renameRequire(recording)]), future, { localSpeechEnabled: true }));
  for (const changed of [availability.replace('workspaceRestriction:y', 'workspaceRestriction:undefined'), recording.replace('this.deadlineAtMs=e.clock.now()+12e3', 'this.deadlineAtMs=e.clock.now()+120e3')]) {
    assert.throws(() => adaptClient(chunk([changed]), future, { localSpeechEnabled: true }), /Unreviewed/);
  }
  assert.throws(() => adaptClient(chunk([availability, availability]), future), /Unreviewed/);
  assert.throws(() => adaptClient(chunk([availability]).replace('"use strict";', ''), future), /Unreviewed/);
  const events = [];
  assert.throws(() => adaptClient(chunk([availability, recording.replace('this.deadlineAtMs=e.clock.now()+12e3', 'this.deadlineAtMs=e.clock.now()+120e3')]), future,
    { localSpeechEnabled: true, onAdaptation: event => events.push(event) }));
  assert.equal(events.length, 0, 'A partially incompatible chunk cannot report that any of its patches became active');
});

test('the automatically adapted recording wrapper really stops capture and drains tails using the renamed import binding', async t => {
  const source = moduleOf(...entries[4]); if (!source) return t.skip('Private official fixture unavailable');
  const adapted = adaptClient(chunk([renameRequire(source)]), future, { localSpeechEnabled: true });
  const begin = adapted.indexOf('static stopDictation('), end = adapted.indexOf('static stopDictationAfterLocalFlush(', begin);
  let stopped = false, nativeStops = 0; const sent = [];
  const state = { state: { enabled: true, rootBlock: { id: 'test', pointer: { spaceId: 'workspace' } }, audioRecorder: { stop: () => { stopped = true; } } }, setState(value) { this.state = value; } };
  const api = id => id === 585823 ? { Ay: state } : id === 241978 ? { H1: () => 1, Tg: async () => {} }
    : id === 216735 ? { $g: async value => sent.push(value) } : id === 392719 ? { Rk: async values => Array.from(values[0]), c9() {} } : {};
  const native = vm.runInNewContext('class N{' + adapted.slice(begin, end) + '};N', { _futureRequire: api, setTimeout, clearTimeout });
  Object.assign(native, { sessionOwnership: { getCurrentGeneration: () => 1, isCurrentGeneration: () => true },
    audioBuffer: [.1], sourceAudioBuffers: { microphone: [.2], system_audio: [.3] },
    audioEncoderQueue: { afterFlush: async () => {}, enqueue: run => Promise.resolve().then(run) }, resetAudioBuffers() {},
    stopDictationAfterLocalFlush() { nativeStops++; return { revisionDrain: Promise.resolve(), startBarrier: Promise.resolve() }; } });
  const stop = native.stopDictation({}); assert.equal(stopped, true); await stop.revisionDrain;
  assert.equal(sent.length, 3); assert.equal(nativeStops, 1);
  assert.ok(sent.every(value => value.language === 'auto'));
});

test('an automatic transport patch still rejects remote endpoints and audio-off leaves the original transport untouched', t => {
  const source = moduleOf(...entries[3]); if (!source) return t.skip('Private official fixture unavailable');
  const input = chunk([renameRequire(source)]);
  assert.throws(() => adaptClient(input, future, { localSpeechEnabled: true, audioEndpoint: 'https://example.com' }));
  assert.equal(adaptClient(input, future, { localSpeechEnabled: false }), input);
});

test('production automatic checking runs off the main event loop so recording-stop events remain responsive', async t => {
  const source = moduleOf(...entries[4]); if (!source) return t.skip('Private official fixture unavailable');
  const input = chunk([renameRequire(source)]), events = [];
  let stopEventHandled = false; setTimeout(() => { stopEventHandled = true; }, 0);
  const output = await compatibility.adaptClientAsync(input, future, { localSpeechEnabled: true, onAdaptation: event => events.push(event) });
  assert.equal(stopEventHandled, true, 'Compatibility work cannot hold the event loop until the patch finishes');
  assert.match(output, /stopDictationAfterLocalFlush/); assert.equal(events.length, 1);
});

test('the production response pipeline activates automatic module kinds and preserves the original body on incompatibility', async t => {
  const source = moduleOf(...entries[4]); if (!source) return t.skip('Private official fixture unavailable');
  const input = chunk([renameRequire(source)]), response = new Response(input, { headers: { 'content-type': 'application/javascript', etag: 'old', 'content-length': String(input.length) } });
  const result = await adaptResponse(response, future, { localSpeechEnabled: true });
  assert.deepEqual(result.kinds, ['recording']); assert.equal(result.automatic.length, 1);
  assert.equal(result.response.headers.get('cache-control'), 'no-store'); assert.equal(result.response.headers.get('etag'), null);
  assert.match(await result.response.text(), /stopDictationAfterLocalFlush/);
  const changed = chunk([source.replace('this.deadlineAtMs=e.clock.now()+12e3', 'this.deadlineAtMs=e.clock.now()+120e3')]);
  const original = new Response(changed);
  await assert.rejects(adaptResponse(original, future, { localSpeechEnabled: true }));
  assert.equal(await original.text(), changed, 'An incompatible module is not emptied, mutated or partially patched');
});

export { moduleOf, renameRequire, chunk };
