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

test('the compiled Windows loading window stays alive, coalesces repeated clicks and closes after successful launch',
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
    fs.copyFileSync(path.resolve('scripts/launch.ps1'), path.join(scripts, 'launch.ps1'));
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
    assert.equal(first.child.exitCode, null, 'A second click must not terminate the original launch');
    assert.equal((await first.closed).code, 0);
    assert.equal(fs.readFileSync(count, 'utf8'), 'started\n');
    assert.match(fs.readFileSync(path.join(state, 'launcher-last.log'), 'utf8'), /正在打开测试窗口/);
  });
