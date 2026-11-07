import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { GpuOperatorClient } = require('../src/speech/operator-client.cjs');
const { assessTranscriptWindows, auditRunQuality, assessBenchmarkSeries } = require('../src/speech/content-window-gate.cjs');
const bundle = path.resolve(process.argv[2] || 'D:/迅雷下载/notionSwitch/GPU转写算子');
const mode = process.argv[3] || 'all';
const machine = JSON.parse(fs.readFileSync(path.join(bundle, 'machine.json')));
const source = machine.originalVideo, referenceDirectory = path.join(bundle, 'validation/round-1');
const reference = JSON.parse(fs.readFileSync(path.join(referenceDirectory, 'checkpoint.json')));
const referencePcm = fs.readFileSync(path.join(referenceDirectory, 'audio.s16le'));
const runRoot = path.join(bundle, 'experiments', 'runs-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runRoot, { recursive: true });
// This historical harness targets a standalone bundle, including its assets.
const client = new GpuOperatorClient({ root: path.resolve(import.meta.dirname, '../.notion-switch'), directory: bundle, assetsDirectory: bundle });
const state = { version: 1, createdAt: new Date().toISOString(), runRoot, mode, source, referenceDirectory,
  baselineSeconds: [193.326, 194.858], inferenceThresholdSeconds: 180.50556,
  adapterWallTimingScope: 'Legacy adapterWallSeconds includes input preparation, model loading, queue wait, inference AND subsequent content/PCM audit; not pure API latency.',
  attempts: [], series: [], active: null };
const save = () => { fs.writeFileSync(path.join(runRoot, 'state.json.tmp'), JSON.stringify(state, null, 2)); fs.renameSync(path.join(runRoot, 'state.json.tmp'), path.join(runRoot, 'state.json')); };
const log = event => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
const controller = new AbortController(); process.once('SIGINT', () => controller.abort(Error('基准队列已取消。')));
const canaryOffset = 1440, canarySamples = 90 * 16000;
const data = referencePcm.subarray(canaryOffset * 16000 * 2, (canaryOffset * 16000 + canarySamples) * 2);
const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24);
header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
const canaryFile = path.join(runRoot, 'jensen-1440-1530.wav'); fs.writeFileSync(canaryFile, Buffer.concat([header, data]));
const canarySha = createHash('sha256').update(data).digest('hex');
function blockProfile(profile, reason, status = 'content-review-needed') {
  const file = path.join(bundle, 'machine.json'), current = JSON.parse(fs.readFileSync(file));
  current.profiles[profile] = { ...current.profiles[profile], status, reviewReason: reason };
  fs.writeFileSync(file + '.tmp', JSON.stringify(current, null, 2)); fs.renameSync(file + '.tmp', file);
}
async function run(profile, phase, round) {
  controller.signal.throwIfAborted();
  const directory = path.join(runRoot, profile + '-' + phase + '-' + round);
  state.active = { profile, phase, round, directory, startedAt: new Date().toISOString() }; save(); log({ event: 'start', ...state.active });
  let report, waited = false, result, error;
  const before = performance.now();
  try {
    result = await client.transcribeFile({ source: phase === 'canary' ? canaryFile : source, outputDirectory: directory,
      language: 'en', profile, allowExperimental: true, signal: controller.signal,
      onProgress: value => { if (value.stage === 'waiting-gpu') waited = true; if (value.stage === 'transcribing' && value.index % 12 === 0) log({ event: 'progress', profile, phase, round, ...value }); } });
    if (phase === 'canary') {
      const decoded = fs.readFileSync(path.join(directory, 'audio.s16le'));
      if (createHash('sha256').update(decoded).digest('hex') !== canarySha) throw Error('短测PCM与原始音轨窗口不同。');
      const checkpoint = JSON.parse(fs.readFileSync(result.checkpointFile));
      const parts = checkpoint.parts.map(part => ({ ...part, startSample: part.startSample + canaryOffset * 16000,
        segments: (part.segments || []).map(segment => ({ ...segment, start: segment.start + canaryOffset, end: segment.end + canaryOffset })) }));
      report = assessTranscriptWindows({ referenceParts: reference.parts, candidateParts: parts, totalSamples: reference.totalSamples,
        pcmBuffer: referencePcm, range: { start: canaryOffset, end: canaryOffset + 90 }, windowSeconds: [15, 30] });
      report.runtimeStatus = result.recoveries === 0 && result.nativeExits === 0 && result.device === 'cuda' ? 'pass' : 'runtime-review';
    } else report = await auditRunQuality({ referenceDirectory, candidateDirectory: directory });
  } catch (failure) {
    error = failure.message; report = { status: 'runtime-review', runtimeStatus: 'runtime-review', error };
  }
  const attempt = { ...state.active, endedAt: new Date().toISOString(), adapterWallSeconds: (performance.now() - before) / 1000,
    waitedForGpu: waited, complete: result?.complete === true, report, error };
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'quality-report.json'), JSON.stringify(report, null, 2));
  state.attempts.push(attempt); state.active = null; save(); log({ event: 'finished', profile, phase, round, status: report.status, runtimeStatus: report.runtimeStatus, seconds: report.runtime?.recognitionSeconds, wall: attempt.adapterWallSeconds, anomalies: report.anomalyCount, error });
  return attempt;
}
if (mode === 'all' || mode === 'recognition') {
  const profiles = process.argv[4] ? process.argv[4].split(',') : ['bench-native-async', 'bench-pinned-ts2', 'bench-pinned-ts4'];
  for (const profile of profiles) {
    const canary = await run(profile, 'canary', 1);
    if (canary.report.status !== 'pass' || canary.report.runtimeStatus !== 'pass') { blockProfile(profile, '同源90秒真实窗口未通过；保留原始输出，不原样进入整片。', canary.report.runtimeStatus !== 'pass' ? 'failed' : 'content-review-needed'); continue; }
    const rounds = [];
    for (const round of [1, 2]) {
      const attempt = await run(profile, 'full', round); rounds.push(attempt);
      if (attempt.report.status !== 'pass' || attempt.report.runtimeStatus !== 'pass') { blockProfile(profile, '整片质量或运行验收失败；不能挑后续幸存轮。', attempt.report.runtimeStatus !== 'pass' ? 'failed' : 'content-review-needed'); break; }
    }
    const series = assessBenchmarkSeries({ attempts: rounds.map(attempt => attempt.report), baselineSeconds: state.baselineSeconds, allAttemptsIncluded: true });
    state.series.push({ profile, ...series }); save(); log({ event: 'series', profile, ...series });
  }
}
if (mode === 'all' || mode === 'pipeline') {
  const controls = [], pipelines = [];
  for (const round of [1, 2]) {
    const control = await run('native30', 'full-control', round); controls.push(control);
    if (control.report.status !== 'pass' || control.report.runtimeStatus !== 'pass') throw Error('稳定对照未通过，暂停流水线计时。');
    const pipeline = await run('bench-native-pipeline', 'full-pipeline', round); pipelines.push(pipeline);
    if (pipeline.report.status !== 'pass' || pipeline.report.runtimeStatus !== 'pass') { blockProfile('bench-native-pipeline', '流水线整片失败，保留原型但不部署为默认。'); break; }
  }
  const valid = pipelines.length === 2 && [...controls, ...pipelines].every(attempt => !attempt.waitedForGpu && attempt.report.status === 'pass' && attempt.report.runtimeStatus === 'pass');
  const avg = values => values.reduce((a, b) => a + b, 0) / values.length;
  const controlWall = avg(controls.map(attempt => attempt.adapterWallSeconds)), pipelineWall = avg(pipelines.map(attempt => attempt.adapterWallSeconds));
  state.pipeline = { status: valid ? 'independent-two-pairs-complete' : 'not-eligible', timingScope: 'cold task start through content/PCM audit after returned complete result, queue-free pairs',
    controlWallSeconds: controls.map(attempt => attempt.adapterWallSeconds), pipelineWallSeconds: pipelines.map(attempt => attempt.adapterWallSeconds),
    controlMedianSeconds: controlWall, pipelineMedianSeconds: pipelineWall, reduction: 1 - pipelineWall / controlWall,
    inferenceScopeUnchanged: 'Recognition times are separately recorded; no preparation gain is relabelled as a neural-kernel speedup.' };
  save(); log({ event: 'pipeline-series', ...state.pipeline });
}
state.completedAt = new Date().toISOString(); save(); log({ event: 'complete', directory: runRoot });
