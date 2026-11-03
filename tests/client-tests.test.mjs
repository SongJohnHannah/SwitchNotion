import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runProjectTests, testFiles } from '../scripts/client-tests.mjs';

function removeWithRetry(directory) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try { fs.rmSync(directory, { recursive: true, force: true }); return; }
    catch (error) { if (attempt === 19) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
}

function project(t, body) {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'test-client-tests-'));
  t.after(() => removeWithRetry(directory));
  fs.mkdirSync(path.join(directory, 'tests'));
  fs.writeFileSync(path.join(directory, 'tests', 'sample.test.mjs'), body);
  const root = path.join(directory, 'state'); fs.mkdirSync(root);
  return { directory, root };
}

test('update test runs enumerate project tests and keep their output in a local log', async t => {
  const f = project(t, "import test from 'node:test'; test('ok', () => {});\n");
  assert.deepEqual(testFiles(f.directory), [path.join('tests', 'sample.test.mjs')]);
  const result = await runProjectTests({ project: f.directory, root: f.root, timeoutMs: 30000 });
  assert.equal(result.ok, true);
  assert.ok(fs.statSync(result.log).size > 0);
});

test('failing update tests report failure without leaking into the caller, and timeouts stop the runner', async t => {
  const failing = project(t, "import test from 'node:test'; test('bad', () => { throw Error('boom'); });\n");
  assert.equal((await runProjectTests({ project: failing.directory, root: failing.root, timeoutMs: 30000 })).ok, false);
  const slow = project(t, "import test from 'node:test'; test('slow', async () => { await new Promise(resolve => setTimeout(resolve, 60000)); });\n");
  const result = await runProjectTests({ project: slow.directory, root: slow.root, timeoutMs: 1500, perTestMs: 60000 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

test('a project without tests is reported instead of silently passing an update', async t => {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'test-client-tests-'));
  t.after(() => removeWithRetry(directory));
  const result = await runProjectTests({ project: directory, root: path.join(directory, 'state') });
  assert.equal(result.missing, true);
  assert.equal(result.ok, false);
});
