import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../src/collection/model.cjs', import.meta.url));
const source = fs.readFileSync(new URL('../src/collection/model.cjs', import.meta.url), 'utf8');
function fixture(t, fail) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-checkpoint-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'job.json'), pauses = []; let attempts = 0;
  fs.writeFileSync(file, JSON.stringify({ progress: 'previous' }));
  const filesystem = Object.create(fs);
  filesystem.renameSync = (from, to) => {
    assert.equal(to, file);
    assert.equal(JSON.parse(fs.readFileSync(file)).progress, 'previous', 'never remove or partially replace the previous checkpoint');
    assert.equal(JSON.parse(fs.readFileSync(from)).progress, 'next');
    const code = fail(++attempts);
    if (code) throw Object.assign(Error('synthetic sharing violation'), { code });
    return fs.renameSync(from, to);
  };
  const context = { module: { exports: {} }, process, URL, Buffer, SharedArrayBuffer, Int32Array, Atomics: { wait: (_cell, _index, _value, ms) => pauses.push(ms) }, require: name => name === 'node:fs' ? filesystem : require(name) };
  vm.runInNewContext(source, context);
  return { file, pauses, atomicJson: context.module.exports.atomicJson, attempts: () => attempts };
}
test('a transient Windows checkpoint sharing violation retries the same atomic replacement', t => {
  const f = fixture(t, attempt => attempt < 3 ? 'EPERM' : null);
  f.atomicJson(f.file, { progress: 'next' });
  assert.equal(JSON.parse(fs.readFileSync(f.file)).progress, 'next');
  assert.equal(f.attempts(), 3); assert.equal(f.pauses.length, 2);
});
test('persistent checkpoint locks are bounded and preserve the previous checkpoint', t => {
  const f = fixture(t, () => 'EBUSY');
  assert.throws(() => f.atomicJson(f.file, { progress: 'next' }), { code: 'EBUSY' });
  assert.ok(f.attempts() > 1 && f.attempts() <= 5);
  assert.ok(f.pauses.reduce((total, ms) => total + ms, 0) <= 250);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).progress, 'previous');
});
test('checkpoint I/O failures are surfaced without treating them as transient locks', t => {
  const f = fixture(t, () => 'EIO');
  assert.throws(() => f.atomicJson(f.file, { progress: 'next' }), { code: 'EIO' });
  assert.equal(f.attempts(), 1); assert.equal(f.pauses.length, 0);
});
