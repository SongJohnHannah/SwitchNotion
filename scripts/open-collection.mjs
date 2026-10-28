import fs from 'node:fs';
import path from 'node:path';
import { stateRoot } from './prepare-desktop.mjs';
const file = path.join(stateRoot, 'control.json');
if (fs.existsSync(file)) {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    const response = await fetch(`http://127.0.0.1:${info.port}/collection/open`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(20000) });
    if (response.ok) { console.log(JSON.stringify({ opened: true })); process.exit(0); }
    const status = await fetch(`http://127.0.0.1:${info.port}/status`, { headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(3000) });
    if (status.ok) throw Error('请重新启动 Switch Notion，载入新版本的快捷收集功能。');
  } catch (error) { if (error.message.startsWith('请重新')) throw error; }
}
process.env.NOTION_SWITCH_OPEN_COLLECTION = '1';
await import('./start-desktop.mjs');
