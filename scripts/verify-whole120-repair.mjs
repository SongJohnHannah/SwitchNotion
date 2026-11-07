import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { checkWhole120Coverage } from './check-whole120-coverage.mjs';

const require = createRequire(import.meta.url);
const { auditRunQuality, JENSEN_REFERENCE } = require('../src/speech/content-window-gate.cjs');
const { writeAtomicJson } = require('../src/speech/atomic-json.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const median = values => { const ordered = [...values].sort((a, b) => a - b); return ordered.length ? (ordered[Math.floor((ordered.length - 1) / 2)] + ordered[Math.floor(ordered.length / 2)]) / 2 : null; };
const namedIds = ['94-short-clause', '2274-honest-agreement', '2732-full-question', '2790-tail-appreciation', '1470-1500-phone'];
const sourceIdentity = source => { const stat = fs.statSync(source); return sha(JSON.stringify([fs.realpathSync(source), stat.size, stat.mtimeMs])); };

function inside(bundle, file) {
  if (typeof file !== 'string') throw Error('Missing frozen candidate file');
  const target = path.resolve(bundle, file), relative = path.relative(bundle, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Candidate path must stay inside the bundle');
  return target;
}

function candidateIdentity(bundle, profile) {
  const machine = read(path.join(bundle, 'machine.json'));
  const selected = machine.profiles?.[profile];
  if (!selected) throw Error('Unknown operator profile: ' + profile);
  if (['failed', 'content-review-needed', 'rejected'].includes(selected.status)) throw Error('Refusing a previously rejected profile; use a distinct frozen repair candidate');
  if (machine.model !== 'large-v3-turbo') throw Error('Repair verification requires the same large-v3-turbo model');
  const files = [selected.planFile, selected.entryFile || 'module/src/speech-provider.cjs', 'operator.cjs'];
  const value = { profile, selected, model: machine.model, modelDirectory: machine.modelDirectory,
    source: machine.originalVideo, sourceIdentity: sourceIdentity(machine.originalVideo),
    files: files.map(file => ({ file, sha256: sha(fs.readFileSync(inside(bundle, file))) })) };
  return { value, sha256: sha(JSON.stringify(value)) };
}

/** Independent file/PCM/worker checks. Does no recognition and changes no raw data. */
export function inspectFullRun({ directory, expectedReference = JENSEN_REFERENCE, referenceText }) {
  const result = read(path.join(directory, 'result.json'));
  const checkpoint = read(path.join(directory, 'checkpoint.json'));
  const events = fs.readFileSync(path.join(directory, 'raw-results.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const pcm = fs.readFileSync(path.join(directory, 'audio.s16le'));
  const inputIssues = [], runtimeIssues = [];
  if (pcm.length !== expectedReference.totalSamples * 2) inputIssues.push('decoded-pcm-sample-count-mismatch');
  if (sha(pcm) !== expectedReference.pcmSha256) inputIssues.push('decoded-pcm-sha256-mismatch');
  if (result.totalSamples !== expectedReference.totalSamples || checkpoint.totalSamples !== expectedReference.totalSamples) inputIssues.push('result-or-checkpoint-sample-count-mismatch');
  if (result.complete !== true || result.device !== 'cuda') runtimeIssues.push('not-complete-cuda');
  for (const key of ['recoveries', 'nativeExits']) if (result[key] !== 0) runtimeIssues.push(key + '-not-explicitly-zero');
  const starts = events.filter(event => event.event === 'start'), completes = events.filter(event => event.event === 'complete');
  if (starts.length !== 1 || starts[0].resumedChunks !== 0 || completes.length !== 1) runtimeIssues.push('not-one-fresh-start-and-complete');
  if (events.some(event => ['error', 'failed', 'recovery', 'native-exit', 'worker-exit'].includes(event.event))) runtimeIssues.push('raw-runtime-error-recovery-or-exit');
  const results = events.filter(event => event.event === 'result');
  const parts = checkpoint.parts || [];
  if (!parts.length || parts.length !== results.length) inputIssues.push('missing-or-unmatched-request-parts');
  let at = 0;
  const actualPids = [];
  parts.forEach((part, index) => {
    if (part.index !== index || part.startSample !== at || !Number.isSafeInteger(part.samples) || part.samples <= 0) inputIssues.push('non-contiguous-part-' + index);
    if (part.device !== 'cuda') runtimeIssues.push('part-not-cuda-' + index);
    at += part.samples || 0;
    const raw = results[index];
    if (!raw || raw.index !== index || raw.startSample !== part.startSample || raw.samples !== part.samples) {
      inputIssues.push('raw-part-identity-mismatch-' + index); return;
    }
    // The venv launcher PID is not accepted as proof of the actual CUDA worker.
    const pid = raw.result?.workerPid;
    if (!Number.isSafeInteger(pid) || pid <= 0) runtimeIssues.push('missing-real-worker-pid-' + index);
    else actualPids.push(pid);
    if (Number.isSafeInteger(part.startSample) && Number.isSafeInteger(part.samples) && part.startSample >= 0 &&
        part.samples > 0 && (part.startSample + part.samples) * 2 <= pcm.length) {
      const floats = Buffer.allocUnsafe(part.samples * 4);
      for (let sample = 0; sample < part.samples; sample++) floats.writeFloatLE(pcm.readInt16LE((part.startSample + sample) * 2) / 32768, sample * 4);
      if (raw.pcmSha256 !== sha(floats)) inputIssues.push('actual-float32-request-sha256-mismatch-' + index);
    }
  });
  if (at !== expectedReference.totalSamples) inputIssues.push('part-samples-do-not-cover-full-audio');
  const workerPids = [...new Set(actualPids)];
  if (workerPids.length !== 1 || actualPids.length !== results.length) runtimeIssues.push('not-one-real-worker-throughout-round');
  if (typeof result.text !== 'string') inputIssues.push('missing-original-result-text');
  const text = typeof result.text === 'string' ? result.text : '';
  return { version: 1, inputIssues, runtimeIssues, workerPids, requestCount: results.length,
    totalSamples: at, inputPcmSha256: sha(pcm), canonicalTextSha256: sha(text), referenceTextSha256: sha(referenceText),
    v1ExactTextEquality: text === referenceText, canonicalTextRule: 'UTF-8 bytes of result.text; no trimming, text insertion or whitespace normalization' };
}

export function summarizeRepairSeries(attempts, baselineSeconds = [193.326, 194.858], { speedFirst = false } = {}) {
  const stopped = attempts.some(attempt => attempt.hardFailure);
  const speedStop = attempts.some(attempt => attempt.speedStop);
  const twoRounds = attempts.length === 2 && attempts.every(attempt => attempt.complete && !attempt.hardFailure);
  const review = attempts.some(attempt => attempt.report?.contentStatus === 'pending-independent-content-review');
  const times = attempts.map(attempt => attempt.report?.runtime?.recognitionSeconds);
  const candidateMedianSeconds = times.length && times.every(value => Number.isFinite(value) && value > 0) ? median(times) : null;
  const baselineMedianSeconds = median(baselineSeconds);
  const improvement = candidateMedianSeconds ? 1 - candidateMedianSeconds / baselineMedianSeconds : null;
  const textHashes = attempts.map(attempt => attempt.canonicalTextSha256).filter(Boolean);
  const repeatableText = twoRounds && textHashes.length === 2 && textHashes[0] === textHashes[1];
  return { version: 1, status: stopped ? 'stopped-on-first-failure' : speedStop ? 'stopped-below7%' : !twoRounds ? 'incomplete-functional-verification'
    : review || !repeatableText ? 'pending-independent-content-review' : 'functional-reference-exact-two-rounds',
    functionalStatus: stopped ? 'failed' : !twoRounds ? 'incomplete' : review || !repeatableText
      ? 'pending-independent-content-review' : 'machine-reference-exact-two-rounds',
    attempts: attempts.length, repeatableText, canonicalTextSha256: textHashes, promotionEligible: false, automaticPromotion: false,
    speedFirst, speedStop, speedStopReason: speedStop ? 'below7%' : null,
    speed: { timingScope: 'raw start-to-complete after engine ready; excludes preparation/model load/audits/queue wait',
      baselineSeconds, baselineMedianSeconds, candidateMedianSeconds, improvement, minimumImprovement: .07,
      meetsSevenPercent: twoRounds && improvement !== null && improvement >= .07,
      independentOfFunctionalDecision: true },
    note: 'Named checks and exact machine-reference equality do not establish human WER or zero omissions. No automatic promotion. ' +
      (speedFirst ? 'A first full run slower than 180.50556s is recorded as below7%, not a GPU failure, and does not receive a second run.'
        : 'Slower runs still receive the second planned functional verification.') };
}

/** At most two full runs. Optional speed-first screen never changes GPU policy. */
export async function verifyWhole120Repair({ bundle, profile, runRoot,
  transcribeFile, auditQuality = auditRunQuality, checkCoverage = checkWhole120Coverage,
  expectedReference = JENSEN_REFERENCE, speedFirst = false, signal, log = value => console.log(JSON.stringify(value)) } = {}) {
  if (typeof profile !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(profile)) throw Error('Pass one explicit profile name');
  if (typeof speedFirst !== 'boolean') throw Error('speedFirst must be boolean');
  bundle = path.resolve(bundle || 'D:/迅雷下载/notionSwitch/GPU转写算子');
  const identity = candidateIdentity(bundle, profile), source = identity.value.source;
  if (!path.isAbsolute(source) || !fs.statSync(source).isFile()) throw Error('machine.originalVideo must be the existing absolute original video');
  const referenceDirectory = path.join(bundle, 'validation/round-1');
  const referenceText = read(path.join(referenceDirectory, 'result.json')).text;
  const referencePcm = fs.readFileSync(path.join(referenceDirectory, 'audio.s16le'));
  if (typeof referenceText !== 'string' || sha(referenceText) !== expectedReference.textSha256 ||
      sha(referencePcm) !== expectedReference.pcmSha256 || referencePcm.length !== expectedReference.totalSamples * 2) throw Error('Canonical V1 interview reference changed');
  const parent = path.join(bundle, 'experiments/whole120-repair');
  runRoot = path.resolve(runRoot || path.join(parent, 'full-' + new Date().toISOString().replace(/[:.]/g, '-')));
  if (path.dirname(runRoot) !== parent || !path.basename(runRoot).startsWith('full-')) throw Error('Verification root must be a new whole120-repair/full-* directory');
  fs.mkdirSync(parent, { recursive: true }); fs.mkdirSync(runRoot); // EEXIST rejects resume/survivor selection.
  const stateFile = path.join(runRoot, 'state.json'), eventsFile = path.join(runRoot, 'verification-events.jsonl');
  const state = { version: 1, mode: speedFirst ? 'GPU-speed-search' : 'whole120-repair-functional-first', createdAt: new Date().toISOString(),
    runRoot, source, referenceDirectory, profile, candidateIdentity: identity,
    expectedReference, baselineSeconds: [193.326, 194.858], inferenceThresholdSeconds: 180.50556,
    baselineMedianSeconds: 194.092, speedFirst, speedStop: false, speedStopReason: null,
    inputPreparation: 'verified-existing-pcm-cache', inputPreparationIsColdEndToEnd: false,
    automaticPromotion: false, functionalBeforeSpeed: !speedFirst, hardQualityRequired: true,
    adapterWallTimingScope: 'adapterWallSeconds includes API and subsequent audits; apiWallSeconds and auditWallSeconds are separately recorded',
    attempts: [], active: null, series: [] };
  const save = () => writeAtomicJson(stateFile, state);
  const record = event => { const row = { at: new Date().toISOString(), ...event }; fs.appendFileSync(eventsFile, JSON.stringify(row) + '\n', { flush: true }); log(row); };
  await save();
  // Preseed audio only, before either GPU round. No checkpoints, results or
  // reference words are copied, and each operator start must still resume zero.
  for (const round of [1, 2]) {
    const directory = path.join(runRoot, `${profile}-round-${round}`);
    fs.mkdirSync(directory);
    const target = path.join(directory, 'audio.s16le');
    fs.copyFileSync(path.join(referenceDirectory, 'audio.s16le'), target, fs.constants.COPYFILE_EXCL);
    if (sha(fs.readFileSync(target)) !== expectedReference.pcmSha256) throw Error('Prepared PCM cache hash changed');
    await writeAtomicJson(path.join(directory, 'audio-source.json'), { sourceIdentity: identity.value.sourceIdentity });
    if (fs.readdirSync(directory).sort().join(',') !== 'audio-source.json,audio.s16le') throw Error('Fresh round contains more than audio cache');
  }
  state.preparedPcmSha256 = expectedReference.pcmSha256;
  state.preparedSourceIdentity = identity.value.sourceIdentity; await save();
  const invoke = transcribeFile || (options => require(path.join(bundle, 'operator.cjs')).transcribeFile(options));
  for (const round of [1, 2]) {
    signal?.throwIfAborted();
    const directory = path.join(runRoot, `${profile}-round-${round}`);
    state.active = { profile, phase: 'full', round, directory, startedAt: new Date().toISOString() };
    await save(); record({ event: 'start', ...state.active });
    const before = performance.now(); let returnedAt, result, report, coverage, inspection, error, waited = false;
    const hardReasons = [];
    try {
      if (candidateIdentity(bundle, profile).sha256 !== identity.sha256) throw Error('Frozen candidate configuration or source changed');
      result = await invoke({ source, outputDirectory: directory, language: 'en', profile, allowExperimental: true, signal,
        onProgress: progress => { if (progress.stage === 'waiting-gpu') waited = true; record({ event: 'progress', profile, phase: 'full', round, ...progress }); } });
      returnedAt = performance.now();
      if (!result?.complete || result.device !== 'cuda') throw Error('Operator did not return a complete GPU result; CPU recognition is forbidden');
      inspection = inspectFullRun({ directory, expectedReference, referenceText });
      report = await auditQuality({ referenceDirectory, candidateDirectory: directory, expectedReference });
      coverage = await checkCoverage({ directory });
      hardReasons.push(...inspection.inputIssues, ...inspection.runtimeIssues, ...(report.identityIssues || []));
      const runtime = report.runtime || {};
      if (report.runtimeStatus !== 'pass' || !runtime.complete || runtime.device !== 'cuda' || !runtime.fresh ||
          runtime.errors !== 0 || runtime.recoveries !== 0 || runtime.nativeExits !== 0 || !(runtime.recognitionSeconds > 0)) hardReasons.push('runtime-not-fresh-complete-zero-error-cuda');
      if (state.attempts.some(attempt => attempt.workerPids?.some(pid => inspection.workerPids.includes(pid)))) hardReasons.push('worker-reused-across-independent-rounds');
      if (coverage.status !== 'PASS_NAMED_ANCHORS_ONLY' || coverage.evaluatedChecks !== 5 || coverage.failedChecks?.length ||
          namedIds.some(id => !coverage.checks?.some(check => check.id === id && check.status === 'PASS'))) hardReasons.push('named-five-regression-gate-failed');
      if (candidateIdentity(bundle, profile).sha256 !== identity.sha256) hardReasons.push('frozen-candidate-changed-during-round');
      const needsReview = !inspection.v1ExactTextEquality || report.status !== 'pass';
      report = { ...report, windowAuditStatus: report.status,
        status: hardReasons.length || needsReview ? 'content-review' : 'pass',
        contentStatus: needsReview ? 'pending-independent-content-review' : 'machine-reference-exact',
        actualInputAndWorkerAudit: inspection,
        namedCoverage: { status: coverage.status, failedChecks: coverage.failedChecks, evaluatedChecks: coverage.evaluatedChecks },
        hardFailureReasons: hardReasons, automaticPromotion: false };
      if (inspection.runtimeIssues.length || runtime.device !== 'cuda') report.runtimeStatus = 'runtime-review';
    } catch (failure) {
      returnedAt ??= performance.now(); error = failure.message; hardReasons.push('operator-or-audit-failed: ' + error);
      report = { status: 'runtime-review', runtimeStatus: 'runtime-review', error, hardFailureReasons: hardReasons,
        contentStatus: 'not-certified', runtime: report?.runtime || null, automaticPromotion: false };
    }
    const speedStop = speedFirst && round === 1 && hardReasons.length === 0 && report.runtime?.recognitionSeconds > state.inferenceThresholdSeconds;
    if (speedFirst) report.speedScreen = { baselineMedianSeconds: 194.092, thresholdSeconds: state.inferenceThresholdSeconds,
      recognitionSeconds: report.runtime?.recognitionSeconds ?? null, speedStop,
      reason: speedStop ? 'below7%' : null, speedStopIsHardGpuFailure: false };
    fs.mkdirSync(directory, { recursive: true });
    if (coverage) await writeAtomicJson(path.join(directory, 'named-coverage.json'), coverage);
    await writeAtomicJson(path.join(directory, 'quality-report.json'), report);
    const ended = performance.now();
    const attempt = { ...state.active, endedAt: new Date().toISOString(), complete: result?.complete === true,
      apiWallSeconds: (returnedAt - before) / 1000, auditWallSeconds: (ended - returnedAt) / 1000,
      adapterWallSeconds: (ended - before) / 1000, waitedForGpu: waited,
      canonicalTextSha256: inspection?.canonicalTextSha256 || null, v1ExactTextEquality: inspection?.v1ExactTextEquality ?? null,
      inputPcmSha256: inspection?.inputPcmSha256 || null, totalSamples: inspection?.totalSamples ?? null,
      inputPreparation: 'verified-existing-pcm-cache',
      speedStop, speedStopReason: speedStop ? 'below7%' : null,
      workerPids: inspection?.workerPids || [], namedCoverageFile: coverage ? path.join(directory, 'named-coverage.json') : null,
      hardFailure: hardReasons.length > 0, hardFailureReasons: hardReasons, report, error };
    state.attempts.push(attempt); state.active = null;
    if (speedStop) { state.speedStop = true; state.speedStopReason = 'below7%'; }
    state.series = [{ profile, ...summarizeRepairSeries(state.attempts, state.baselineSeconds, { speedFirst }) }];
    await save(); record({ event: 'finished', profile, phase: 'full', round, hardFailure: attempt.hardFailure,
      contentStatus: report.contentStatus, v1ExactTextEquality: attempt.v1ExactTextEquality,
      rawSeconds: report.runtime?.recognitionSeconds, hardFailureReasons: hardReasons, speedStop, speedStopReason: attempt.speedStopReason });
    if (attempt.hardFailure || speedStop) break; // No third run or survivor selection; speed stop is opt-in only.
  }
  state.completedAt = new Date().toISOString(); await save(); record({ event: 'complete', stateFile, series: state.series });
  return state;
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') { console.log('Usage: node scripts/verify-whole120-repair.mjs --profile PROFILE [--bundle BUNDLE] [--speed-first]'); return; }
    if (args[index] === '--speed-first') { options.speedFirst = true; continue; }
    if (!['--profile', '--bundle'].includes(args[index]) || !args[index + 1]) throw Error('Expected --profile PROFILE [--bundle BUNDLE] [--speed-first]');
    options[args[index].slice(2)] = args[++index];
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(Error('GPU verification cancelled; original records remain.'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const state = await verifyWhole120Repair({ ...options, signal: controller.signal });
    if (state.attempts.some(attempt => attempt.hardFailure) || state.series[0].functionalStatus !== 'machine-reference-exact-two-rounds') process.exitCode = 2;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
