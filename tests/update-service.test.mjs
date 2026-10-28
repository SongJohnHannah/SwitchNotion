import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import platformModule from '../src/platform/index.cjs';
const { UpdateService } = createRequire(import.meta.url)('../src/update-service.cjs');
function fixture(t, extra = {}) {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-update-service-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'launcher.local.json'), JSON.stringify({ nodeExecutable: process.execPath }));
  let restarted = false; const calls = [];
  const service = new UpdateService({ root, load: async () => ({ updateStatus: () => ({ compatible: true, available: true, previousVersion: '7.40.0', message: 'fixture' }) }), onRestart: () => { restarted = true; }, spawnImpl: (exe, args, options) => {
    calls.push({ exe, args, options }); const child = new EventEmitter(); child.connected = true; child.disconnect = () => {}; child.unref = () => {}; queueMicrotask(() => child.emit('message', { ready: true })); return child;
  }, ...extra });
  return { service, calls, restarted: () => restarted };
}
test('the configuration update action launches a fixed local helper and restarts only after its ready acknowledgement', async t => {
  const f = fixture(t); const result = await f.service.request('update.apply'); assert.equal(result.ok, true);
  assert.equal(f.restarted(), true); assert.equal(f.calls[0].args[1], 'update'); assert.equal(f.calls[0].options.windowsHide, true);
  assert.equal(f.calls[0].options.cwd, f.service.projectDirectory);
  assert.equal((await f.service.request('update.apply')).ok, false);
});
test('updates reject arbitrary arguments and never restart during active AI work', async t => {
  const f = fixture(t, { isBusy: () => true });
  assert.equal((await f.service.request('update.apply')).ok, false);
  assert.equal((await f.service.request('update.rollback', { source: 'arbitrary' })).ok, false);
  assert.equal(f.calls.length, 0); assert.equal(f.restarted(), false);
});
test('web compatibility failures are visible in version status without exposing private state', async t => {
  const f = fixture(t, { getCompatibility: () => ({ unsupportedAssets: ['fixture'] }) });
  const result = await f.service.request('update.status'); assert.equal(result.ok, true);
  assert.equal(result.result.clientCompatible, false); assert.ok(result.result.message.includes('网页'));
});

test('configuration reports automatic webpage compatibility separately from desktop updates', async t => {
  const f = fixture(t, { getCompatibility: () => ({ adaptedAssets: ['a', 'b'], automaticAssets: ['b'], unsupportedAssets: [] }) });
  const result = await f.service.request('update.status');
  assert.equal(result.result.clientCompatible, true);
  assert.deepEqual(result.result.automaticCompatibility, { enabled: true, checked: 2, adapted: 1, blocked: 0 });
  assert.equal(f.restarted(), false, 'Checking automatic compatibility cannot restart an active app');
});
test('a relocated Mac app keeps update helpers in its payload while state lives under Application Support', async t => {
  const payload = path.resolve('.notion-switch', 'fixture-app', 'Contents', 'Resources', 'project');
  const platform = platformModule.createDesktopPlatform({ id: 'darwin', arch: 'arm64' });
  const f = fixture(t, { projectDirectory: payload, platform });
  const node = path.join(f.service.root, 'node'); fs.writeFileSync(node, 'fixture ARM64 Node');
  fs.writeFileSync(path.join(f.service.root, 'launcher.local.json'), JSON.stringify({ nodeExecutable: node }));
  assert.equal((await f.service.request('update.apply')).ok, true);
  assert.equal(f.calls[0].args[0], path.join(payload, 'scripts', 'update-helper.mjs'));
  assert.equal(f.calls[0].options.cwd, payload);
  assert.equal(f.calls[0].exe, node);
});

test('an update helper started from the runtime releases that directory for the Windows swap', { skip: process.platform !== 'win32' }, async t => {
  let worker;
  const f = fixture(t, { spawnImpl(exe, args, options) {
    // Keep the worker alive after the ready handshake, as update-helper does
    // while waiting for the desktop process to exit. Only replace its payload.
    worker = spawn(exe, ['-e', 'setInterval(() => {}, 1000); process.send({ ready: true });'], options);
    return worker;
  } });
  const runtime = path.join(f.service.root, 'runtime'), previous = path.join(f.service.root, 'runtime-previous');
  fs.mkdirSync(path.join(runtime, 'resources'), { recursive: true });
  const cwd = process.cwd(); let ready;
  try { process.chdir(path.join(runtime, 'resources')); ready = f.service.startWorker('update'); }
  finally { process.chdir(cwd); }
  try {
    await ready;
    assert.doesNotThrow(() => fs.renameSync(runtime, previous), 'the helper must not keep the runtime busy during its own update');
  } finally {
    if (worker && worker.exitCode === null) { worker.ref(); const exited = once(worker, 'exit'); worker.kill(); await exited; }
  }
});
