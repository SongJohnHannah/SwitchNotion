import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const moduleFile = path.resolve(import.meta.dirname, '../src/speech/gpu-lease.cjs');
const { acquireGpuLease } = require(moduleFile);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'speech-gpu-lease-'));
  t.after(async () => { const resolved = await fs.realpath(root); assert.equal(path.dirname(resolved), temporaryRoot); await fs.rm(resolved, { recursive: true, force: true }); });
  return { root, registry: path.join(root, 'speech/gpu-leases') };
}

test('same-process GPU callers wait until explicit release, including an aborted holder signal', { timeout: 10000 }, async t => {
  const { root } = await fixture(t), holderSignal = new AbortController();
  const first = await acquireGpuLease({ root, signal: holderSignal.signal });
  const waiting = deferred(); let entered = false;
  const pending = acquireGpuLease({ root, onWait: waiting.resolve }).then(lease => { entered = true; return lease; });
  await waiting.promise; holderSignal.abort(); await pause(10); assert.equal(entered, false);
  await first.release(); const second = await pending;
  assert.equal(entered, true); await second.release(); await second.release();
});

test('waiting cancellation removes only its own entry and leaves the live holder intact', { timeout: 10000 }, async t => {
  const { root, registry } = await fixture(t), first = await acquireGpuLease({ root });
  const waiting = deferred(), controller = new AbortController(), reason = Error('fixture cancellation');
  const pending = acquireGpuLease({ root, signal: controller.signal, onWait: waiting.resolve });
  await waiting.promise; controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.deepEqual(await fs.readdir(registry), [path.basename(first.directory)]);
  await first.release();
});

test('EPERM from pid probing is alive and must not reap the entry', { timeout: 10000 }, async t => {
  const { root, registry } = await fixture(t), fakePid = 2147483646, token = randomUUID();
  const peer = path.join(registry, `${fakePid}-${token}`); await fs.mkdir(peer, { recursive: true });
  await fs.writeFile(path.join(peer, 'owner.json'), JSON.stringify({ version: 1, pid: fakePid, token, choosing: false, ticket: 1 }));
  const waiting = deferred(), controller = new AbortController();
  const pending = acquireGpuLease({ root, signal: controller.signal, onWait: waiting.resolve,
    probePid: pid => { if (pid === fakePid) throw Object.assign(Error('not permitted'), { code: 'EPERM' }); process.kill(pid, 0); } });
  await waiting.promise; controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal((await fs.stat(peer)).isDirectory(), true);
});

test('concurrent stale reapers cannot remove a new live generation', { timeout: 10000 }, async t => {
  const { root, registry } = await fixture(t), fakePid = 2147483646, token = randomUUID();
  const peer = path.join(registry, `${fakePid}-${token}`); await fs.mkdir(peer, { recursive: true });
  await fs.writeFile(path.join(peer, 'owner.json'), JSON.stringify({ version: 1, pid: fakePid, token, choosing: false, ticket: 1 }));
  const bothObserved = deferred(); let observations = 0, active = 0, maximum = 0;
  const probePid = async pid => {
    if (pid === fakePid) { if (++observations === 2) bothObserved.resolve(); await bothObserved.promise; throw Object.assign(Error('dead'), { code: 'ESRCH' }); }
    process.kill(pid, 0);
  };
  await Promise.all([1, 2].map(async () => {
    const lease = await acquireGpuLease({ root, probePid, pollIntervalMs: 5 });
    active++; maximum = Math.max(maximum, active); await pause(20); active--; await lease.release();
  }));
  assert.equal(maximum, 1); assert.ok(observations >= 2); assert.deepEqual(await fs.readdir(registry), []);
});

async function child(t, root) {
  const file = path.join(root, 'lease-child.cjs');
  await fs.writeFile(file, `const {acquireGpuLease}=require(${JSON.stringify(moduleFile)});\n(async()=>{const lease=await acquireGpuLease({root:process.argv[2],onWait:()=>process.send({event:'waiting'})});process.send({event:'acquired',pid:process.pid});await new Promise(resolve=>process.on('message',m=>{if(m==='release')resolve()}));await lease.release();process.send({event:'released'});process.disconnect();})().catch(error=>{console.error(error.stack);process.exitCode=1;process.disconnect();});`);
  const processChild = fork(file, [root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages = [], waiters = [];
  processChild.on('message', message => { messages.push(message); for (const waiter of waiters) if (waiter.event === message.event) waiter.resolve(message); });
  t.after(async () => { if (processChild.exitCode === null && processChild.signalCode === null) { processChild.kill(); await once(processChild, 'exit'); } });
  return { process: processChild, event: event => messages.find(message => message.event === event) || new Promise(resolve => waiters.push({ event, resolve })) };
}

test('cross-process contenders serialize on the same resource root', { timeout: 10000 }, async t => {
  const { root } = await fixture(t), first = await acquireGpuLease({ root });
  const other = await child(t, root); await other.event('waiting');
  await first.release(); const acquired = await other.event('acquired'); assert.notEqual(acquired.pid, process.pid);
  other.process.send('release'); await other.event('released'); await once(other.process, 'exit');
});

test('a crashed process lease is reclaimed only after ESRCH', { timeout: 10000 }, async t => {
  const { root, registry } = await fixture(t), other = await child(t, root);
  await other.event('acquired'); other.process.kill('SIGKILL'); await once(other.process, 'exit');
  const lease = await acquireGpuLease({ root }); await lease.release();
  assert.deepEqual(await fs.readdir(registry), []);
});
