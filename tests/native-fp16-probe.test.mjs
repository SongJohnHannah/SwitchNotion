import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { probeNativeFp16 } from '../scripts/probe-native-fp16.mjs';
import { buildSummary } from '../scripts/sync-unified-benchmark-records.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function fixture(t) {
  const temp = fs.realpathSync(os.tmpdir()), bundle = fs.mkdtempSync(path.join(temp, 'native-fp16-probe-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(bundle)), temp); fs.rmSync(bundle, { recursive: true, force: true }); });
  const referenceDirectory = path.join(bundle, 'validation/round-1'); fs.mkdirSync(referenceDirectory, { recursive: true });
  const source = path.join(bundle, 'original.webm'); fs.writeFileSync(source, 'original fixture video');
  const pcm = Buffer.alloc(1530 * 16000 * 2, 0x11), text = 'fixture reference words only';
  fs.writeFileSync(path.join(referenceDirectory, 'audio.s16le'), pcm);
  writeJson(path.join(referenceDirectory, 'result.json'), { text });
  const referenceParts = [0, 1, 2].map(index => ({ index, startSample: (1440 + index * 30) * 16000, samples: 30 * 16000,
    text, segments: [{ start: 1440 + index * 30, end: 1470 + index * 30, text }] }));
  writeJson(path.join(referenceDirectory, 'checkpoint.json'), { totalSamples: pcm.length / 2, parts: referenceParts });
  const variantDirectory = path.join(bundle, 'resources/speech/gpu-v1/variants/sm75-native-fp16-accum-v1');
  fs.mkdirSync(path.join(variantDirectory, 'ctranslate2'), { recursive: true });
  fs.writeFileSync(path.join(variantDirectory, 'ctranslate2/ctranslate2.dll'), 'new real-math fixture dll');
  fs.writeFileSync(path.join(variantDirectory, 'ctranslate2/_ext.cp313-win_amd64.pyd'), 'fixture pyd');
  const ready = { files: ['ctranslate2/ctranslate2.dll', 'ctranslate2/_ext.cp313-win_amd64.pyd'].map(file => ({ file, sha256: sha(fs.readFileSync(path.join(variantDirectory, file))) })) };
  const readyFile = path.join(variantDirectory, 'READY.json'); writeJson(readyFile, ready);
  const plan = { id: 'fixture-fp16-native30', runtimeVariant: 'sm75-native-fp16-accum-v1', runtimeRevision: sha(fs.readFileSync(readyFile)),
    computeType: 'float16', launchBlocking: true, beamSize: 1, batchSize: 1, chunkSeconds: 30, resetEveryChunks: 0 };
  writeJson(path.join(bundle, 'plan.json'), plan);
  fs.writeFileSync(path.join(bundle, 'entry.cjs'), 'frozen entry fixture');
  fs.writeFileSync(path.join(bundle, 'operator.cjs'), 'frozen operator fixture must not be loaded by injected tests');
  const machine = { model: 'large-v3-turbo', modelDirectory: 'resources/speech/model', resourcesRoot: 'resources', originalVideo: source,
    profiles: { fp16: { planFile: 'plan.json', entryFile: 'entry.cjs', experimental: true } } };
  const machineFile = path.join(bundle, 'machine.json'); writeJson(machineFile, machine);
  return { bundle, plan, variantDirectory, machineFile, expectedReference: { totalSamples: pcm.length / 2, textSha256: sha(text), pcmSha256: sha(pcm) },
    runRoot: path.join(bundle, 'experiments/native-fp16/probe-fixture'), log: () => {} };
}

test('a native call failure is a durable single canary attempt, with fresh exact PCM and no reference prompt', async t => {
  const input = fixture(t), before = fs.readFileSync(input.machineFile), calls = [];
  const state = await probeNativeFp16({ ...input, profile: 'fp16', transcribeFile: async request => {
    calls.push(request);
    assert.equal(request.allowExperimental, true); assert.equal(request.language, 'en');
    assert.equal(request.profile, 'fp16'); assert.equal(request.context, undefined); assert.equal(request.referenceText, undefined);
    assert.deepEqual(fs.readdirSync(request.outputDirectory), []);
    const wav = fs.readFileSync(request.source);
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); assert.equal(wav.length, 44 + 90 * 16000 * 2);
    assert.equal(sha(wav.subarray(44)), sha(Buffer.alloc(90 * 16000 * 2, 0x11)));
    fs.writeFileSync(path.join(request.outputDirectory, 'raw-results.jsonl'), '{"event":"failed","error":"CUDA fixture illegal address"}\n');
    throw Object.assign(Error('CUDA fixture illegal address'), { code: 'NATIVE_FAILURE' });
  } });
  assert.equal(calls.length, 1); assert.equal(state.status, 'failed'); assert.equal(state.active, null); assert(state.completedAt);
  assert.equal(state.attempts.length, 1); assert.equal(state.attempts[0].phase, 'canary'); assert.equal(state.attempts[0].round, 1);
  assert.equal(state.attempts[0].complete, false); assert.match(state.attempts[0].error, /illegal address/);
  assert.equal(state.attempts[0].report.failure.code, 'NATIVE_FAILURE');
  assert.equal(state.candidateIdentity.sha256, state.candidateIdentityAfter.sha256);
  assert.deepEqual(fs.readFileSync(input.machineFile), before);
  const saved = JSON.parse(fs.readFileSync(path.join(state.runRoot, 'state.json')));
  const summary = buildSummary({ state: saved, stateFile: path.join(state.runRoot, 'state.json'), contentHash: 'fixture' });
  assert.equal(summary.attempts.length, 1); assert.equal(summary.attempts[0].report.runtimeStatus, 'runtime-review');
  assert(fs.existsSync(path.join(state.attempts[0].directory, 'quality-report.json')));
  assert.match(fs.readFileSync(path.join(state.attempts[0].directory, 'raw-results.jsonl'), 'utf8'), /illegal address/);
});

test('an API-complete result cannot pass with truncated coverage, phone omission or runtime mutation', async t => {
  const input = fixture(t), before = fs.readFileSync(input.machineFile); let calls = 0;
  const state = await probeNativeFp16({ ...input, profile: 'fp16', transcribeFile: async request => {
    calls++;
    const pcm = fs.readFileSync(request.source).subarray(44), totalSamples = 90 * 16000, text = 'Roasted.';
    fs.writeFileSync(path.join(request.outputDirectory, 'audio.s16le'), pcm);
    const parts = [0, 1, 2].map(index => ({ index, startSample: index * 480000, samples: index === 2 ? 479999 : 480000,
      device: 'cuda', text, segments: [{ start: index * 30, end: (index + 1) * 30, text }] }));
    const result = { complete: true, device: 'cuda', recoveries: 0, nativeExits: 0, totalSamples, text, plan: input.plan };
    writeJson(path.join(request.outputDirectory, 'result.json'), result);
    writeJson(path.join(request.outputDirectory, 'checkpoint.json'), { totalSamples, parts });
    const events = [{ event: 'start', resumedChunks: 0, totalSamples, at: '2026-11-06T01:00:00Z' }];
    for (const part of parts) {
      const floats = Buffer.alloc(part.samples * 4);
      for (let sample = 0; sample < part.samples; sample++) floats.writeFloatLE(pcm.readInt16LE((part.startSample + sample) * 2) / 32768, sample * 4);
      events.push({ event: 'result', index: part.index, startSample: part.startSample, samples: part.samples,
        pcmSha256: sha(floats), result: { workerPid: 12543, text } });
    }
    events.push({ event: 'complete', totalSamples, at: '2026-11-06T01:00:10Z' });
    fs.writeFileSync(path.join(request.outputDirectory, 'raw-results.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
    fs.appendFileSync(path.join(input.variantDirectory, 'ctranslate2/ctranslate2.dll'), 'changed during call');
    return result;
  } });
  assert.equal(calls, 1); assert.equal(state.status, 'failed'); assert.equal(state.attempts[0].complete, true);
  const report = state.attempts[0].report;
  assert(report.actualInputAndWorkerAudit.inputIssues.includes('part-samples-do-not-cover-full-audio'));
  assert(report.hardFailureReasons.includes('phone-regression-or-segment-integrity-gate-failed'));
  assert(report.identityIssues.includes('candidate-identity-changed-during-call'));
  assert.equal(report.namedCoverage.checks.find(item => item.id === '1470-1500-phone').status, 'FAIL');
  const afterDll = state.candidateIdentityAfterFailure.runtimeFiles.find(item => item.file.endsWith('ctranslate2.dll'));
  const beforeDll = state.candidateIdentity.value.runtime.files.find(item => item.file.endsWith('ctranslate2.dll'));
  assert.notEqual(afterDll.sha256, beforeDll.sha256);
  assert.deepEqual(fs.readFileSync(input.machineFile), before);
  assert.equal(state.controls.fullQualityProven, false); assert.equal(state.controls.automaticFullRun, false);
  assert(fs.existsSync(path.join(state.attempts[0].directory, 'operator-return.json')));
});
