import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import platformModule from '../src/platform/index.cjs';
import providerModule from '../src/provider.cjs';
import { stateRoot } from './runtime-update.mjs';
import { inspectDesktop } from './desktop-compat.mjs';

export function ensureMacInstallation({ root, platform, exec = execFileSync }) {
  const invoke = (script, args = []) => exec('/usr/bin/osascript', ['-e', script, ...args], { encoding: 'utf8', timeout: 300000 }).trim();
  let source = platform.discoverInstallation(root);
  const existing = fs.existsSync(path.join(root, 'prepared.json')) && fs.existsSync(platform.runtimeLayout(path.join(root, 'runtime')).executable);
  if (!source && !existing) {
    let answer;
    try { answer = invoke('button returned of (display dialog "没有找到官方 Notion。可以选择已安装的 Notion，或打开官网下载安装后再次双击启动。" with title "Switch Notion" buttons {"取消", "打开官网", "选择 Notion"} default button "选择 Notion" cancel button "取消")'); }
    catch { return false; }
    if (answer === '打开官网') { exec('/usr/bin/open', ['https://www.notion.com/desktop']); return false; }
    if (answer !== '选择 Notion') return false;
    let chosen;
    try { chosen = invoke('POSIX path of (choose application with prompt "请选择官方 Notion 应用" as alias)'); } catch { return false; }
    source = platform.findInstallation(chosen, root);
    if (!source) throw Error('没有选中完整的官方 Notion 应用，请重新启动并选择 Notion.app。');
  }
  if (source) {
    try { inspectDesktop(fs.readFileSync(source.archive), platform.compatibility); }
    catch (error) { if (existing) return true; throw error; }
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'installation.local.json'), JSON.stringify({ source: source.appRoot }), { mode: 0o600 });
  }
  return true;
}
export async function launchMac(target = 'notion') {
  if (!['notion', 'settings', 'update'].includes(target)) throw Error('无法识别启动方式。');
  const platform = platformModule.createDesktopPlatform();
  if (platform.id !== 'darwin') throw Error('此入口只用于 Mac。');
  platform.requireCapability('launchRuntime');
  if (!ensureMacInstallation({ root: stateRoot, platform })) return;
  const configured = new providerModule.ProviderRouter({ root: stateRoot }).status().keyConfigured;
  const script = target === 'update' ? 'open-update.mjs' : target === 'settings' || !configured ? 'open-settings.mjs' : 'open-notion.mjs';
  await import(new URL(script, import.meta.url).href);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await launchMac(process.argv[2]);
