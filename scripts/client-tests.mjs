import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function testFiles(project) {
  const directory = path.join(project, 'tests');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join('tests', name));
}

export async function runProjectTests({ project, root, timeoutMs = 480000, perTestMs = 120000, spawnImpl = spawn } = {}) {
  const files = testFiles(project);
  if (!files.length) return { ok: false, missing: true };
  fs.mkdirSync(root, { recursive: true });
  const log = path.join(root, 'client-update-tests.log');
  const descriptor = fs.openSync(log, 'w', 0o600);
  const env = { ...process.env };
  // The updater worker carries launch flags that must not steer the test run.
  for (const key of Object.keys(env)) if (key.startsWith('NOTION_SWITCH_')) delete env[key];
  // Nested test runs inherit the parent runner's child context and would exit early.
  delete env.NODE_TEST_CONTEXT;
  env.NODE_NO_WARNINGS = '1';
  const child = spawnImpl(process.execPath, ['--test', '--test-timeout=' + perTestMs, ...files], {
    cwd: project, env, windowsHide: true, stdio: ['ignore', descriptor, descriptor]
  });
  fs.closeSync(descriptor);
  const outcome = await new Promise(resolve => {
    let settled = false, timedOut = false, grace;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace); resolve(value); };
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (process.platform === 'win32') spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGKILL'); } catch {}
      grace = setTimeout(() => finish({ ok: false, timedOut: true }), 5000);
    }, timeoutMs);
    child.once('error', () => finish({ ok: false }));
    // Wait for the runner to exit after a timeout so callers never clean up a live directory.
    child.once('exit', code => finish({ ok: !timedOut && code === 0, code, ...(timedOut ? { timedOut: true } : {}) }));
  });
  return { ...outcome, log };
}
