import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { assessTranscriptWindows, measurePcmEnergy, fragmentsFromParts,
  assessBenchmarkSeries, auditRunQuality } = require('../src/speech/content-window-gate.cjs');
const sr = 100;
const segment = (start, end, text) => ({ start, end, text });
const part = (start, end, segments) => ({ startSample: start * sr,
  samples: (end - start) * sr, text: segments.map(value => value.text).join(' '), segments });
const reference = [part(1440, 1470, [segment(1465.67, 1470.31,
  'You see the great thing about life is that Jensen can develop the most common')]),
part(1470, 1500, [
  segment(1470, 1474.64, 'complex computer chip in the world that nobody can copy for 10 years but he cannot figure'),
  segment(1474.64, 1475.88, 'out how to put me on speaker'),
  segment(1480.12, 1481.26, 'Remember this one'),
  segment(1481.92, 1485.62, 'So the AI it is almost as conspiracy'),
  segment(1486.59, 1488.81, 'And the happiest group is China'),
  segment(1488.81, 1490.81, 'And China is very'),
  segment(1490, 1499.73, 'I can even say in the country a lot of states are happy that were not going to get anything because they are being inundated by people that want to be there'),
])];

test('fixed multiscale windows catch B2 Roasted against differently segmented Native reference', () => {
  const candidate = [part(1440, 1500, [segment(1440, 1470, reference[0].text), segment(1470, 1500, 'Roasted.')])];
  const report = assessTranscriptWindows({ referenceParts: reference, candidateParts: candidate,
    sampleRate: sr, totalSamples: 1500 * sr, range: { start: 1470, end: 1500 } });
  assert.equal(report.status, 'content-review');
  assert.equal(report.anomalies.find(value => value.scaleSeconds === 30).candidate.words, 1);
  assert.equal(report.anomalies.find(value => value.scaleSeconds === 30).reference.words,
    reference[1].text.match(/[\p{L}\p{N}]+/gu).length);
  assert.equal(report.referenceKind, 'machine-reference-not-human-ground-truth');
});

test('15 second window catches B4 Roasted even when 30 second aggregate looks less deficient', () => {
  const candidate = [part(1440, 1500, [segment(1440, 1470, reference[0].text),
    segment(1470, 1485, 'Roasted.'), segment(1485, 1500,
      'conspiracy and the happiest group is China and China is very happy and I could even say in the country a lot of states are happy that were not going to get anything because they are being inundated by people that want to be there but now')])];
  const report = assessTranscriptWindows({ referenceParts: reference, candidateParts: candidate,
    sampleRate: sr, totalSamples: 1500 * sr, range: { start: 1470, end: 1500 } });
  assert(report.anomalies.some(value => value.start === 1470 && value.scaleSeconds === 15));
  assert(!report.anomalies.some(value => value.scaleSeconds === 30));
});

test('timestamp overrun is clamped to owning PCM part, not double counted into next window', () => {
  const { fragments } = fragmentsFromParts(reference, sr);
  assert.equal(fragments[0].end, 1470);
  const report = assessTranscriptWindows({ referenceParts: reference, candidateParts: reference,
    sampleRate: sr, totalSamples: 1500 * sr, range: { start: 1470, end: 1500 } });
  assert.equal(report.status, 'pass');
  assert.equal(report.windows.find(value => value.scaleSeconds === 30).reference.words,
    reference[1].text.match(/[\p{L}\p{N}]+/gu).length);
});

test('voiced tail has no automatic exemption; near-silent tail requires actual PCM energy', () => {
  const words = Array.from({ length: 25 }, (_, index) => `word${index}`).join(' ');
  const referenceParts = [part(0, 15, [segment(0, 15, words)])];
  const candidateParts = [part(0, 15, [segment(0, 15, '')])];
  const options = { referenceParts, candidateParts, sampleRate: sr, totalSamples: 1500 };
  assert.equal(assessTranscriptWindows(options).status, 'content-review');
  const voiced = Buffer.alloc(3000);
  for (let i = 0; i < 1500; i++) voiced.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  assert.equal(assessTranscriptWindows({ ...options, pcmBuffer: voiced }).status, 'content-review');
  const silent = assessTranscriptWindows({ ...options, pcmBuffer: Buffer.alloc(3000) });
  assert.equal(silent.status, 'pass');
  assert(silent.windows.every(value => value.exemption === 'near-silent-pcm-energy'));
  assert.equal(measurePcmEnergy(Buffer.alloc(20), 0, 15, sr), null);
});

test('part text absent from timestamped segments is review, not silently accepted', () => {
  const candidate = part(0, 15, [segment(0, 15, 'hello')]);
  candidate.text = 'hello many other words are present only in part text';
  const report = assessTranscriptWindows({ referenceParts: [candidate], candidateParts: [candidate],
    sampleRate: sr, totalSamples: 1500 });
  assert.equal(report.status, 'content-review');
  assert(report.structureIssues.some(issue => issue.code === 'part-segment-text-disagreement'));
});

test('wholly out-of-part timestamps retain all text at honest owning-part resolution', () => {
  const value = part(0, 15, [segment(0, 10, 'hello world'), segment(20, 21, 'you')]);
  const report = assessTranscriptWindows({ referenceParts: [value], candidateParts: [value],
    sampleRate: sr, totalSamples: 1500 });
  assert.equal(report.status, 'pass');
  assert.equal(report.windows[0].reference.words, 3);
  assert(report.mappingWarnings.some(warning => warning.code === 'timestamp-fallback-to-owning-part'));
});

const passed = (pid, seconds) => ({ status: 'pass', runtimeStatus: 'pass',
  runtime: { fresh: true, recognitionSeconds: seconds, workerPids: [pid] } });
test('benchmark requires all attempts, independent fresh rounds, 7% and no selecting surviving runs', () => {
  const spec = { baselineSeconds: [193.326, 194.858], allAttemptsIncluded: true,
    attempts: [passed(1, 125), passed(2, 126)] };
  assert.equal(assessBenchmarkSeries(spec).status, 'eligible');
  assert.equal(assessBenchmarkSeries({ ...spec, allAttemptsIncluded: false }).status, 'not-eligible');
  assert.equal(assessBenchmarkSeries({ ...spec, attempts: [passed(1, 125), passed(1, 126)] }).status, 'not-eligible');
  assert.equal(assessBenchmarkSeries({ ...spec, attempts: [passed(1, 125), passed(2, 126),
    { status: 'content-review', runtimeStatus: 'runtime-review' }] }).status, 'not-eligible');
  assert.equal(assessBenchmarkSeries({ ...spec, attempts: [passed(1, 184), passed(2, 184)] }).status, 'not-eligible');
});

test('real artifact audit rejects different PCM despite equal length and matching transcript', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-content-gate-'));
  try {
    const sha = value => createHash('sha256').update(value).digest('hex');
    const pcm = Buffer.alloc(32000);
    const text = 'hello world';
    const expectedReference = { textSha256: sha(text), pcmSha256: sha(pcm), totalSamples: 16000 };
    for (const name of ['reference', 'candidate']) {
      const directory = path.join(temp, name);
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, 'audio.s16le'), pcm);
      await fs.writeFile(path.join(directory, 'checkpoint.json'), JSON.stringify({ totalSamples: 16000,
        parts: [{ index: 0, startSample: 0, samples: 16000, text, segments: [{ start: 0, end: 1, text }] }] }));
      await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ text, device: 'cuda', complete: true,
        totalSamples: 16000, recoveries: 0, nativeExits: 0 }));
      await fs.writeFile(path.join(directory, 'raw-results.jsonl'), [
        { event: 'start', at: '2026-11-06T00:00:00Z', resumedChunks: 0 },
        { event: 'result', workerPid: 123 },
        { event: 'complete', at: '2026-11-06T00:00:02Z' },
      ].map(JSON.stringify).join('\n'));
    }
    const options = { referenceDirectory: path.join(temp, 'reference'), candidateDirectory: path.join(temp, 'candidate'), expectedReference };
    assert.equal((await auditRunQuality(options)).status, 'pass');
    const altered = Buffer.from(pcm); altered.writeInt16LE(1000, 0);
    await fs.writeFile(path.join(temp, 'candidate', 'audio.s16le'), altered);
    const report = await auditRunQuality(options);
    assert.equal(report.status, 'content-review');
    assert(report.identityIssues.includes('candidate-pcm-fingerprint-mismatch'));
    assert.equal(report.runtimeStatus, 'pass');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
