import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForRuntime } from '../scripts/runtime-health.mjs';

test('launcher readiness waits for a visible app window rather than a hidden startup window', async t => {
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-launcher-readiness-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'control.json'), JSON.stringify({ pid: 123, port: 12345, token: 'fixture' }));
  let calls = 0;
  assert.equal(await waitForRuntime({ root, pid: 123, requireVisibleWindow: true, alive: () => true, delay: async () => {},
    fetchImpl: async (_url, options) => options?.method === 'POST' ? new Response('{"opened":true}') : new Response(JSON.stringify({ pid: 123, appReady: true,
      windows: [{ visible: ++calls > 1, destroyed: false }] })) }), true);
  assert.equal(calls, 2);
});

test('a ready but hidden Windows app is explicitly opened before launch validation succeeds', async t => {
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-launcher-hidden-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'control.json'), JSON.stringify({ pid: 123, port: 12345, token: 'fixture' }));
  let visible = false, activations = 0;
  const ready = await waitForRuntime({ root, pid: 123, timeoutMs: 100, requireVisibleWindow: true,
    alive: () => true, delay: async () => {}, fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, 'Bearer fixture');
      if (options.method === 'POST') {
        assert.equal(url, 'http://127.0.0.1:12345/notion/open');
        visible = true; activations++; return new Response('{"opened":true}');
      }
      return new Response(JSON.stringify({ pid: 123, appReady: true, windows: [{ visible, destroyed: false }] }));
    } });
  assert.equal(ready, true, 'a healthy hidden app must be surfaced instead of being rolled back');
  assert.equal(activations, 1);
});

test('a running Windows app with no windows is explicitly opened before launch validation succeeds', async t => {
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-launcher-windowless-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'control.json'), JSON.stringify({ pid: 123, port: 12345, token: 'fixture' }));
  let opened = false;
  const ready = await waitForRuntime({ root, pid: 123, timeoutMs: 100, requireVisibleWindow: true,
    alive: () => true, delay: async () => {}, fetchImpl: async (_url, options) => {
      if (options.method === 'POST') { opened = true; return new Response('{"opened":true}'); }
      return new Response(JSON.stringify({ pid: 123, appReady: true,
        windows: opened ? [{ visible: true, minimized: false, destroyed: false }] : [] }));
    } });
  assert.equal(ready, true, 'A ready background process with no window must be asked to create one');
  assert.equal(opened, true);
});

test('a minimized Windows app must be restored before launch validation succeeds', async t => {
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-launcher-minimized-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'control.json'), JSON.stringify({ pid: 123, port: 12345, token: 'fixture' }));
  let minimized = true;
  const ready = await waitForRuntime({ root, pid: 123, timeoutMs: 100, requireVisibleWindow: true,
    alive: () => true, delay: async () => {}, fetchImpl: async (_url, options) => {
      if (options.method === 'POST') { minimized = false; return new Response('{"opened":true}'); }
      return new Response(JSON.stringify({ pid: 123, appReady: true,
        windows: [{ visible: true, minimized, destroyed: false }] }));
    } });
  assert.equal(ready, true);
  assert.equal(minimized, false, 'A minimized window is not a displayed application');
});

test('Windows double-click launch stops only this project runtime and its orphan processes before opening',
  { skip: process.platform !== 'win32', timeout: 25000 }, async t => {
    const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'test-launcher-restart-中文 空格-'));
    const scripts = path.join(root, 'scripts'), state = path.join(root, '.notion-switch'), runtime = path.join(state, 'runtime');
    fs.mkdirSync(scripts); fs.mkdirSync(runtime, { recursive: true });
    const children = [];
    t.after(async () => {
      await Promise.all(children.map(child => new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('close', resolve); child.kill();
      })));
      assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true });
    });
    for (const name of ['launch.ps1', 'restart-windows-runtime.ps1']) {
      if (fs.existsSync(path.resolve('scripts', name))) fs.copyFileSync(path.resolve('scripts', name), path.join(scripts, name));
    }
    const executable = path.join(runtime, 'Notion.exe'); fs.copyFileSync(process.execPath, executable);
    const start = file => { const child = spawn(file, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' }); children.push(child); return child; };
    const old = start(executable), orphan = start(executable), unrelated = start(process.execPath);
    await delay(250);
    for (const child of children) assert.equal(child.exitCode, null);
    fs.writeFileSync(path.join(state, 'launcher.local.json'), JSON.stringify({ nodeExecutable: process.execPath }));
    // Reused stale metadata must never authorize killing an unrelated PID.
    fs.writeFileSync(path.join(state, 'control.json'), JSON.stringify({ pid: unrelated.pid, port: 1, token: 'fixture' }));
    fs.writeFileSync(path.join(state, 'launch.lock'), JSON.stringify({ pid: unrelated.pid }));
    fs.writeFileSync(path.join(state, 'private.txt'), 'keep user data');
    fs.writeFileSync(path.join(scripts, 'find-notion.mjs'), 'console.log(JSON.stringify({found:true}));');
    fs.writeFileSync(path.join(scripts, 'open-notion.mjs'), `import fs from 'node:fs';
for (const pid of ${JSON.stringify([old.pid, orphan.pid])}) {
  let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) throw Error('Old Switch Notion process is still running');
}
process.kill(${unrelated.pid}, 0);
if (fs.existsSync('.notion-switch/launch.lock')) throw Error('Stale startup lock remains');
if (fs.existsSync('.notion-switch/control.json')) throw Error('Stale runtime control remains');
console.log('restarted');`);
    const launch = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'launch.ps1')],
      { cwd: root, windowsHide: true, env: { ...process.env, NOTION_SWITCH_LAUNCHER_UI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(launch);
    let output = ''; launch.stdout.on('data', chunk => { output += chunk; }); launch.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { launch.once('error', reject); launch.once('close', resolve); });
    const log = path.join(state, 'launcher-last.log');
    assert.equal(code, 0, output + '\n' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'No launch log'));
    assert.equal(unrelated.exitCode, null, 'Original Notion and unrelated applications must remain running');
    assert.equal(fs.readFileSync(path.join(state, 'private.txt'), 'utf8'), 'keep user data');
  });

test('the compiled Windows loading window cancels an unfinished launch and restarts on another double-click',
  { skip: process.platform !== 'win32', timeout: 25000 }, async t => {
    const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'test-launcher-中文 空格-'));
    const scripts = path.join(root, 'scripts'), state = path.join(root, '.notion-switch');
    fs.mkdirSync(scripts); fs.mkdirSync(state);
    const children = [];
    t.after(() => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
      assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true });
    });
    for (const name of ['launch.ps1', 'restart-windows-runtime.ps1']) {
      if (fs.existsSync(path.resolve('scripts', name))) fs.copyFileSync(path.resolve('scripts', name), path.join(scripts, name));
    }
    fs.writeFileSync(path.join(state, 'launcher.local.json'), JSON.stringify({ nodeExecutable: process.execPath }));
    fs.writeFileSync(path.join(scripts, 'find-notion.mjs'), 'console.log(JSON.stringify({found:true}));');
    fs.writeFileSync(path.join(scripts, 'open-notion.mjs'), `import fs from 'node:fs';
fs.appendFileSync('launch-count.txt', 'started\\n');
if (process.env.NOTION_SWITCH_LAUNCHER_UI !== '1') throw Error('Loading UI missing');
console.log('NOTION_SWITCH_STATUS:正在打开测试窗口…');
setTimeout(() => {}, 2200);
`);
    const exe = path.join(root, 'Switch Notion.exe');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/compile-launcher.ps1'),
      '-Source', path.resolve('scripts/windows-launcher.cs'), '-Destination', exe], { windowsHide: true, stdio: 'pipe', timeout: 15000 });
    const start = () => {
      const child = spawn(exe, [], { cwd: root, stdio: 'ignore' }); children.push(child);
      const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
      return { child, closed };
    };
    const first = start(), count = path.join(root, 'launch-count.txt');
    for (let i = 0; !fs.existsSync(count) && i < 100; i++) await delay(50);
    assert.ok(fs.existsSync(count), 'The launcher must reach its real PowerShell/Node path');
    assert.equal(first.child.exitCode, null, 'The loading window must remain open while launch is pending');
    const second = start();
    assert.equal((await second.closed).code, 0);
    assert.equal(first.child.exitCode, null, 'The loading window handles the restart without opening a duplicate');
    assert.equal((await first.closed).code, 0);
    assert.equal(fs.readFileSync(count, 'utf8'), 'started\nstarted\n', 'The pending launch must be replaced, not merely left running');
    assert.match(fs.readFileSync(path.join(state, 'launcher-last.log'), 'utf8'), /正在打开测试窗口/);
  });
