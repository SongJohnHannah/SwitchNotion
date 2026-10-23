import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { stateRoot, rollbackRuntime } from './runtime-update.mjs';

const mode = process.argv[2], parentPid = Number(process.argv[3]);
if (!['update', 'rollback'].includes(mode) || !Number.isSafeInteger(parentPid) || parentPid <= 0 || parentPid === process.pid || !process.connected) throw Error('Invalid update helper invocation');
process.send({ ready: true });
const alive = () => { try { process.kill(parentPid, 0); return true; } catch { return false; } };
const until = Date.now() + 30000;
while (alive() && Date.now() < until) await sleep(250);
if (alive()) {
  fs.writeFileSync(path.join(stateRoot, 'update-status.json'), JSON.stringify({ status: 'blocked', message: '原型尚未完全退出，更新未应用。请退出原型后重新启动。', checkedAt: new Date().toISOString() }));
  process.exit(1);
}
if (mode === 'rollback') rollbackRuntime();
process.env.NOTION_SWITCH_FORCE_UPDATE = mode === 'update' ? '1' : '0';
process.env.NOTION_SWITCH_OPEN_SETTINGS = '1'; process.env.NOTION_SWITCH_UPDATE_VIEW = '1';
process.argv = [process.execPath, fileURLToPath(new URL('./start-desktop.mjs', import.meta.url))];
await import('./start-desktop.mjs');
