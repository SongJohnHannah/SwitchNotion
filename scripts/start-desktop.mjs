import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prepare, runtime, stateRoot } from './prepare-desktop.mjs';
import { acceptRuntime, rollbackRuntime } from './runtime-update.mjs';
import { waitForRuntime } from './runtime-health.mjs';
import { launchLock } from './launch-lock.mjs';
import platformModule from '../src/platform/index.cjs';

const platform = platformModule.createDesktopPlatform();
platform.requireCapability('launchRuntime');
const control = path.join(stateRoot, 'control.json');
fs.mkdirSync(stateRoot, { recursive: true });
const releaseLaunch = launchLock(stateRoot); process.once('exit', releaseLaunch);
fs.writeFileSync(path.join(stateRoot, 'launcher.local.json'), JSON.stringify({ nodeExecutable: fs.realpathSync(process.execPath) }), { mode: 0o600 });
if (fs.existsSync(control)) {
  try {
    const info = JSON.parse(fs.readFileSync(control, 'utf8'));
    const r = await fetch(`http://127.0.0.1:${info.port}/status`, { headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(1000) });
    if (r.ok) { console.log(JSON.stringify({ alreadyRunning: true, ...(await r.json()) }, null, 2)); process.exit(0); }
  } catch {}
}
const prepared = prepare(process.argv[2], { force: process.env.NOTION_SWITCH_FORCE_UPDATE === '1' });
console.log(JSON.stringify(prepared));
function launch() {
 const stdout = fs.openSync(path.join(stateRoot, 'desktop-stdout.log'), 'a');
 const stderr = fs.openSync(path.join(stateRoot, 'desktop-stderr.log'), 'a');
 const child = platform.launchRuntime({ container: runtime, stateRoot,
  env: { ...process.env, ...(['blocked', 'held'].includes(prepared.updateStatus) ? { NOTION_SWITCH_OPEN_SETTINGS: '1', NOTION_SWITCH_UPDATE_VIEW: '1' } : {}) },
  stdio: ['ignore', stdout, stderr],
 });
 fs.closeSync(stdout); fs.closeSync(stderr);
 child.on('error', () => {}); child.unref(); return child;
}
let child = launch(), runtimeRestored = false;
if (prepared.pendingValidation) {
  if (await waitForRuntime({ root: stateRoot, pid: child.pid })) acceptRuntime();
  else {
    // Ask only this isolated process to quit. Never kill the original Notion,
    // or swap an executable directory while its process still owns files.
    try {
      const info = JSON.parse(fs.readFileSync(control, 'utf8'));
      if (info.pid === child.pid) await fetch(`http://127.0.0.1:${info.port}/quit`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(1000) });
    } catch {}
    for (let n = 0; n < 25; n++) { try { process.kill(child.pid, 0); await new Promise(r => setTimeout(r, 200)); } catch { break; } }
    let running = false; try { process.kill(child.pid, 0); running = true; } catch {}
    if (running) throw Error('新原型启动未通过检查且尚未退出，已保留备份；请退出原型后重新启动，将自动恢复。');
    rollbackRuntime({ holdHash: prepared.sourceHash, reason: '新版本未通过本机启动检查，已自动恢复上一个版本。' });
    runtimeRestored = true;
    child = launch();
    if (!await waitForRuntime({ root: stateRoot, pid: child.pid })) throw Error('上一个原型版本也未能启动，请打开配置或查看启动结果。');
  }
}
const { ProviderRouter } = createRequire(import.meta.url)('../src/provider.cjs');
console.log(JSON.stringify({ launched: true, pid: child.pid, mode: new ProviderRouter({ root: stateRoot }).status().mode, runtimeRestored, originalInstallationModified: false }));
releaseLaunch();
