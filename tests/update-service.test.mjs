import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
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
