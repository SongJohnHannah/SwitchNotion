import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { baselinePlanId, buildSpeedLeaderboard, updateGpuLeaderboard } from '../scripts/gpu-leaderboard.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceIdentity = 'a'.repeat(64);
function plan(id) { return { id, computeType: 'float16', allocator: 'cub_caching', fp16Gemm: false, chunkSeconds: 10, resetEveryChunks: 0, runtimeVariant: 'pinned-cudnn', launchBlocking: true, beamSize: 1, runtimeRevision: '', languageOverride: null, batchSize: 1 }; }
function run(key, seconds, order, extra = {}) {
  const start = new Date(Date.UTC(2026, 10, 6) + order * 1000000), end = new Date(start.getTime() + seconds * 1000);
  return { groupKey: key, plan: plan(key === 'baseline' ? baselinePlanId : key), model: { id: 'large-v3-turbo', directory: 'D:/models/large-v3-turbo' },
    policy: 'stable-gpu-v1-greedy', sourceIdentity, outputDirectory: '/run/' + key + '-' + order, status: 'valid', seconds,
    startAt: start.toISOString(), completeAt: end.toISOString(), evidenceId: key + '-' + order, totalSamples: 44896597, audioSeconds: 2806.0373125,
    transcriptSha256: hash(key + order), issues: [], ...extra };
}
const failure = (key, order) => run(key, 0, order, { status: 'failed', recordedAt: new Date(Date.UTC(2026, 10, 6) + order * 1000000).toISOString(), errorEvents: [{ at: new Date(Date.UTC(2026, 10, 6) + order * 1000000).toISOString(), error: 'CUDA out of memory' }], failingAudioSeconds: 2480, acceptedAudioSeconds: 2480 });

test('single-pass anchor retains its exact seven-percent target, but a failed repeat never becomes champion', () => {
  const runs = [run('baseline', 609.089, 1), failure('baseline', 2)];
  const board = buildSpeedLeaderboard(runs);
  assert.equal(board.baseline.seconds, 609.089); assert.equal(board.nextPromotionThresholdSeconds, 566.45277);
  assert.equal(board.baseline.status, 'single-pass-recheck-failed'); assert.equal(board.champion, null);
  const later = buildSpeedLeaderboard([...runs, run('baseline', 400, 3), run('baseline', 390, 4)]);
  assert.equal(later.methods[0].status, 'unstable'); assert.equal(later.champion, null);
  assert.equal(later.methods[0].validRuns.length, 3); assert.equal(later.methods[0].failures.length, 1);
});

test('only independent two-run medians can promote, and below-seven-percent improvements stay recorded', () => {
  const runs = [run('baseline', 609.089, 1), run('baseline', 610.911, 2), run('single-fast', 100, 3), run('small-gain', 570, 4), run('small-gain', 570, 5)];
  const board = buildSpeedLeaderboard(runs);
  assert.equal(board.champion.key, 'baseline'); assert.equal(board.champion.medianSeconds, 610);
  assert.equal(board.methods.find(method => method.key === 'single-fast').status, 'pending-repeat');
  assert.equal(board.methods.find(method => method.key === 'small-gain').status, 'stable-two-runs');
  assert.equal(board.methods.find(method => method.key === 'small-gain').promotionDecision.promoted, false);
  const promoted = buildSpeedLeaderboard([...runs, run('winner', 560, 6), run('winner', 560, 7), run('exact-seven', 520.8, 8), run('exact-seven', 520.8, 9)]);
  assert.equal(promoted.champion.key, 'exact-seven'); assert.deepEqual(promoted.champion.twoRunSeconds, [520.8, 520.8]);
  assert.deepEqual(promoted.championHistory.map(event => event.type), ['baseline-qualified', 'promoted', 'promoted']);
});

test('scoring uses the first two independent runs rather than choosing two later fast results', () => {
  const board = buildSpeedLeaderboard([run('baseline', 609.089, 1), run('baseline', 610.911, 2), run('candidate', 600, 3), run('candidate', 600, 4), run('candidate', 1, 5), run('candidate', 1, 6)]);
  const candidate = board.methods.find(method => method.key === 'candidate');
  assert.equal(candidate.medianSeconds, 600); assert.deepEqual(candidate.allRunSeconds, [600, 600, 1, 1]); assert.equal(board.champion.key, 'baseline');
  const copied = buildSpeedLeaderboard([run('baseline', 609.089, 1), run('baseline', 609.089, 2, { evidenceId: 'baseline-1' })]);
  assert.equal(copied.champion, null); assert.equal(copied.methods[0].status, 'pending-repeat');
});

test('later same-configuration failure withdraws a champion and keeps its promotion history', () => {
  const runs = [run('baseline', 609.089, 1), run('baseline', 610.911, 2), run('winner', 560, 3), run('winner', 560, 4)];
  const before = buildSpeedLeaderboard(runs); assert.equal(before.champion.key, 'winner');
  const after = buildSpeedLeaderboard([...runs, failure('winner', 5)], { previousHistory: before.championHistory });
  assert.equal(after.champion.key, 'baseline'); assert.equal(after.methods.find(method => method.key === 'winner').status, 'unstable');
  assert.ok(after.championHistory.some(event => event.type === 'promoted' && event.champion.key === 'winner'));
  assert.ok(after.championHistory.some(event => event.type === 'withdrawn' && event.key === 'winner'));
});

test('large transcript shrinkage requires content review while small ASR differences remain eligible', () => {
  const runs = [run('baseline', 609.089, 1, { characters: 1000, wordCount: 200 }), failure('baseline', 2),
    run('short', 200, 3, { characters: 840, wordCount: 190 }), run('short', 200, 4, { characters: 840, wordCount: 190 }),
    run('normal-difference', 550, 5, { characters: 990, wordCount: 198 }), run('normal-difference', 550, 6, { characters: 995, wordCount: 199 })];
  const board = buildSpeedLeaderboard(runs), short = board.methods.find(method => method.key === 'short');
  assert.equal(short.status, 'content-review-needed'); assert.equal(short.failures.length, 0); assert.equal(short.qualityReviews.length, 2);
  assert.equal(board.champion.key, 'normal-difference');
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-leaderboard-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const source = path.join(directory, 'source.wav'); fs.writeFileSync(source, 'same-original-source');
  const inputFile = path.join(directory, 'queue-input.json'); fs.writeFileSync(inputFile, JSON.stringify({ source, language: 'auto', expectedDuration: 21 }));
  const stat = fs.statSync(source), identity = hash(JSON.stringify([fs.realpathSync(source), stat.size, stat.mtimeMs]));
  return { directory, source, inputFile, identity };
}
function proof(f, id, order, seconds, { error = false } = {}) {
  const outputDirectory = path.join(f.directory, 'runs', id + '-' + order); fs.mkdirSync(outputDirectory, { recursive: true });
  const executionPlan = plan(id), startAt = new Date(Date.UTC(2026, 10, 6) + order * 1000000).toISOString(), completeAt = new Date(Date.parse(startAt) + seconds * 1000).toISOString();
  const parts = [[0, 10], [10, 10], [20, 1]].map(([start, duration], index) => ({ index, startSample: start * 16000, samples: duration * 16000, text: 'spoken segment ' + index, device: 'cuda' }));
  const text = parts.map(part => part.text).join('\n'), transcriptSha256 = hash(text);
  const transcriptFile = path.join(outputDirectory, 'transcript.txt'), checkpointFile = path.join(outputDirectory, 'checkpoint.json'), eventsFile = path.join(outputDirectory, 'raw-results.jsonl');
  fs.writeFileSync(path.join(outputDirectory, 'audio.s16le'), Buffer.alloc(21 * 16000 * 2)); fs.writeFileSync(path.join(outputDirectory, 'audio-source.json'), JSON.stringify({ sourceIdentity: f.identity }));
  fs.writeFileSync(checkpointFile, JSON.stringify({ parts, plan: executionPlan, policy: 'stable-gpu-v1-greedy', language: 'auto', sourceIdentity: f.identity })); fs.writeFileSync(transcriptFile, text + '\n');
  const events = [{ event: 'start', at: startAt, resumedChunks: 0, device: 'cuda', sourceIdentity: f.identity, runtime: { modelDirectory: 'D:/models/large-v3-turbo' } }, ...parts.map(part => ({ event: 'result', at: startAt, index: part.index, device: 'cuda', result: { text: part.text }, workerPid: 1000 + order })),
    ...(error ? [{ event: 'error', at: completeAt, error: 'CUDA out of memory', startSample: 160000 }] : []), { event: 'complete', at: completeAt, totalSamples: 21 * 16000, totalChunks: 3, transcriptSha256 }];
  fs.writeFileSync(eventsFile, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const result = { version: 1, policy: 'stable-gpu-v1-greedy', plan: executionPlan, sourceIdentity: f.identity, device: 'cuda', complete: true, recoveries: 0, nativeExits: 0, totalSamples: 21 * 16000, duration: 21, chunks: 3, text, transcriptSha256, transcriptFile, eventsFile, checkpointFile };
  fs.writeFileSync(path.join(outputDirectory, 'result.json'), JSON.stringify(result));
  return { outputDirectory, result, eventsFile, transcriptFile };
}

test('real file audit uses raw ready-to-complete timing and excludes hashes, raw errors, and cross-directory proof copies', async t => {
  const f = fixture(t), baseline = proof(f, baselinePlanId, 1, 609.089);
  let board = await updateGpuLeaderboard({ inputFile: f.inputFile }); assert.equal(board.baseline.seconds, 609.089); assert.equal(board.champion, null);
  const corrupt = proof(f, 'invalid-hash', 2, 500); fs.writeFileSync(corrupt.transcriptFile, 'tampered output');
  proof(f, 'raw-error', 3, 490, { error: true });
  const copy = path.join(f.directory, 'runs', 'copy-pointer'); fs.mkdirSync(copy); fs.copyFileSync(path.join(baseline.outputDirectory, 'result.json'), path.join(copy, 'result.json')); fs.copyFileSync(baseline.eventsFile, path.join(copy, 'raw-results.jsonl'));
  board = await updateGpuLeaderboard({ inputFile: f.inputFile });
  assert.equal(board.runs.find(run => run.outputDirectory === corrupt.outputDirectory).status, 'invalid');
  assert.equal(board.runs.find(run => run.plan.id === 'raw-error').status, 'invalid');
  assert.ok(board.runs.find(run => run.outputDirectory === copy).issues.some(issue => issue.includes('其他运行目录')));
  assert.ok(fs.existsSync(path.join(f.directory, 'LEADERBOARD.md'))); assert.equal(board.champion, null);
});

test('an active atomic-writer lock makes another updater skip without GPU work or file clobbering', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.directory, '.leaderboard.lock'), JSON.stringify({ pid: process.pid }));
  const result = await updateGpuLeaderboard({ inputFile: f.inputFile }); assert.equal(result.skipped, 'leaderboard-update-in-progress');
  assert.equal(fs.existsSync(path.join(f.directory, 'leaderboard.json')), false);
});

test('a local missing-speech review blocks a fast repeat even when all audio and transcript hashes pass', async t => {
  const f = fixture(t);
  proof(f, baselinePlanId, 1, 609.089);
  const first = proof(f, 'fast-with-local-gap', 2, 100);
  const second = proof(f, 'fast-with-local-gap', 3, 100);
  for (const run of [first, second]) fs.writeFileSync(path.join(run.outputDirectory, 'quality-review.json'), JSON.stringify({
    status: 'content-review-needed', transcriptSha256: run.result.transcriptSha256,
    issues: ['30 seconds of audible conversation reduced to one word'],
  }));
  const board = await updateGpuLeaderboard({ inputFile: f.inputFile });
  const method = board.methods.find(method => method.plan.id === 'fast-with-local-gap');
  assert.equal(method.status, 'content-review-needed');
  assert.equal(method.failures.length, 0);
  assert.equal(method.qualityReviews.length, 2);
  assert.equal(board.champion, null);
});
