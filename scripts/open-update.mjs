import fs from 'node:fs';
import path from 'node:path';
import { stateRoot } from './runtime-update.mjs';
const control = path.join(stateRoot, 'control.json');
if (fs.existsSync(control)) {
  const info = JSON.parse(fs.readFileSync(control, 'utf8')), headers = { authorization: `Bearer ${info.token}` }, url = `http://127.0.0.1:${info.port}`;
  let status;
  try { const response = await fetch(url + '/status', { headers, signal: AbortSignal.timeout(1500) }); if (response.ok) status = await response.json(); } catch {}
  if (status) {
    if (status.activeTurns) throw Error('AI 正在工作，请等待完成或停止后再更新。');
    await fetch(url + '/quit', { method: 'POST', headers, signal: AbortSignal.timeout(1500) });
    let closed = false;
    for (let i = 0; i < 80; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      let serverClosed = false;
      try { await fetch(url + '/status', { headers, signal: AbortSignal.timeout(500) }); } catch { serverClosed = true; }
      let processClosed = false; try { process.kill(info.pid, 0); } catch (error) { processClosed = error.code === 'ESRCH'; }
      if (serverClosed && processClosed) { closed = true; break; }
    }
    if (!closed) throw Error('原型尚未完全退出，更新未应用。请退出原型后重试。');
  }
}
process.env.NOTION_SWITCH_FORCE_UPDATE = '1'; process.env.NOTION_SWITCH_OPEN_SETTINGS = '1'; process.env.NOTION_SWITCH_UPDATE_VIEW = '1';
await import('./start-desktop.mjs');
