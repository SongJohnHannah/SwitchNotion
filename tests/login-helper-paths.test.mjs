import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import login from '../src/login-state.cjs';
import platforms from '../src/platform/index.cjs';

const project = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const parent = path.join(project, '.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-login-paths-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const node = process.execPath;
  fs.writeFileSync(path.join(root, 'launcher.local.json'), JSON.stringify({ nodeExecutable: node, projectDirectory: project }));
  const platform = platforms.createDesktopPlatform({ id: 'win32', arch: 'x64' });
  return { root, node, platform };
}

test('Windows login helpers use the recorded project for a separate state directory', async t => {
  const f = fixture(t), calls = [];
  const service = new login.LoginService({ ...f, execFileImpl(exe, args, options, callback) {
    calls.push({ exe, args, options }); callback(null, JSON.stringify({ ok: true, result: { sourceAvailable: false } }));
  }, spawnImpl(exe, args, options) {
    calls.push({ exe, args, options });
    const child = new EventEmitter(); child.connected = true; child.disconnect = () => {}; child.unref = () => {};
    queueMicrotask(() => child.emit('message', { type: 'login-sync-ready', stageId: 'fixture-stage' })); return child;
  } });
  await service.external('status'); await service.startApplyWorker('fixture-stage');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.exe, f.node);
    assert.equal(call.args[0], path.join(project, 'scripts/login-helper.cjs'));
    assert.equal(call.options.cwd, project, 'A surviving helper must release the runtime directory');
    assert.equal(call.options.env.NOTION_SWITCH_ROOT, f.root);
  }
});

test('the actual Windows login helper accepts the explicitly selected state directory and rejects other roots', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const invoke = root => JSON.parse(execFileSync(process.execPath, [path.join(project, 'scripts/login-helper.cjs'), 'status', '--root', root], {
    cwd: project, windowsHide: true, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1',
      NOTION_SWITCH_ROOT: f.root, APPDATA: path.join(f.root, 'empty-appdata'), HOME: f.root }
  }));
  assert.equal(invoke(f.root).ok, true);
  assert.throws(() => invoke(path.join(f.root, 'other-state')), error => JSON.parse(error.stdout).ok === false);
  fs.writeFileSync(path.join(f.root, 'launcher.local.json'), JSON.stringify({ projectDirectory: f.root }));
  assert.throws(() => invoke(f.root), error => JSON.parse(error.stdout).ok === false);
});
