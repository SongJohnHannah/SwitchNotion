import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSummary, renderRecords, syncOnce } from '../scripts/sync-unified-benchmark-records.mjs';

const attempt = (phase, round, report = { status: 'pass', runtimeStatus: 'pass' }) => ({
  profile: 'candidate', phase, round, directory: `/runs/candidate-${phase}-${round}`,
  startedAt: `2026-11-06T00:00:0${round}Z`, complete: true, report,
});
const state = extra => ({ runRoot: '/runs', baselineSeconds: [193.326, 194.858],
  inferenceThresholdSeconds: 180.50556, attempts: [], series: [], ...extra });

test('passing canary and two fast full attempts never self-promote without eligible state series', () => {
  const summary = buildSummary({ state: state({ attempts: [attempt('canary', 1), attempt('full', 1), attempt('full', 2)],
    series: [{ profile: 'candidate', status: 'not-eligible' }] }), stateFile: '/runs/state.json' });
  const text = renderRecords(summary).board;
  assert(!text.includes('达到7%且双轮'));
  assert(text.includes('90秒 CAN 短测'));
  const qualified = buildSummary({ state: state({ attempts: [attempt('full', 1), attempt('full', 2)],
    series: [{ profile: 'candidate', status: 'eligible' }] }), stateFile: '/runs/state.json' });
  assert(renderRecords(qualified).board.includes('达到7%且双轮'));
  const reviewed = buildSummary({ state: state({ attempts: [attempt('full', 1), attempt('full', 2)],
    series: [{ profile: 'candidate', status: 'eligible' }] }), stateFile: '/runs/state.json',
    profileDecisions: { candidate: { status: 'content-review-needed', reviewReason: 'Independent clause review found omissions' } } });
  const held = renderRecords(reviewed).board;
  assert(!held.includes('达到7%且双轮'));
  assert(held.includes('Independent clause review found omissions'));
});

test('earlier failures survive edited state and later passing rounds; content and runtime stay separate', () => {
  const first = buildSummary({ state: state({ attempts: [attempt('full', 1, { status: 'runtime-review', runtimeStatus: 'runtime-review', error: 'rename EPERM' })] }), stateFile: '/runs/state.json' });
  const next = buildSummary({ state: state({ attempts: [attempt('full', 2, { status: 'content-review', runtimeStatus: 'pass', anomalyCount: 1 })] }),
    stateFile: '/runs/state.json', previous: first });
  assert.equal(next.attempts.length, 2);
  const text = renderRecords(next).pitfalls;
  assert(text.includes('持久化/运行失败'));
  assert(text.includes('内容或固定输入待复核'));
  assert(text.includes('/runs/candidate-full-1'));
  const edited = buildSummary({ state: state({ attempts: [attempt('full', 1)] }), stateFile: '/runs/state.json', previous: next });
  assert.equal(edited.attempts.length, 2);
  assert.equal(edited.attempts.find(value => value.round === 1).history.length, 1);
});

test('pipeline pairs are displayed separately and never compared with raw recognition baseline', () => {
  const summary = buildSummary({ state: state({ attempts: [attempt('full-control', 1), attempt('full-pipeline', 1)],
    pipeline: { status: 'independent-two-pairs-complete', controlWallSeconds: [200, 202], pipelineWallSeconds: [180, 182], reduction: .1 } }),
    stateFile: '/runs/state.json' });
  const text = renderRecords(summary).board;
  assert(text.includes('冷任务端到端'));
  assert(text.includes('恰好两轮时与中位数相同'));
  assert(!text.includes('达到7%且双轮'));
});

test('real file sync writes UTF8 records, skips identical contents, updates on quality changes and preserves history', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-records-'));
  try {
    const run = path.join(temp, 'run'); await fs.mkdir(run);
    const stateFile = path.join(temp, 'state.json'); const out = path.join(temp, 'out');
    const value = attempt('full', 1); value.directory = run;
    await fs.writeFile(stateFile, JSON.stringify(state({ attempts: [value] })));
    await fs.writeFile(path.join(run, 'quality-report.json'), JSON.stringify({ status: 'pass', runtimeStatus: 'pass' }));
    const first = await syncOnce({ stateFile, outputDirectory: out });
    assert.equal(first.changed, true);
    const unchanged = await syncOnce({ stateFile, outputDirectory: out, lastHash: first.contentHash });
    assert.equal(unchanged.changed, false);
    await fs.writeFile(path.join(run, 'quality-report.json'), JSON.stringify({ status: 'content-review', runtimeStatus: 'pass' }));
    const changed = await syncOnce({ stateFile, outputDirectory: out, lastHash: first.contentHash });
    assert.equal(changed.changed, true);
    const summary = JSON.parse(await fs.readFile(path.join(out, 'SUMMARY.json'), 'utf8'));
    assert.equal(summary.attempts[0].report.status, 'content-review');
    assert.equal(summary.attempts[0].history.length, 1);
    assert((await fs.readFile(path.join(out, '实时错题.md'), 'utf8')).includes('内容或固定输入待复核'));
    await fs.writeFile(stateFile, JSON.stringify(state({ completedAt: '2026-11-06T00:01:00Z' })));
    const completed = await syncOnce({ stateFile, outputDirectory: out, lastHash: changed.contentHash });
    assert.equal(completed.complete, true);
    assert.equal(completed.attempts, 1);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
