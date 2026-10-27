import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import compatibility from '../src/client-compat.cjs';
import client from '../src/speech/client.cjs';

function fixture() {
  const events = []; let queued = Promise.resolve();
  const state = { state: { enabled: true, rootBlock: { id: 'meeting', pointer: { spaceId: 'workspace' } } }, setState(value) { this.state = value; } };
  const queue = { afterFlush: () => queued, enqueue(run) { const next = queued.then(run); queued = next.catch(() => {}); return next; } };
  const actions = { audioBuffer: [0.1, 0.2, 0.3], sourceAudioBuffers: { microphone: [0.4], system_audio: [0.5, 0.6] }, audioEncoderQueue: queue,
    sessionOwnership: { getCurrentGeneration: () => 1, isCurrentGeneration: () => true },
    resetAudioBuffers() { events.push('reset'); this.audioBuffer = []; this.sourceAudioBuffers = { microphone: [], system_audio: [] }; },
    stopDictationAfterLocalFlush(input) { events.push(input.error ? 'error-stop' : 'stop'); return { revisionDrain: Promise.resolve(), startBarrier: Promise.resolve() }; } };
  const calls = [];
  const api = { state, transport: { H1: () => 'owner', Tg: async owner => { assert.equal(owner, 'owner'); events.push('written'); } },
    encode: async pieces => { events.push('encode'); return Array.from(pieces[0]); }, language: () => 'auto',
    send: async value => { events.push('send'); calls.push(value); } };
  return { actions, api, calls, events };
}

function actualNativeQueue(t) {
  const file = new URL('../research/.public-assets/43944-13c153cf3a4d70e9.js', import.meta.url);
  if (!fs.existsSync(file)) { t.skip('Official native queue fixture unavailable'); return null; }
  const source = fs.readFileSync(file, 'utf8');
  const boundaries = [...source.matchAll(/(?:^|[,{])(\d+)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{/g)];
  const index = boundaries.findIndex(match => match[1] === '172112');
  const module = source.slice(boundaries[index].index + 1, boundaries[index + 1]?.index ?? source.lastIndexOf('}]);'));
  const exports = {}, require = id => id === 326904 ? { yX: () => Promise.withResolvers() } : {};
  require.d = (target, getters) => { for (const [name, get] of Object.entries(getters)) Object.defineProperty(target, name, { get }); };
  vm.runInNewContext('({' + module + '})[172112]', { Promise })({}, exports, require);
  return new exports.O(1);
}

test('the actual native encoder queue survives two consecutive recordings and both stops complete', async t => {
  const queue = actualNativeQueue(t); if (!queue) return;
  const deadline = promise => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Error('停止录音未完成：原生编码队列被阻塞')), 200))]);
  const first = fixture(); first.actions.audioEncoderQueue = queue;
  await deadline(client.stopWithAudioFlush(first.actions, {}, first.api).revisionDrain);
  const second = fixture(); second.actions.audioEncoderQueue = queue;
  await deadline(client.stopWithAudioFlush(second.actions, {}, second.api).revisionDrain);
  assert.equal(queue.isEmpty(), true);
  assert.equal(first.events.includes('error-stop'), false); assert.equal(second.events.includes('error-stop'), false);
});

test('a stalled real encoder cannot indefinitely block stopping and its late completion cannot submit more audio', async t => {
  const queue = actualNativeQueue(t); if (!queue) return;
  let release; queue.enqueue(() => new Promise(resolve => { release = resolve; }));
  const f = fixture(); f.actions.audioEncoderQueue = queue; f.api.stopWaitMs = 20;
  const result = client.stopWithAudioFlush(f.actions, {}, f.api);
  await result.revisionDrain;
  assert.equal(f.events.filter(event => event === 'error-stop').length, 1);
  assert.equal(f.calls.length, 0);
  release(); await queue.afterFlush(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 0); assert.equal(f.events.filter(event => event === 'error-stop').length, 1);
});

test('clicking stop releases microphone and system capture before waiting for a stalled encoder or transcription', async () => {
  const f = fixture(); let capturing = true, stops = 0, release;
  f.api.state.state.audioRecorder = { stop(options) {
    assert.equal(options.triggerOnStop, false, 'Do not recursively close the native transcript writer');
    assert.equal(options.triggerFlushToOPFS, true); capturing = false; stops++;
  } };
  f.actions.audioEncoderQueue.afterFlush = () => new Promise(resolve => { release = resolve; });
  f.api.stopWaitMs = 20;
  const result = client.stopWithAudioFlush(f.actions, {}, f.api);
  try {
    assert.equal(capturing, false, 'Capture must stop on the click, not after ASR or encoding');
    assert.equal(f.events.includes('stop'), false, 'Already accepted audio still gets a chance to drain');
  } finally { release(); await result.revisionDrain; }
  assert.equal(stops, 1);
});

test('the reviewed native recorder releases both audio tracks even while archive flushing and encoding are stalled', async t => {
  const file = new URL('../research/.public-assets/69116-1219ce1a1441deca.js', import.meta.url);
  if (!fs.existsSync(file)) return t.skip('Official native recorder fixture unavailable');
  const source = fs.readFileSync(file, 'utf8'), start = source.indexOf('stop(e){'), end = source.indexOf('deviceChangeEventCount=0;', start);
  assert.ok(start >= 0 && end > start);
  const listener = { removeListener() {} };
  const method = vm.runInNewContext('({' + source.slice(start, end) + '}).stop', {
    i: () => ({ d: listener }), v: () => ({ X8: listener, Cu: listener }), clearTimeout
  });
  const tracks = [{ stopped: false }, { stopped: false }]; let released = false, captureFlag = true, release;
  const recorder = { startController: new AbortController(), clearHeartbeatTimer() {}, lastAudioFrameReceivedAtBySource: new Map(),
    reportedStalledHeartbeatSources: new Set(), handleDeviceChangeDebounced: { cancel() {} }, trackMuteTimers: new Map(),
    recorder: { releaseMediaResources() { released = true; } },
    set mediaStreams(value) { assert.equal(value, undefined); for (const track of tracks) track.stopped = true; },
    flushArchiveAudio: () => new Promise(() => {}), stop: method };
  const f = fixture(); f.api.state.state.audioRecorder = recorder; f.api.captureStopped = () => { captureFlag = false; };
  f.actions.audioEncoderQueue.afterFlush = () => new Promise(resolve => { release = resolve; }); f.api.stopWaitMs = 20;
  const result = client.stopWithAudioFlush(f.actions, {}, f.api);
  try {
    assert.equal(released, true); assert.ok(tracks.every(track => track.stopped));
    assert.equal(captureFlag, false); assert.equal(recorder.startController.signal.aborted, true);
  } finally { release(); await result.revisionDrain; }
});

test('native stop flushes all sub-frame microphone and system audio after pending encoders, before closing the writer', async () => {
  const f = fixture();
  f.actions.audioEncoderQueue.enqueue(async () => { await Promise.resolve(); f.events.push('old-frame'); });
  const result = client.stopWithAudioFlush(f.actions, { environment: {} }, f.api);
  assert.equal(f.api.state.state.enabled, false, 'Stop capturing immediately while preserving the writer');
  assert.equal(f.events.includes('stop'), false);
  assert.equal(client.stopWithAudioFlush(f.actions, { environment: {} }, f.api), result, 'Repeated stop must not send duplicate tails');
  await result.revisionDrain;
  assert.deepEqual(f.calls.map(value => value.base64Audio.length), [3, 1, 2], 'Even less than one millisecond of audio must be sent');
  assert.deepEqual(f.calls.map(value => value.audioSource), [undefined, 'microphone', 'system_audio']);
  assert.ok(f.events.indexOf('old-frame') < f.events.indexOf('reset'));
  assert.ok(f.events.indexOf('written') < f.events.indexOf('stop'));
  assert.equal(f.events.filter(value => value === 'stop').length, 1);
});

test('recording errors stop immediately and encoder failures do not masquerade as a successful stop', async () => {
  const f = fixture(); client.stopWithAudioFlush(f.actions, { error: Error('cancel') }, f.api);
  assert.deepEqual(f.events, ['error-stop']); assert.equal(f.calls.length, 0);
  const g = fixture(); g.api.encode = async () => { throw Error('fixture encoder failed'); };
  await client.stopWithAudioFlush(g.actions, {}, g.api).revisionDrain;
  assert.equal(g.events.at(-1), 'error-stop'); assert.equal(g.calls.length, 0);
});

test('cancellation while flushing never sends a previous recording into a replacement meeting', async () => {
  const f = fixture(); f.api.encode = async () => { f.actions.sessionOwnership.isCurrentGeneration = () => false; return 'unused'; };
  await client.stopWithAudioFlush(f.actions, {}, f.api).revisionDrain;
  assert.equal(f.calls.length, 0); assert.equal(f.events.filter(value => value === 'stop').length, 0,
    'A late stop from the old generation cannot shut down the replacement recording');
});

const asset = '89269-cbd3af4d28334ce0.js', file = new URL('../research/.public-assets/' + asset, import.meta.url);
const official = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
function nativeLifecycle(source) {
  const start = source.indexOf('class ep{'), end = source.indexOf('function em(', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(source.slice(start, end) + ';ep', { AbortController, Promise, ed: run => run() });
}
async function delayedFinalSentence(source, elapsed) {
  const Lifecycle = nativeLifecycle(source); let now = 0, deadline, finish, transcribed = false, discarded = false;
  const lifecycle = new Lifecycle({ clock: { now: () => now, scheduleDeadline: (run, ms) => { deadline = { run, ms }; return () => {}; } },
    onComplete() {}, dependencies: {
      drain: () => new Promise(resolve => { finish = resolve; }), finalize() {}, applySpeakerAttribution() {}, awaitServerCommits() {},
      emitWriterChanges() {}, close() {}, cleanup() {}, onDeadlineReached() {}, onPersistenceCompletedAfterDeadline() {},
      destroy() { if (!transcribed) discarded = true; }, reportError(error) { throw error.error; }
    } });
  lifecycle.start(); now = elapsed;
  if (deadline.ms <= elapsed) { deadline.run(); await lifecycle.handle.teardownCompletion; }
  else { transcribed = true; finish({ type: 'acked' }); await lifecycle.handle.teardownCompletion; }
  return { discarded, transcribed, outcome: (await lifecycle.handle.outcome).type, waitMs: deadline.ms };
}

test('reviewed native stop retains its finite twelve-second drain deadline instead of prolonging a stalled stop', official ? {} : { skip: 'Official asset fixture unavailable' }, async () => {
  const baseline = await delayedFinalSentence(official, 17000);
  assert.equal(baseline.discarded, true, 'Control reproduces the original missing final sentence');
  const adapted = compatibility.adaptClient(official, asset, { localSpeechEnabled: true });
  const fixed = await delayedFinalSentence(adapted, 17000);
  assert.deepEqual(fixed, baseline);
  assert.equal(fixed.waitMs, 12000);
  assert.match(adapted, /transcriptionDrainEnabled:!0/);
  assert.match(adapted, /static stopDictationAfterLocalFlush\(e\)/);
  assert.equal(compatibility.adaptClient(official, asset), official);
  assert.throws(() => compatibility.adaptClient(official + 'changed', asset, { localSpeechEnabled: true }));
  new vm.Script(adapted);
});

test('native connection watchdog keeps its original finite lifetime', () => {
  const asset = '17048-31dd3b95acbe5529.js', file = new URL('../research/.public-assets/' + asset, import.meta.url);
  if (!fs.existsSync(file)) return;
  const source = fs.readFileSync(file, 'utf8'), adapted = compatibility.adaptClient(source, asset, { localSpeechEnabled: true });
  assert.equal(adapted, source); assert.match(adapted, /watchdog_ms:3e4/);
  assert.equal(compatibility.adaptClient(source, asset), source); new vm.Script(adapted);
});

test('current native meeting module uses tail flush with the original finite drain lifecycle', async t => {
  const name = '89269-f5f20fe25f8eec19.js', file = new URL('../research/.public-assets/' + name, import.meta.url);
  if (!fs.existsSync(file)) return t.skip('Current official asset fixture unavailable');
  const source = fs.readFileSync(file, 'utf8'), adapted = compatibility.adaptClient(source, name, { localSpeechEnabled: true });
  assert.match(adapted, /transcriptionDrainEnabled:!0/);
  assert.match(adapted, /static stopDictationAfterLocalFlush\(e\)/);
  assert.equal((await delayedFinalSentence(adapted, 17000)).outcome, 'timeout');
  new vm.Script(adapted);
  const renamed = name.replace(/-[a-f\d]+/, '-1111111111111111');
  assert.equal(compatibility.adaptClient(source, renamed, { localSpeechEnabled: true }), adapted);
  assert.throws(() => compatibility.adaptClient(source.replace('this.deadlineAtMs=e.clock.now()+12e3', 'this.deadlineAtMs=e.clock.now()+1e3'), renamed, { localSpeechEnabled: true }));
});

test('October 27 renamed native bindings use the correct store and stop capture before draining audio', async t => {
  for (const name of ['89269-2fe838f2338339c3.js', '89269-d1126e6593a9953d.js']) {
    const file = new URL('../research/.public-assets/' + name, import.meta.url);
    if (!fs.existsSync(file)) return t.skip('Updated official native fixture unavailable');
    const source = fs.readFileSync(file, 'utf8'), adapted = compatibility.adaptClient(source, name, { localSpeechEnabled: true });
    new vm.Script(adapted);
    const f = fixture(); let captureStopped = false;
    f.api.state.state.audioRecorder = { stop: () => { captureStopped = true; } };
    const start = adapted.indexOf('static stopDictation(e){'), end = adapted.indexOf('static stopDictationAfterLocalFlush(e){', start);
    assert.ok(start >= 0 && end > start);
    const native = vm.runInNewContext('class Current{' + adapted.slice(start, end) + '};Current', {
      S: () => ({ Ay: f.api.state }), setTimeout, clearTimeout,
      i: id => id === 585823 ? { Ay: f.api.state } : id === 241978 ? f.api.transport : id === 216735 ? { $g: f.api.send } : id === 392719 ? { Rk: f.api.encode, c9() {} } : {}
    });
    Object.assign(native, f.actions);
    const result = native.stopDictation({});
    assert.equal(captureStopped, true); await result.revisionDrain;
    assert.equal(f.calls.length, 3); assert.equal(f.events.filter(e => e === 'stop').length, 1);
    const renamed = name.replace(/-[a-f\d]+/, '-3333333333333333');
    assert.throws(() => compatibility.adaptClient(source.replace('static stopDictation(e){', 'static stopDictation(e){throw Error("changed");'), renamed, { localSpeechEnabled: true }));
  }
});
