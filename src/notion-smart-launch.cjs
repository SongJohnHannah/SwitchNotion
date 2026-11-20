const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

function statePath(root) { return path.join(root, 'smart-direct', 'state.json'); }
function readState(root) { try { const state = JSON.parse(fs.readFileSync(statePath(root), 'utf8')); return state?.version === 1 ? state : null; } catch { return null; } }
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function executable(root, project, platform = process.platform, arch = process.arch) {
  const osName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : '';
  const machine = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : '';
  if (!osName || !machine) return '';
  const target = osName + '-' + machine;
  const candidates = [path.join(root, 'caddy-route', target, 'caddy'), path.join(project, 'bin', 'caddy', target, 'caddy')];
  return candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile()) || '';
}
function start({ root, project, nodeExecutable = process.execPath, port = 0 } = {}) {
  const binary = executable(root, project);
  const directory = path.join(root, 'smart-direct'); fs.mkdirSync(directory, { recursive: true });
  const previous = readState(root);
  if (/^[a-f\d-]{36}$/i.test(previous?.runId || '') && previous.supervisorPid && isAlive(previous.supervisorPid)) {
    if (previous.ownerPid && isAlive(previous.ownerPid)) throw Error('已有 Notion 直连服务正在使用中。');
    request(root, 'stop', previous.runId);
  }
  const runId = randomUUID();
  const fail = message => {
    const current = readState(root);
    if (current && current.runId !== runId && current.runId !== previous?.runId) return;
    const file = path.join(directory, 'startup-' + runId + '.tmp');
    try {
      fs.writeFileSync(file, JSON.stringify({ version: 1, scope: 'media', runId, state: 'error', message }), { mode: 0o600 });
      fs.renameSync(file, statePath(root));
    } catch { try { fs.unlinkSync(file); } catch {} }
  };
  if (!binary) {
    fail('缺少图片和视频直连组件，请先准备 Caddy。');
    return { runId, supervisorPid: null };
  }
  const child = spawn(nodeExecutable, [path.join(project, 'src', 'notion-smart-daemon.cjs')], {
    detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, NOTION_SMART_ROOT: root, NOTION_SMART_CADDY: binary,
      NOTION_SMART_RUN_ID: runId, NOTION_SMART_PORT: String(port) }
  });
  child.once('error', () => fail('未能启动图片和视频直连组件。'));
  child.unref();
  return { runId, supervisorPid: child.pid };
}
function bind(root, instance, ownerPid) {
  if (!instance || !/^[a-f\d-]{36}$/i.test(instance.runId || '') || !Number.isInteger(ownerPid) || ownerPid < 1) throw Error('Invalid Notion direct service owner.');
  fs.writeFileSync(path.join(root, 'smart-direct', 'owner-' + instance.runId + '.json'), JSON.stringify({ runId: instance.runId, pid: ownerPid }), { mode: 0o600 });
}
function request(root, action, runId) {
  if (!['stop', 'refresh'].includes(action) || !/^[a-f\d-]{36}$/i.test(runId || '')) throw Error('Invalid Notion direct service request.');
  fs.writeFileSync(path.join(root, 'smart-direct', action + '-' + runId), action, { mode: 0o600 });
}
function mediaPort(root, runId, host) {
  const state = readState(root);
  if (state?.scope !== 'media' || state.runId !== runId || state.state !== 'ready' ||
      !Object.hasOwn(state.selections || {}, host) || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535) return 0;
  return state.port;
}
module.exports = { start, bind, request, readState, mediaPort, executable };
