import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { prepare, runtime, stateRoot } from './prepare-desktop.mjs';
import { acceptRuntime, rollbackRuntime, previousRuntime, adapterHash, project } from './runtime-update.mjs';
import { waitForRuntime } from './runtime-health.mjs';
import { launchLock } from './launch-lock.mjs';
import platformModule from '../src/platform/index.cjs';

const platform = platformModule.createDesktopPlatform();
platform.requireCapability('launchRuntime');
const macRuntime = platform.id === 'darwin' ? createRequire(import.meta.url)('../src/platform/macos-runtime.cjs') : null;
const macRuntimeHealthFetch = macRuntime?.macRuntimeHealthFetch;
const control = path.join(stateRoot, 'control.json');
fs.mkdirSync(stateRoot, { recursive: true });
const releaseLaunch = launchLock(stateRoot); process.once('exit', releaseLaunch);
fs.writeFileSync(path.join(stateRoot, 'launcher.local.json'), JSON.stringify({ nodeExecutable: fs.realpathSync(process.execPath), projectDirectory: path.resolve(import.meta.dirname, '..') }), { mode: 0o600 });
let anotherInstance = false;
if (fs.existsSync(control)) {
  try {
    const info = JSON.parse(fs.readFileSync(control, 'utf8'));
    const r = await fetch(`http://127.0.0.1:${info.port}/status`, { headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(1000) });
    if (r.ok) {
      if (process.env.NOTION_SWITCH_CLIENT_UPDATE === '1') anotherInstance = true;
      else { console.log(JSON.stringify({ alreadyRunning: true, ...(await r.json()) }, null, 2)); process.exit(0); }
    }
  } catch {}
}
if (anotherInstance) throw Error('另一个实例已经启动，请退出后重新更新。');
// Only the standalone start command accepts an installation path. When this
// module is imported by a launcher, its arguments belong to that launcher.
const directStart = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const prepared = prepare(directStart ? process.argv[2] : undefined, { force: process.env.NOTION_SWITCH_FORCE_UPDATE === '1' });
console.log(JSON.stringify(prepared));
if (process.env.NOTION_SWITCH_CLIENT_UPDATE === '1' && prepared.adapterHash !== adapterHash(project)) throw Error('最新代码尚未接入，已保留此前运行版本。');
function launch() {
 if (macRuntime && process.env.NOTION_SWITCH_MAC_LAUNCHER) return macRuntime.launchMacApplication({
  helper: process.env.NOTION_SWITCH_MAC_LAUNCHER, appRoot: platform.runtimeLayout(runtime).appRoot, root: stateRoot,
  env: { ...process.env, NOTION_SWITCH_PROJECT: path.resolve(import.meta.dirname, '..'),
   ...(['blocked', 'held'].includes(prepared.updateStatus) ? { NOTION_SWITCH_OPEN_SETTINGS: '1', NOTION_SWITCH_UPDATE_VIEW: '1' } : {}) }
 });
 const stdout = fs.openSync(path.join(stateRoot, 'desktop-stdout.log'), 'a');
 const stderr = fs.openSync(path.join(stateRoot, 'desktop-stderr.log'), 'a');
 const child = platform.launchRuntime({ container: runtime, stateRoot,
  env: { ...process.env, NOTION_SWITCH_PROJECT: path.resolve(import.meta.dirname, '..'), ...(['blocked', 'held'].includes(prepared.updateStatus) ? { NOTION_SWITCH_OPEN_SETTINGS: '1', NOTION_SWITCH_UPDATE_VIEW: '1' } : {}) },
  stdio: ['ignore', stdout, stderr],
 });
 fs.closeSync(stdout); fs.closeSync(stderr);
 child.on('error', () => {}); child.unref(); return child;
}
const accelerator = createRequire(import.meta.url)('../src/notion-accelerator.cjs');
if (accelerator.read(stateRoot).autoIp) {
  // 每次启动都重新测速，避免固定到已经失效的 IP。
  try { await createRequire(import.meta.url)('../src/notion-ip-probe.cjs').refresh(stateRoot); } catch {}
}
let child = launch(), runtimeRestored = false;
const validationTimeout = platform.id === 'darwin' ? 45000 : undefined;
const checkStartup = pid => waitForRuntime({ root: stateRoot, pid, timeoutMs: validationTimeout,
  ...(macRuntimeHealthFetch ? { fetchImpl: macRuntimeHealthFetch({ pid }) } : {}) });
if (prepared.pendingValidation) {
  // macOS can take longer to restore tabs after a freshly signed bundle swap.
  if (await checkStartup(child.pid)) acceptRuntime();
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
    const previous = previousRuntime();
    if (!previous || previous.pendingValidation) throw Error('启动未通过本机检查，尚无经过验证的旧版本。请查看 macOS 系统提示及启动日志。');
    rollbackRuntime({ holdHash: prepared.sourceHash, reason: '新版本未通过本机启动检查，已自动恢复上一个版本。' });
    runtimeRestored = true;
    child = launch();
    if (!await checkStartup(child.pid)) throw Error('上一个原型版本也未能启动，请打开配置或查看启动结果。');
  }
}
else if (process.env.NOTION_SWITCH_CLIENT_UPDATE === '1' && !await checkStartup(child.pid)) throw Error('更新后的应用未通过启动检查。');
const { ProviderRouter } = createRequire(import.meta.url)('../src/provider.cjs');
console.log(JSON.stringify({ launched: true, pid: child.pid, mode: new ProviderRouter({ root: stateRoot }).status().mode, runtimeRestored, originalInstallationModified: false }));
if (runtimeRestored && process.env.NOTION_SWITCH_CLIENT_UPDATE === '1') process.exitCode = 1;
releaseLaunch();
