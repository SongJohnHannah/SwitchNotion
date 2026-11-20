const fs = require('node:fs');
const path = require('node:path');
const { NotionSmartService } = require('./notion-smart-service.cjs');
const { readState } = require('./notion-smart-launch.cjs');

const root = process.env.NOTION_SMART_ROOT, executable = process.env.NOTION_SMART_CADDY;
const runId = process.env.NOTION_SMART_RUN_ID, port = Number(process.env.NOTION_SMART_PORT || 0);
if (!root || !path.isAbsolute(root) || !executable || !path.isAbsolute(executable) || !/^[a-f\d-]{36}$/i.test(runId || '') || !Number.isInteger(port) || port < 0 || port > 65535) process.exit(2);
const directory = path.join(root, 'smart-direct'), stateFile = path.join(directory, 'state.json');
const ownerFile = path.join(directory, 'owner-' + runId + '.json');
const stopFile = path.join(directory, 'stop-' + runId);
const refreshFile = path.join(directory, 'refresh-' + runId);
fs.mkdirSync(directory, { recursive: true });
const previous = readState(root);
let ownerPid = null, closing = false, retrying = false, ownerDeadline = Date.now() + 60000, lastRefresh = 0;
function writeState(status) {
  const active = readState(root);
  if (active && active.runId !== runId && active.runId !== previous?.runId) return;
  const value = { version: 1, scope: 'media', runId, supervisorPid: process.pid, ownerPid, updatedAt: new Date().toISOString(), ...status };
  const temporary = path.join(directory, 'state-' + runId + '.tmp');
  try { fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, stateFile); }
  catch { try { fs.unlinkSync(temporary); } catch {} }
}
const service = new NotionSmartService({ root, executable, port, previous, notify: writeState });
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function close(failure) {
  if (closing) return; closing = true;
  clearInterval(timer); service.stop();
  for (const file of [ownerFile, stopFile, refreshFile]) try { fs.unlinkSync(file); } catch {}
  if (failure) writeState({ state: 'error', message: String(failure).slice(0, 200) });
  process.exit(failure ? 1 : 0);
}
async function refresh() {
  if (closing || !service.process || service.refreshTask) return;
  lastRefresh = Date.now();
  try { await service.refresh(); }
  catch { if (!closing && service.process) service.update({ message: '部分域名测速未完成，保留上一次可用地址。' }); }
}
const timer = setInterval(() => {
  if (closing) return;
  if (fs.existsSync(stopFile)) return close();
  if (!ownerPid && fs.existsSync(ownerFile)) {
    try { const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); if (owner.runId === runId && Number.isInteger(owner.pid) && owner.pid > 0) { ownerPid = owner.pid; writeState(service.status); } } catch {}
  }
  if (ownerPid && !alive(ownerPid) || !ownerPid && Date.now() > ownerDeadline) return close();
  if (fs.existsSync(refreshFile)) { try { fs.unlinkSync(refreshFile); } catch {} void refresh(); }
  if (ownerPid && !service.process && !retrying) {
    retrying = true; void service.start().then(() => refresh()).catch(() => {}).finally(() => { retrying = false; });
  } else if (ownerPid && service.process && Date.now() - lastRefresh >= 5 * 60 * 1000) void refresh();
}, 3000);
process.on('SIGINT', close); process.on('SIGTERM', close);
retrying = true;
service.start().then(() => refresh()).catch(error => close(error.message || '媒体直连服务启动失败')).finally(() => { retrying = false; });
