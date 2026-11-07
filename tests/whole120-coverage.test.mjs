import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkWhole120Coverage, reportSchema } from '../scripts/check-whole120-coverage.mjs';

function fixture(t, entries, seconds = 2806.0373125) {
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'whole120-coverage-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), parent); fs.rmSync(directory, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(directory, 'checkpoint.json'), JSON.stringify({ parts: [{ startSample: 0, samples: Math.round(seconds * 16000), segments: entries.map(([start, end, text]) => ({ start, end, text })) }] }));
  return directory;
}
const complete = [
  [94, 95, 'This is the right jacket.'], [2274, 2277, "Well, let's be honest. I agree with you."],
  [2732, 2734, 'Are you having fun being on the frontier of humanity?'], [2790, 2793, 'Thanks man, appreciate you.'],
  [1470, 1499, "complex computer chip nobody can copy for 10 years put me on speaker happiest group is China states are happy"],
];
test('shared named anchors pass while jacket/track is explicitly uncertain', t => {
  for (const ending of ['jacket', 'track']) {
    const report = checkWhole120Coverage({ directory: fixture(t, complete.map(entry => [entry[0], entry[1], entry[2].replace('jacket', ending)])) });
    assert.equal(report.status, 'PASS_NAMED_ANCHORS_ONLY'); assert.match(report.checks[0].uncertainEnding, /not judged/);
  }
  assert.equal(reportSchema.properties.version.const, 1);
});
test('old whole120-style meaningful clause omissions fail despite similar surrounding text', t => {
  const directory = fixture(t, complete.map(([start, end, text]) => [start, end, start === 94 ? 'I know we talk about serious stuff.' : start === 2274 ? 'The pushback would be...' : start === 2732 ? 'the frontier of humanity? I like it.' : start === 2790 ? 'Thank you. That was awesome.' : text]));
  const report = checkWhole120Coverage({ directory });
  assert.equal(report.status, 'FAIL'); assert.deepEqual(report.failedChecks, ['94-short-clause', '2274-honest-agreement', '2732-full-question', '2790-tail-appreciation']);
  assert.equal(report.checks.find(c => c.id === '1470-1500-phone').status, 'PASS');
});
test('probe offsets restore original video time and checks outside input are not counted as passing', t => {
  const directory = fixture(t, [[114, 117, "Let's be honest. I agree with you."]], 120);
  const report = checkWhole120Coverage({ directory, offsetSeconds: 2160 });
  assert.equal(report.status, 'PASS_NAMED_ANCHORS_ONLY'); assert.equal(report.evaluatedChecks, 1);
  assert.equal(report.checks[1].groups[0].evidence[0].start, 2274);
  const unrelated = checkWhole120Coverage({ directory: fixture(t, [[1, 2, 'Unrelated']], 10), offsetSeconds: 500 });
  assert.equal(unrelated.status, 'NO_APPLICABLE_CHECKS');
});
test('the same words elsewhere cannot hide a missing named clause, and the checkpoint is never rewritten', t => {
  const directory = fixture(t, complete.map(entry => entry[0] === 2732 ? [1000, 1004, entry[2]] : entry));
  const file = path.join(directory, 'checkpoint.json'), before = fs.readFileSync(file);
  const report = checkWhole120Coverage({ directory });
  assert.equal(report.status, 'FAIL'); assert.deepEqual(report.failedChecks, ['2732-full-question']);
  assert.deepEqual(fs.readFileSync(file), before);
});
