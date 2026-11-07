import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyWhole120Repair } from '../scripts/verify-whole120-repair.mjs';
import { buildSummary } from '../scripts/sync-unified-benchmark-records.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const namedIds = ['94-short-clause', '2274-honest-agreement', '2732-full-question', '2790-tail-appreciation', '1470-1500-phone'];

function fixture(t, options = {}) {
  const parent = fs.realpathSync(os.tmpdir());
  const bundle = fs.mkdtempSync(path.join(parent, 'whole120-repair-run-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(bundle)), parent); fs.rmSync(bundle, { recursive: true, force: true }); });
  const referenceDirectory = path.join(bundle, 'validation/round-1');
  fs.mkdirSync(referenceDirectory, { recursive: true });
  const source = path.join(bundle, 'interview.webm'); fs.writeFileSync(source, 'fixture source');
  const pcm = Buffer.alloc(32); for (let index = 0; index < pcm.length; index += 2) pcm.writeInt16LE(1000, index);
  const referenceText = 'Reference original words.';
  fs.writeFileSync(path.join(referenceDirectory, 'result.json'), JSON.stringify({ text: referenceText }));
  fs.writeFileSync(path.join(referenceDirectory, 'audio.s16le'), pcm);
  fs.writeFileSync(path.join(bundle, 'plan.json'), JSON.stringify({ chunkSeconds: 120, computeType: 'float16' }));
  fs.writeFileSync(path.join(bundle, 'entry.cjs'), 'frozen fixture entry');
  fs.writeFileSync(path.join(bundle, 'operator.cjs'), 'frozen fixture operator');
  fs.writeFileSync(path.join(bundle, 'machine.json'), JSON.stringify({ originalVideo: source, model: 'large-v3-turbo',
    modelDirectory: 'resources/speech/model', profiles: { repair: { planFile: 'plan.json', entryFile: 'entry.cjs', experimental: true } } }));
  const expectedReference = { totalSamples: pcm.length / 2, textSha256: sha(referenceText), pcmSha256: sha(pcm) };
  const calls = [];
  const secondsFor = round => Array.isArray(options.seconds) ? options.seconds[round - 1] : options.seconds ?? 300;
  const transcribeFile = async request => {
    calls.push(request); const round = calls.length;
    assert.deepEqual(fs.readdirSync(request.outputDirectory).sort(), ['audio-source.json', 'audio.s16le']);
    const stat = fs.statSync(source);
    assert.equal(JSON.parse(fs.readFileSync(path.join(request.outputDirectory, 'audio-source.json'))).sourceIdentity,
      sha(JSON.stringify([fs.realpathSync(source), stat.size, stat.mtimeMs])));
    if (options.throwOnRound === round) throw Error('CUDA illegal address fixture');
    const text = options.text || referenceText, pid = 1000 + round;
    fs.mkdirSync(request.outputDirectory, { recursive: true });
    const result = { complete: true, device: 'cuda', totalSamples: expectedReference.totalSamples,
      recoveries: 0, nativeExits: 0, text, plan: { computeType: 'float16' } };
    const floats = new Float32Array(expectedReference.totalSamples);
    for (let index = 0; index < floats.length; index++) floats[index] = pcm.readInt16LE(index * 2) / 32768;
    const part = { index: 0, startSample: 0, samples: expectedReference.totalSamples, device: 'cuda', text,
      segments: [{ start: 0, end: .001, text }] };
    fs.writeFileSync(path.join(request.outputDirectory, 'audio.s16le'), pcm);
    fs.writeFileSync(path.join(request.outputDirectory, 'result.json'), JSON.stringify(result));
    fs.writeFileSync(path.join(request.outputDirectory, 'checkpoint.json'), JSON.stringify({ totalSamples: expectedReference.totalSamples, parts: [part] }));
    fs.writeFileSync(path.join(request.outputDirectory, 'raw-results.jsonl'), [
      { event: 'start', resumedChunks: 0, at: '2026-11-06T00:00:00Z', totalSamples: expectedReference.totalSamples },
      { event: 'result', index: 0, startSample: 0, samples: expectedReference.totalSamples, pcmSha256: sha(Buffer.from(floats.buffer)), result: { workerPid: pid, text } },
      { event: 'complete', at: new Date(Date.parse('2026-11-06T00:00:00Z') + secondsFor(round) * 1000).toISOString() },
    ].map(JSON.stringify).join('\n') + '\n');
    request.onProgress({ stage: 'transcribing', index: 0, totalChunks: 1 });
    return result;
  };
  const auditQuality = async ({ candidateDirectory }) => {
    const round = Number(candidateDirectory.match(/round-(\d+)$/)[1]);
    return { status: 'pass', runtimeStatus: 'pass', identityIssues: [], anomalyCount: 0,
      runtime: { complete: true, device: 'cuda', errors: 0, recoveries: 0, nativeExits: 0, fresh: true,
        workerPids: [1000 + round], recognitionSeconds: secondsFor(round) } };
  };
  const checkCoverage = () => ({ status: 'PASS_NAMED_ANCHORS_ONLY', evaluatedChecks: 5, failedChecks: [],
    checks: namedIds.map(id => ({ id, status: 'PASS' })) });
  return { bundle, calls, expectedReference, transcribeFile, auditQuality, checkCoverage,
    runRoot: path.join(bundle, 'experiments/whole120-repair/full-fixture'), log: () => {} };
}

test('two slower full runs still complete functional checks and never self-promote', async t => {
  const input = fixture(t);
  const state = await verifyWhole120Repair({ ...input, profile: 'repair' });
  assert.equal(input.calls.length, 2);
  assert(input.calls.every(call => call.language === 'en' && call.profile === 'repair' && call.allowExperimental === true));
  assert.notEqual(input.calls[0].outputDirectory, input.calls[1].outputDirectory);
  assert.equal(state.active, null);
  assert.equal(state.attempts.length, 2);
  assert.equal(state.series[0].functionalStatus, 'machine-reference-exact-two-rounds');
  assert.equal(state.series[0].speed.meetsSevenPercent, false);
  assert.equal(state.series[0].promotionEligible, false);
  assert.notEqual(state.series[0].status, 'eligible');
  assert(state.attempts.every(attempt => attempt.v1ExactTextEquality === true));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state.runRoot, 'state.json'))).attempts.length, 2);
  assert.equal(state.inputPreparation, 'verified-existing-pcm-cache');
});

test('a GPU runtime failure stops after first attempt and preserves the failed record', async t => {
  const input = fixture(t, { throwOnRound: 1 });
  const state = await verifyWhole120Repair({ ...input, profile: 'repair' });
  assert.equal(input.calls.length, 1);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].hardFailure, true);
  assert.match(state.attempts[0].error, /CUDA illegal address/);
  assert.equal(state.series[0].status, 'stopped-on-first-failure');
  assert.equal(fs.existsSync(path.join(state.attempts[0].directory, 'quality-report.json')), true);
});

test('failure of one named missing-clause gate stops the candidate, with no third-run selection', async t => {
  const input = fixture(t);
  const checkCoverage = () => ({ status: 'FAIL', evaluatedChecks: 5, failedChecks: ['2732-full-question'],
    checks: namedIds.map(id => ({ id, status: id === '2732-full-question' ? 'FAIL' : 'PASS' })) });
  const state = await verifyWhole120Repair({ ...input, profile: 'repair', checkCoverage });
  assert.equal(input.calls.length, 1);
  assert.equal(state.attempts[0].hardFailure, true);
  assert(state.attempts[0].hardFailureReasons.includes('named-five-regression-gate-failed'));
  assert.equal(JSON.parse(fs.readFileSync(state.attempts[0].namedCoverageFile)).failedChecks[0], '2732-full-question');
});

test('all five anchors passing never certify different full text; it stays pending independent review', async t => {
  const input = fixture(t, { text: 'Different complete machine transcript.' });
  const state = await verifyWhole120Repair({ ...input, profile: 'repair' });
  assert.equal(input.calls.length, 2);
  assert(state.attempts.every(attempt => !attempt.hardFailure && attempt.v1ExactTextEquality === false));
  assert.equal(state.series[0].status, 'pending-independent-content-review');
  assert.equal(state.series[0].promotionEligible, false);
  const summary = buildSummary({ state, stateFile: path.join(state.runRoot, 'state.json') });
  assert.equal(summary.attempts.length, 2);
  assert(summary.attempts.every(attempt => attempt.report.status === 'content-review'));
});

test('wrong exact PCM sample bytes fail before a second GPU call even if audits were permissive', async t => {
  const input = fixture(t), original = input.transcribeFile;
  const state = await verifyWhole120Repair({ ...input, profile: 'repair', transcribeFile: async request => {
    const value = await original(request);
    const file = path.join(request.outputDirectory, 'audio.s16le'); const pcm = fs.readFileSync(file); pcm[0] ^= 1; fs.writeFileSync(file, pcm);
    return value;
  } });
  assert.equal(input.calls.length, 1);
  assert(state.attempts[0].hardFailureReasons.includes('decoded-pcm-sha256-mismatch'));
  assert(state.attempts[0].hardFailureReasons.includes('actual-float32-request-sha256-mismatch-0'));
});

test('a real-worker change or frozen-entry mutation cannot become a fresh stable survivor', async t => {
  const input = fixture(t), original = input.transcribeFile;
  const state = await verifyWhole120Repair({ ...input, profile: 'repair', transcribeFile: async request => {
    const value = await original(request);
    fs.appendFileSync(path.join(input.bundle, 'entry.cjs'), 'changed during first round');
    return value;
  } });
  assert.equal(input.calls.length, 1);
  assert(state.attempts[0].hardFailureReasons.includes('frozen-candidate-changed-during-round'));
  await assert.rejects(verifyWhole120Repair({ ...input, profile: 'repair' }), /EEXIST/);
  assert.equal(input.calls.length, 1);
});

test('speed-first stops a slow first full run as below7% without calling it a GPU failure', async t => {
  const input = fixture(t);
  const state = await verifyWhole120Repair({ ...input, profile: 'repair', speedFirst: true });
  assert.equal(input.calls.length, 1);
  assert.equal(state.mode, 'GPU-speed-search');
  assert.equal(state.speedStop, true);
  assert.equal(state.speedStopReason, 'below7%');
  assert.equal(state.attempts[0].hardFailure, false);
  assert.equal(state.attempts[0].speedStop, true);
  assert.equal(state.attempts[0].report.runtimeStatus, 'pass');
  assert.equal(state.attempts[0].report.status, 'pass');
  assert.equal(state.series[0].status, 'stopped-below7%');
  assert.equal(state.series[0].promotionEligible, false);
  assert(fs.existsSync(path.join(state.attempts[0].directory, 'raw-results.jsonl')));
});

test('speed-first continues two fast Native30-labelled runs without changing the frozen plan', async t => {
  const input = fixture(t, { seconds: [170, 175] });
  const planFile = path.join(input.bundle, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify({ chunkSeconds: 30, computeType: 'float16' }));
  const before = fs.readFileSync(planFile);
  const state = await verifyWhole120Repair({ ...input, profile: 'repair', speedFirst: true });
  assert.equal(input.calls.length, 2);
  assert.equal(state.mode, 'GPU-speed-search');
  assert.equal(state.baselineMedianSeconds, 194.092);
  assert.equal(state.speedStop, false);
  assert.equal(state.series[0].speed.meetsSevenPercent, true);
  assert.equal(state.series[0].promotionEligible, false);
  assert.deepEqual(fs.readFileSync(planFile), before);
});

test('exactly the seven-percent threshold does not stop the second full run', async t => {
  const input = fixture(t, { seconds: 180.50556 });
  const state = await verifyWhole120Repair({ ...input, profile: 'repair', speedFirst: true });
  assert.equal(input.calls.length, 2);
  assert.equal(state.speedStop, false);
  assert.equal(state.attempts[0].speedStop, false);
});

test('fast full-text differences stay pending independent review after two rounds', async t => {
  const input = fixture(t, { seconds: [170, 171], text: 'Different complete machine transcript.' });
  const state = await verifyWhole120Repair({ ...input, profile: 'repair', speedFirst: true });
  assert.equal(input.calls.length, 2);
  assert.equal(state.series[0].functionalStatus, 'pending-independent-content-review');
  assert.equal(state.series[0].promotionEligible, false);
  assert(state.attempts.every(attempt => attempt.report.contentStatus === 'pending-independent-content-review'));
});

test('a fast first run still cannot bypass the named quality gate', async t => {
  const input = fixture(t, { seconds: 100 });
  const state = await verifyWhole120Repair({ ...input, profile: 'repair', speedFirst: true,
    checkCoverage: () => ({ status: 'FAIL', evaluatedChecks: 5, failedChecks: ['2732-full-question'], checks: [] }) });
  assert.equal(input.calls.length, 1);
  assert.equal(state.speedStop, false);
  assert.equal(state.attempts[0].hardFailure, true);
  assert(state.attempts[0].hardFailureReasons.includes('named-five-regression-gate-failed'));
});
