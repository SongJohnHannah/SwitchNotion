import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { inspectFullRun } from './verify-whole120-repair.mjs';
import { checkWhole120Coverage } from './check-whole120-coverage.mjs';

const require = createRequire(import.meta.url);
const { JENSEN_REFERENCE, assessTranscriptWindows } = require('../src/speech/content-window-gate.cjs');
const { writeAtomicJson } = require('../src/speech/atomic-json.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const variant = 'sm75-native-fp16-accum-v1';
const sampleRate = 16000, offsetSeconds = 1440, durationSeconds = 90;
const offsetSamples = offsetSeconds * sampleRate, windowSamples = durationSeconds * sampleRate;

function inside(base, file) {
  if (typeof file !== 'string' || !file) throw Error('Missing package-relative path');
  const target = path.resolve(base, file), relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Package-relative path escapes its root: ' + file);
  const actual = fs.realpathSync(target), realBase = fs.realpathSync(base), realRelative = path.relative(realBase, actual);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw Error('Resolved package path escapes its root: ' + file);
  return target;
}

function variantFiles(directory) {
  const files = [];
  function visit(relative = '') {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, entry.name), stat = fs.lstatSync(path.join(directory, file));
      if (stat.isSymbolicLink()) throw Error('Runtime variant must contain no symbolic links: ' + file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) files.push({ file: file.replaceAll('\\', '/'), bytes: stat.size, sha256: sha(fs.readFileSync(path.join(directory, file))) });
      else throw Error('Runtime variant contains a non-file entry: ' + file);
    }
  }
  visit();
  return files;
}

function validateManifest(ready, files) {
  const entries = Array.isArray(ready.files) ? ready.files.map(item => [item.file ?? item.path, item.sha256])
    : ready.files && typeof ready.files === 'object' ? Object.entries(ready.files).map(([file, value]) => [file, typeof value === 'string' ? value : value?.sha256]) : [];
  if (!entries.length) throw Error('Runtime READY.json must declare files and SHA256 hashes');
  const actual = new Map(files.map(item => [item.file, item.sha256])), declared = new Set();
  for (const [name, fingerprint] of entries) {
    if (typeof name !== 'string' || path.isAbsolute(name) || name.split(/[\\/]/).some(piece => !piece || piece === '.' || piece === '..')) throw Error('Invalid READY file path');
    const normalized = name.replaceAll('\\', '/');
    if (declared.has(normalized) || !/^[a-f0-9]{64}$/.test(fingerprint || '') || actual.get(normalized) !== fingerprint) throw Error('Runtime READY file hash mismatch: ' + name);
    declared.add(normalized);
  }
  for (const file of actual.keys()) if (file !== 'READY.json' && !declared.has(file)) throw Error('Runtime READY omits a file: ' + file);
  if (!files.some(item => /(?:^|\/)ctranslate2\.dll$/i.test(item.file)) || !files.some(item => /(?:^|\/)_ext[^/]*\.pyd$/i.test(item.file))) throw Error('Runtime variant must contain actual ctranslate2.dll and _ext.pyd');
}

/** Read-only identity of the exact candidate, including every private runtime file. */
export function nativeFp16Identity(bundle, profile) {
  const machine = json(path.join(bundle, 'machine.json')), selected = machine.profiles?.[profile];
  if (!selected) throw Error('Unknown operator profile: ' + profile);
  if (['failed', 'content-review-needed', 'rejected'].includes(selected.status)) throw Error('Refusing a rejected profile; use a new immutable candidate');
  if (machine.model !== 'large-v3-turbo') throw Error('The Jensen canary requires the same large-v3-turbo model');
  const planFile = inside(bundle, selected.planFile), plan = json(planFile);
  if (plan.runtimeVariant !== variant || !/^[a-f0-9]{64}$/.test(plan.runtimeRevision || '')) throw Error('Require the new private FP16 accumulation variant with a pinned runtimeRevision');
  if (plan.computeType !== 'float16' || plan.launchBlocking !== true || plan.beamSize !== 1 || plan.batchSize !== 1 ||
      plan.chunkSeconds !== 30 || plan.resetEveryChunks !== 0 || plan.nativeWholeWindow === true || plan.shortEncoder === true ||
      plan.gpuEncoderBridge === true || plan.timestampedBatch === true || (plan.windowMode && plan.windowMode !== 'legacy')) throw Error('The canary requires the stable Native30 FP16 synchronous single-candidate path');
  const resourcesRoot = inside(bundle, machine.resourcesRoot), variantDirectory = inside(resourcesRoot, 'speech/gpu-v1/variants/' + variant);
  if (fs.lstatSync(variantDirectory).isSymbolicLink()) throw Error('Runtime variant root must not be a symbolic link');
  const files = variantFiles(variantDirectory), readyFile = files.find(file => file.file === 'READY.json');
  if (!readyFile || readyFile.sha256 !== plan.runtimeRevision) throw Error('Runtime READY SHA256 differs from plan.runtimeRevision');
  validateManifest(json(path.join(variantDirectory, 'READY.json')), files);
  const source = machine.originalVideo;
  if (typeof source !== 'string' || !path.isAbsolute(source)) throw Error('machine.originalVideo must be an existing absolute original video');
  const stat = fs.statSync(source);
  if (!stat.isFile() || !stat.size) throw Error('Original video is missing or empty');
  const identity = { profile, selected, plan, model: machine.model, modelDirectory: machine.modelDirectory, source,
    sourceIdentity: sha(JSON.stringify([fs.realpathSync(source), stat.size, stat.mtimeMs])),
    files: [...new Set([selected.planFile, selected.entryFile || 'module/src/speech-provider.cjs', 'operator.cjs'])].map(file => ({ file, sha256: sha(fs.readFileSync(inside(bundle, file))) })),
    runtime: { variant, directory: path.relative(bundle, variantDirectory).replaceAll('\\', '/'), readySha256: readyFile.sha256, files } };
  return { sha256: sha(JSON.stringify(identity)), value: identity };
}

function writeWave(file, data) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]), { flag: 'wx', flush: true });
}

/** One fresh 90s call. No full-run continuation, profile edits, or reference-text prompt. */
export async function probeNativeFp16({ bundle, profile, runRoot, transcribeFile, expectedReference = JENSEN_REFERENCE,
  signal, log = value => console.log(JSON.stringify(value)) } = {}) {
  if (typeof profile !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(profile)) throw Error('Pass one explicit --profile');
  bundle = path.resolve(bundle || 'D:/迅雷下载/notionSwitch/GPU转写算子');
  runRoot = path.resolve(runRoot || path.join(bundle, 'experiments/native-fp16', 'probe-' + new Date().toISOString().replace(/[:.]/g, '-')));
  const relative = path.relative(path.join(bundle, 'experiments/native-fp16'), runRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Probe directory must be a fresh child of bundle/experiments/native-fp16');
  fs.mkdirSync(path.dirname(runRoot), { recursive: true }); fs.mkdirSync(runRoot);
  const directory = path.join(runRoot, profile + '-canary-1'); fs.mkdirSync(directory);
  const state = { version: 1, mode: 'native-fp16-canary-only', createdAt: new Date().toISOString(), runRoot, profile,
    baselineSeconds: [193.326, 194.858], inferenceThresholdSeconds: 180.50556,
    controls: { range: { start: offsetSeconds, end: offsetSeconds + durationSeconds }, windowSeconds: [15, 30],
      minimumSamples: windowSamples, comparison: 'Only compare another same 90-second window with the same raw engine-ready timing scope.',
      fullQualityProven: false, fullSpeedProven: false, automaticFullRun: false, automaticPromotion: false,
      limitation: 'Canary PASS proves only this input window, actual worker/input checks and named phone anchors. Whole-video quality, two-round stability and 50% speed are not yet proven.' },
    attempts: [], series: [], active: { profile, phase: 'canary', round: 1, directory, startedAt: new Date().toISOString() } };
  const save = () => writeAtomicJson(path.join(runRoot, 'state.json'), state);
  await save();
  const started = performance.now();
  let result, report, error, identityBefore, identityAfter, waitedForGpu = false, apiStartedAt, apiReturnedAt;
  try {
    signal?.throwIfAborted();
    identityBefore = nativeFp16Identity(bundle, profile); state.candidateIdentity = identityBefore;
    state.source = identityBefore.value.source;
    const referenceDirectory = path.join(bundle, 'validation/round-1'); state.referenceDirectory = referenceDirectory;
    const reference = json(path.join(referenceDirectory, 'checkpoint.json'));
    const referenceText = json(path.join(referenceDirectory, 'result.json')).text;
    const referencePcm = fs.readFileSync(path.join(referenceDirectory, 'audio.s16le'));
    if (referencePcm.length !== expectedReference.totalSamples * 2 || sha(referencePcm) !== expectedReference.pcmSha256 ||
        typeof referenceText !== 'string' || sha(referenceText) !== expectedReference.textSha256 || reference.totalSamples !== expectedReference.totalSamples) throw Error('Original Jensen V1 PCM/reference fingerprint changed');
    const data = referencePcm.subarray(offsetSamples * 2, (offsetSamples + windowSamples) * 2);
    if (data.length !== windowSamples * 2) throw Error('Original reference does not contain the entire 1440–1530s window');
    const canaryFile = path.join(runRoot, 'jensen-1440-1530.wav'), pcmSha256 = sha(data);
    writeWave(canaryFile, data);
    state.input = { source: canaryFile, originalStartSample: offsetSamples, originalEndSample: offsetSamples + windowSamples,
      samples: windowSamples, bytes: data.length, pcmSha256, wavSha256: sha(fs.readFileSync(canaryFile)),
      referencePcmSha256: expectedReference.pcmSha256, sampleRate, encoding: 'PCM16 mono; exact original byte slice, no resampling or seeded reference words' };
    await save(); log({ event: 'start', ...state.active, candidateIdentity: identityBefore.sha256, inputPcmSha256: pcmSha256 });
    const invoke = transcribeFile || require(path.join(bundle, 'operator.cjs')).transcribeFile;
    if (typeof invoke !== 'function') throw Error('Bundle operator is missing transcribeFile');
    apiStartedAt = performance.now();
    result = await invoke({ source: canaryFile, outputDirectory: directory, language: 'en', profile, allowExperimental: true, signal,
      onProgress: value => { if (value.stage === 'waiting-gpu') waitedForGpu = true; log({ event: 'progress', profile, ...value }); } });
    apiReturnedAt = performance.now();
    await writeAtomicJson(path.join(directory, 'operator-return.json'), result);
    const referenceWindowText = reference.parts.filter(part => part.startSample >= offsetSamples && part.startSample + part.samples <= offsetSamples + windowSamples)
      .map(part => part.text.trim()).filter(Boolean).join('\n');
    const inputAudit = inspectFullRun({ directory, expectedReference: { totalSamples: windowSamples, pcmSha256 }, referenceText: referenceWindowText });
    const checkpoint = json(path.join(directory, 'checkpoint.json')), diskResult = json(path.join(directory, 'result.json'));
    const events = fs.readFileSync(path.join(directory, 'raw-results.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const rawStart = events.find(event => event.event === 'start'), rawComplete = events.find(event => event.event === 'complete');
    const recognitionSeconds = rawStart && rawComplete ? (Date.parse(rawComplete.at) - Date.parse(rawStart.at)) / 1000 : null;
    for (const key of ['complete', 'device', 'recoveries', 'nativeExits', 'totalSamples', 'text']) if (result?.[key] !== diskResult[key]) inputAudit.runtimeIssues.push('operator-return-differs-from-result-' + key);
    if (rawStart?.totalSamples !== windowSamples || rawComplete?.totalSamples !== windowSamples || !(recognitionSeconds > 0)) inputAudit.runtimeIssues.push('raw-start-or-complete-not-full-window-positive-time');
    if (diskResult.plan?.runtimeVariant !== variant || diskResult.plan?.runtimeRevision !== identityBefore.value.plan.runtimeRevision) inputAudit.runtimeIssues.push('actual-result-runtime-not-the-pinned-new-variant');
    const parts = checkpoint.parts.map(part => ({ ...part, startSample: part.startSample + offsetSamples,
      segments: (part.segments || []).map(segment => ({ ...segment, start: segment.start + offsetSeconds, end: segment.end + offsetSeconds })) }));
    report = assessTranscriptWindows({ referenceParts: reference.parts, candidateParts: parts, totalSamples: expectedReference.totalSamples,
      pcmBuffer: referencePcm, range: { start: offsetSeconds, end: offsetSeconds + durationSeconds }, windowSeconds: [15, 30] });
    const namedCoverage = checkWhole120Coverage({ directory, offsetSeconds });
    await writeAtomicJson(path.join(directory, 'named-coverage.json'), namedCoverage);
    const phone = namedCoverage.checks.find(check => check.id === '1470-1500-phone');
    const hardFailureReasons = [...inputAudit.inputIssues, ...inputAudit.runtimeIssues];
    if (phone?.status !== 'PASS' || namedCoverage.integrityIssues.length) hardFailureReasons.push('phone-regression-or-segment-integrity-gate-failed');
    if (report.status !== 'pass') hardFailureReasons.push('fixed15-30-content-window-gate-failed');
    report = { ...report, namedCoverage, actualInputAndWorkerAudit: inputAudit, hardFailureReasons,
      identityIssues: inputAudit.inputIssues, automaticPromotion: false, controls: state.controls,
      runtime: { complete: diskResult.complete === true, device: diskResult.device, recoveries: diskResult.recoveries,
        nativeExits: diskResult.nativeExits, errors: events.filter(event => ['error', 'failed'].includes(event.event)).length,
        fresh: rawStart?.resumedChunks === 0, workerPids: inputAudit.workerPids, recognitionSeconds },
      runtimeStatus: inputAudit.runtimeIssues.length || inputAudit.inputIssues.length ? 'runtime-review' : 'pass',
      status: hardFailureReasons.length ? 'content-review' : 'pass' };
  } catch (failure) {
    error = failure.message;
    report = { ...(report || {}), status: 'runtime-review', runtimeStatus: 'runtime-review', error,
      failure: { name: failure.name, code: failure.code || null, stack: failure.stack }, automaticPromotion: false, controls: state.controls };
  }
  if (identityBefore) {
    try {
      identityAfter = nativeFp16Identity(bundle, profile);
      if (identityAfter.sha256 !== identityBefore.sha256) throw Error('Candidate profile/runtime identity changed during canary');
    } catch (failure) {
      // Even a mismatched READY declaration must retain the actual after-call
      // hashes, rather than dropping precisely the evidence of a mutation.
      try { state.candidateIdentityAfterFailure = { error: failure.message,
        runtimeFiles: variantFiles(inside(bundle, identityBefore.value.runtime.directory)) }; }
      catch (snapshotFailure) { state.candidateIdentityAfterFailure = { error: failure.message, snapshotError: snapshotFailure.message }; }
      error = [error, failure.message].filter(Boolean).join('; ');
      report = { ...report, status: 'runtime-review', runtimeStatus: 'runtime-review', error,
        identityIssues: [...(report.identityIssues || []), 'candidate-identity-changed-during-call'] };
    }
  }
  state.candidateIdentityAfter = identityAfter || null;
  const attempt = { ...state.active, endedAt: new Date().toISOString(), adapterWallSeconds: (performance.now() - started) / 1000,
    apiCallSeconds: apiReturnedAt ? (apiReturnedAt - apiStartedAt) / 1000 : null,
    timingScope: 'adapterWallSeconds includes input preparation, candidate hashing, operator call and all post-run audits; raw recognitionSeconds is separate.',
    waitedForGpu, complete: result?.complete === true, report, error: error || null,
    candidateIdentityBefore: identityBefore?.sha256 || null, candidateIdentityAfter: identityAfter?.sha256 || null };
  await writeAtomicJson(path.join(directory, 'quality-report.json'), report);
  state.attempts.push(attempt); state.active = null; state.completedAt = new Date().toISOString();
  state.status = report.status === 'pass' && report.runtimeStatus === 'pass' && !error ? 'pass' : 'failed';
  await save();
  log({ event: 'complete', status: state.status, profile, directory: runRoot, recognitionSeconds: report.runtime?.recognitionSeconds,
    fullQualityProven: false, automaticFullRun: false, error: error || null });
  return state;
}

async function main() {
  const values = {}, args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (!['--profile', '--bundle'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) throw Error('Usage: --profile PROFILE --bundle BUNDLE');
    const flag = args[index].slice(2); if (values[flag]) throw Error('Duplicate --' + flag); values[flag] = args[++index];
  }
  if (!values.profile || !values.bundle) throw Error('Usage: --profile PROFILE --bundle BUNDLE');
  const controller = new AbortController();
  const cancel = () => controller.abort(Error('Native FP16 canary cancelled'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { const state = await probeNativeFp16({ ...values, signal: controller.signal }); process.exitCode = state.status === 'pass' ? 0 : 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
