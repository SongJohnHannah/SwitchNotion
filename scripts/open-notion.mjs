import fs from 'node:fs';
import path from 'node:path';
import { stateRoot } from './prepare-desktop.mjs';
const file = path.join(stateRoot, 'control.json');
if (fs.existsSync(file)) {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    const response = await fetch(`http://127.0.0.1:${info.port}/notion/open`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(15000) });
    if (response.ok) { console.log(JSON.stringify({ opened: true, reusedRunningPrototype: true })); process.exit(0); }
    const status = await fetch(`http://127.0.0.1:${info.port}/status`, { headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(3000) });
    if (status.ok) throw Error('NotionSwitch 正在运行但暂时无法显示窗口，请稍后重试或从托盘退出后重新启动。');
  } catch (error) { if (error.message.startsWith('NotionSwitch 正在运行')) throw error; }
}
process.env.NOTION_SWITCH_OPEN_SETTINGS = '0';
await import('./start-desktop.mjs');
