const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const JENSEN_REFERENCE = Object.freeze({
  textSha256: 'd5e26d3b8a829eb19573809dd8c3b2eb5f6e94182ee2057a12115c184a68d113',
  pcmSha256: 'c42d69c8317656aae25a3edbd9ee8c9df402b07c89bbad4b2ce195a92e7e93bd',
  totalSamples: 44896597,
});
const countText = text => ({
  words: (String(text || '').match(/[\p{L}\p{N}]+/gu) || []).length,
  characters: String(text || '').replace(/\s/gu, '').length,
});
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function fragmentsFromParts(parts, sampleRate) {
  const fragments = [];
  const issues = [];
  const warnings = [];
  for (const part of parts || []) {
    const start = Number(part.startSample) / sampleRate;
    const end = start + Number(part.samples) / sampleRate;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      issues.push({ code: 'invalid-part-interval', index: part.index });
      continue;
    }
    const segments = Array.isArray(part.segments) ? part.segments : [];
    if (!segments.length) {
      fragments.push({ start, end, text: String(part.text || ''), ...countText(part.text) });
      continue;
    }
    let mappedWords = 0;
    let mappedCharacters = 0;
    const partFragments = [];
    let invalidTimestamps = false;
    for (const segment of segments) {
      // Checkpoint segment times are absolute. Clamp to the input owning part:
      // Whisper can emit a final timestamp just beyond that part's PCM boundary.
      const segmentStart = Math.max(start, Number(segment.start));
      const segmentEnd = Math.min(end, Number(segment.end));
      const counts = countText(segment.text);
      mappedWords += counts.words;
      mappedCharacters += counts.characters;
      if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd) || segmentEnd <= segmentStart) {
        if (counts.words) invalidTimestamps = true;
        continue;
      }
      partFragments.push({ start: segmentStart, end: segmentEnd, text: String(segment.text || ''), ...counts });
    }
    const partCounts = countText(part.text);
    // A silently missing segment must not look like a word count match. Permit
    // whitespace/punctuation joining differences; don't permit missing words.
    if (Math.abs(mappedWords - partCounts.words) > 1 || Math.abs(mappedCharacters - partCounts.characters) > 8) {
      issues.push({ code: 'part-segment-text-disagreement', index: part.index,
        partWords: partCounts.words, segmentWords: mappedWords });
    }
    if (invalidTimestamps) {
      // The frozen Native reference itself has two timestamps entirely outside
      // their 30s input part. Retain ALL text using the honest lower-resolution
      // parent interval, rather than silently deleting text or fabricating
      // precise word times at the boundary.
      warnings.push({ code: 'timestamp-fallback-to-owning-part', index: part.index, start, end });
      fragments.push({ start, end, text: String(part.text || ''), ...partCounts });
    } else fragments.push(...partFragments);
  }
  return { fragments, issues, warnings };
}

function measureWindow(fragments, start, end) {
  let words = 0;
  let characters = 0;
  const excerpts = [];
  for (const fragment of fragments) {
    const overlap = Math.min(end, fragment.end) - Math.max(start, fragment.start);
    if (overlap <= 0) continue;
    const weight = overlap / (fragment.end - fragment.start);
    words += fragment.words * weight;
    characters += fragment.characters * weight;
    if (excerpts.join(' ').length < 500) excerpts.push(fragment.text.trim());
  }
  return { words, characters, excerpt: excerpts.join(' ').slice(0, 600) };
}

function measurePcmEnergy(pcmBuffer, start, end, sampleRate, pcmStartSample = 0) {
  if (!pcmBuffer) return null;
  const first = Math.round(start * sampleRate) - pcmStartSample;
  const last = Math.round(end * sampleRate) - pcmStartSample;
  if (first < 0 || last > Math.floor(pcmBuffer.length / 2) || last <= first) return null;
  const frameSamples = Math.max(1, Math.round(sampleRate * 0.02));
  let sum = 0;
  let peak = 0;
  let activeFrames = 0;
  let frames = 0;
  for (let offset = first; offset < last; offset += frameSamples) {
    const frameEnd = Math.min(last, offset + frameSamples);
    let frameSum = 0;
    for (let i = offset; i < frameEnd; i++) {
      const x = pcmBuffer.readInt16LE(i * 2) / 32768;
      frameSum += x * x;
      peak = Math.max(peak, Math.abs(x));
    }
    sum += frameSum;
    frames++;
    if (Math.sqrt(frameSum / (frameEnd - offset)) > 0.006) activeFrames++;
  }
  const rms = Math.sqrt(sum / (last - first));
  const activeFrameFraction = activeFrames / frames;
  return { source: 'pcm16-mono', samples: last - first, rms, peak, activeFrameFraction,
    nearSilent: rms <= 0.0015 && peak <= 0.02 && activeFrameFraction <= 0.02 };
}

function assessTranscriptWindows({ referenceParts, candidateParts, totalSamples,
  sampleRate = 16000, pcmBuffer, pcmStartSample = 0, windowSeconds = [15, 30], range,
  thresholds = {} }) {
  if (!Number.isSafeInteger(totalSamples) || totalSamples <= 0 || !(sampleRate > 0)) {
    throw new TypeError('totalSamples and sampleRate must describe the original PCM timeline');
  }
  const limits = { minReferenceWords: 12, tinyCandidateWords: 3,
    minMissingWords: 15, maxWordRatio: 0.4,
    minReferenceCharacters: 80, minMissingCharacters: 60, maxCharacterRatio: 0.4,
    ...thresholds };
  const reference = fragmentsFromParts(referenceParts, sampleRate);
  const candidate = fragmentsFromParts(candidateParts, sampleRate);
  const duration = totalSamples / sampleRate;
  const from = Math.max(0, range?.start ?? 0);
  const to = Math.min(duration, range?.end ?? duration);
  if (!(to > from)) throw new RangeError('range must intersect the original PCM timeline');
  const windows = [];
  for (const seconds of [...new Set(windowSeconds)]) {
    if (!(Number.isFinite(seconds) && seconds > 0)) throw new TypeError('windowSeconds must be positive');
    // Always anchor to source time zero, so fixed15/30 comparisons remain stable
    // when a benchmark asks for only the known troublesome excerpt.
    for (let index = Math.floor(from / seconds); index * seconds < to; index++) {
      const start = index * seconds;
      const end = Math.min(duration, start + seconds);
      const ref = measureWindow(reference.fragments, start, end);
      const value = measureWindow(candidate.fragments, start, end);
      const wordRatio = ref.words > 0 ? value.words / ref.words : null;
      const characterRatio = ref.characters > 0 ? value.characters / ref.characters : null;
      const reasons = [];
      if (ref.words >= limits.minReferenceWords && value.words <= limits.tinyCandidateWords) reasons.push('near-empty-against-reference');
      if (ref.words - value.words >= limits.minMissingWords && wordRatio < limits.maxWordRatio) reasons.push('local-word-deficit');
      if (ref.characters >= limits.minReferenceCharacters && ref.characters - value.characters >= limits.minMissingCharacters && characterRatio < limits.maxCharacterRatio) reasons.push('local-character-deficit');
      const energy = measurePcmEnergy(pcmBuffer, start, end, sampleRate, pcmStartSample);
      const exempt = reasons.length > 0 && energy?.nearSilent === true;
      windows.push({ start, end, scaleSeconds: seconds, tail: end === duration,
        reference: ref, candidate: value, wordRatio, characterRatio, energy,
        status: reasons.length && !exempt ? 'content-review' : 'pass',
        reasons, exemption: exempt ? 'near-silent-pcm-energy' : null });
    }
  }
  const structureIssues = [
    ...reference.issues.map(issue => ({ ...issue, side: 'reference' })),
    ...candidate.issues.map(issue => ({ ...issue, side: 'candidate' })),
  ];
  const anomalies = windows.filter(window => window.status === 'content-review');
  return { version: 1, status: anomalies.length || structureIssues.length ? 'content-review' : 'pass',
    referenceKind: 'machine-reference-not-human-ground-truth',
    scope: { sampleRate, totalSamples, duration, range: { start: from, end: to }, windowSeconds },
    method: 'Segment word/character totals apportioned by time overlap, clamped to owning PCM part; not word timestamps, WER, or a guarantee of zero omissions.',
    thresholds: limits, structureIssues,
    mappingWarnings: [...reference.warnings.map(value => ({ ...value, side: 'reference' })),
      ...candidate.warnings.map(value => ({ ...value, side: 'candidate' }))],
    anomalyCount: anomalies.length, anomalies, windows };
}

async function readOptionalJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readRun(directory) {
  const result = await readOptionalJson(path.join(directory, 'result.json'));
  const checkpoint = await readOptionalJson(path.join(directory, 'checkpoint.json'));
  let events = [];
  try { events = (await fs.readFile(path.join(directory, 'raw-results.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { directory: path.resolve(directory), result, checkpoint, events };
}

function coversCompletePcm(parts, totalSamples) {
  let position = 0;
  for (const part of parts || []) {
    if (!Number.isSafeInteger(part.startSample) || !Number.isSafeInteger(part.samples) ||
        part.samples <= 0 || part.startSample !== position) return false;
    position += part.samples;
  }
  return position === totalSamples;
}

async function auditRunQuality({ referenceDirectory, candidateDirectory,
  expectedReference = JENSEN_REFERENCE, ...options }) {
  const [reference, candidate, referencePcm, candidatePcm] = await Promise.all([
    readRun(referenceDirectory), readRun(candidateDirectory),
    fs.readFile(path.join(referenceDirectory, 'audio.s16le')),
    fs.readFile(path.join(candidateDirectory, 'audio.s16le')),
  ]);
  const issues = [];
  const referenceTextSha256 = reference.result ? sha256(reference.result.text || '') : null;
  const referencePcmSha256 = sha256(referencePcm);
  const candidatePcmSha256 = sha256(candidatePcm);
  if (referenceTextSha256 !== expectedReference.textSha256) issues.push('reference-text-fingerprint-mismatch');
  if (referencePcmSha256 !== expectedReference.pcmSha256) issues.push('reference-pcm-fingerprint-mismatch');
  if (candidatePcmSha256 !== referencePcmSha256) issues.push('candidate-pcm-fingerprint-mismatch');
  const totalSamples = referencePcm.length / 2;
  if (totalSamples !== expectedReference.totalSamples) issues.push('reference-sample-count-mismatch');
  if (candidate.result?.complete !== true) issues.push('candidate-incomplete');
  if (candidate.result?.totalSamples !== totalSamples || candidate.checkpoint?.totalSamples !== totalSamples) issues.push('candidate-sample-count-mismatch');
  if (!reference.checkpoint?.parts || !candidate.checkpoint?.parts) issues.push('missing-checkpoint-parts');
  if (!coversCompletePcm(reference.checkpoint?.parts, totalSamples)) issues.push('reference-pcm-coverage-gap-or-overlap');
  if (!coversCompletePcm(candidate.checkpoint?.parts, totalSamples)) issues.push('candidate-pcm-coverage-gap-or-overlap');
  const gate = assessTranscriptWindows({ ...options,
    referenceParts: reference.checkpoint?.parts || [], candidateParts: candidate.checkpoint?.parts || [],
    totalSamples, pcmBuffer: referencePcm });
  const runtimeErrors = candidate.events.filter(event => ['error', 'failed'].includes(event.event)).length;
  const start = candidate.events.find(event => event.event === 'start');
  const complete = candidate.events.findLast(event => event.event === 'complete');
  const workerPids = [...new Set(candidate.events.filter(event => event.event === 'result').map(event => event.workerPid || event.result?.workerPid).filter(Boolean))];
  const runtime = { complete: candidate.result?.complete === true, device: candidate.result?.device,
    errors: runtimeErrors, recoveries: candidate.result?.recoveries ?? null,
    nativeExits: candidate.result?.nativeExits ?? null, fresh: start ? start.resumedChunks === 0 : false,
    workerPids, recognitionSeconds: start && complete ? (Date.parse(complete.at) - Date.parse(start.at)) / 1000 : null };
  return { ...gate, status: issues.length || gate.status === 'content-review' ? 'content-review' : 'pass',
    auditedAt: new Date().toISOString(), referenceDirectory: reference.directory, candidateDirectory: candidate.directory,
    identityIssues: issues, fingerprints: { referenceTextSha256, referencePcmSha256, candidatePcmSha256 }, runtime,
    runtimeStatus: runtime.complete && runtime.device === 'cuda' && runtime.errors === 0 && runtime.recoveries === 0 && runtime.nativeExits === 0 ? 'pass' : 'runtime-review' };
}

const median = values => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
function assessBenchmarkSeries({ attempts, baselineSeconds, minimumImprovement = 0.07, minimumRounds = 2, allAttemptsIncluded = false }) {
  const reasons = [];
  if (!allAttemptsIncluded) reasons.push('all-attempts-manifest-required');
  if (!Array.isArray(attempts) || attempts.length < minimumRounds) reasons.push('insufficient-independent-rounds');
  const rounds = attempts || [];
  const pids = new Set();
  for (const [index, report] of rounds.entries()) {
    const runtime = report.runtime || {};
    if (report.status !== 'pass' || report.runtimeStatus !== 'pass' || !runtime.fresh ||
        !(runtime.recognitionSeconds > 0) || runtime.workerPids?.length !== 1) reasons.push(`round-${index + 1}-not-fresh-zero-error-quality-pass`);
    for (const pid of runtime.workerPids || []) {
      if (pids.has(pid)) reasons.push(`round-${index + 1}-reused-worker-pid`);
      pids.add(pid);
    }
  }
  if (!Array.isArray(baselineSeconds) || baselineSeconds.length < 2 || baselineSeconds.some(value => !(value > 0))) throw new TypeError('baselineSeconds requires at least two positive measured times');
  const baselineMedianSeconds = median(baselineSeconds);
  const times = rounds.map(report => report.runtime?.recognitionSeconds);
  const candidateMedianSeconds = times.length && times.every(value => value > 0) ? median(times) : null;
  const improvement = candidateMedianSeconds ? 1 - candidateMedianSeconds / baselineMedianSeconds : null;
  if (improvement === null || improvement < minimumImprovement) reasons.push('speed-improvement-below-threshold');
  return { version: 1, status: reasons.length ? 'not-eligible' : 'eligible', reasons,
    attempts: rounds.length, baselineMedianSeconds, candidateMedianSeconds, improvement, minimumImprovement,
    timingScope: 'engine-ready-to-final-transcript; preparation/model loading excluded',
    note: 'Supply every attempt of the same frozen candidate revision, including failed attempts; a passing survivor cannot erase an earlier failure.' };
}

module.exports = { JENSEN_REFERENCE, countText, fragmentsFromParts, measurePcmEnergy,
  assessTranscriptWindows, auditRunQuality, assessBenchmarkSeries };
