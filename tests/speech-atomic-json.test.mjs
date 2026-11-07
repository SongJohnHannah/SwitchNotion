import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { writeAtomicJson } = require('../src/speech/atomic-json.cjs');

const oldValue = { accepted: ['original segment'], version: 1 };
const newValue = { accepted: ['original segment', 'newly transcribed segment'], version: 2 };
const failure = code => Object.assign(new Error('Simulated rename failure: ' + code), { code });
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'speech-atomic-json-'));
  t.after(async () => {
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), temporaryRoot, 'cleanup must remain in the intended temporary directory');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const target = path.join(directory, 'checkpoint.json');
  await fs.writeFile(target, JSON.stringify(oldValue));
  return { directory, target };
}

for (const codes of [['EPERM'], ['EBUSY', 'EACCES', 'EPERM']]) {
  test(`atomic checkpoint survives ${codes.length} temporary Windows rename locks`, async t => {
    const { directory, target } = await fixture(t);
    const paths = [], waits = []; let attempts = 0;
    const result = await writeAtomicJson(target, newValue, { platform: 'win32',
      rename: async (from, to) => {
        paths.push([from, to]);
        assert.deepEqual(await readJson(from), newValue, 'a complete temporary file is reused before every rename');
        assert.deepEqual(await readJson(target), oldValue, 'the original remains intact while replacement is locked');
        if (attempts < codes.length) throw failure(codes[attempts++]);
        attempts++; await fs.rename(from, to);
      }, sleep: async ms => { waits.push(ms); }
    });
    assert.equal(result.renameAttempts, codes.length + 1);
    assert.equal(waits.length, codes.length);
    assert.deepEqual(await readJson(target), newValue);
    assert.equal(new Set(paths.map(([from]) => from)).size, 1, 'retries must not create another temporary file');
    assert.ok(paths.every(([, to]) => to === target));
    assert.deepEqual(await fs.readdir(directory), ['checkpoint.json']);
  });
}

test('nonretryable rename errors retain both old checkpoint and complete temporary JSON', async t => {
  const { target } = await fixture(t);
  const sourceFailure = failure('ENOSPC'); let calls = 0;
  await assert.rejects(writeAtomicJson(target, newValue, { platform: 'win32',
    rename: async () => { calls++; throw sourceFailure; }, sleep: async () => assert.fail('nonretryable error must not sleep')
  }), asyncError => {
    assert.equal(asyncError, sourceFailure); assert.equal(asyncError.code, 'ENOSPC');
    assert.equal(asyncError.renameAttempts, 1); assert.equal(asyncError.targetPath, target);
    assert.equal(path.dirname(asyncError.tempPath), path.dirname(target));
    return true;
  });
  assert.equal(calls, 1); assert.deepEqual(await readJson(target), oldValue);
  assert.deepEqual(await readJson(sourceFailure.tempPath), newValue);
});

test('exhausted transient rename retries preserve progress and stay below one second of scheduled backoff', async t => {
  const { target } = await fixture(t);
  const waits = []; let calls = 0, caught;
  await assert.rejects(writeAtomicJson(target, newValue, { platform: 'win32',
    rename: async () => { calls++; throw failure('EPERM'); }, sleep: async ms => waits.push(ms)
  }), error => { caught = error; return error.code === 'EPERM'; });
  assert.ok(calls > 1 && calls < 10);
  assert.equal(caught.renameAttempts, calls); assert.equal(waits.length, calls - 1);
  assert.ok(waits.reduce((sum, ms) => sum + ms, 0) < 1000);
  assert.deepEqual(await readJson(target), oldValue); assert.deepEqual(await readJson(caught.tempPath), newValue);
});

test('a non-Windows EPERM is not treated as a transient Windows lock', async t => {
  const { target } = await fixture(t);
  const sourceFailure = failure('EPERM'); let calls = 0;
  await assert.rejects(writeAtomicJson(target, newValue, { platform: 'linux',
    rename: async () => { calls++; throw sourceFailure; }, sleep: async () => assert.fail('unexpected retry')
  }), error => error === sourceFailure);
  assert.equal(calls, 1); assert.deepEqual(await readJson(target), oldValue);
  assert.deepEqual(await readJson(sourceFailure.tempPath), newValue);
});
