const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
function nodeExecutable(root) {
  if (!process.versions.electron) return process.execPath;
  let configured;
  try { configured = JSON.parse(fs.readFileSync(path.join(root, 'launcher.local.json'), 'utf8')).nodeExecutable; } catch {}
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [configured, ...(process.env.PATH || '').split(path.delimiter).map(directory => path.join(directory, name)), '/opt/homebrew/bin/node', '/usr/local/bin/node'];
  for (const candidate of candidates) { try { if (typeof candidate === 'string' && path.isAbsolute(candidate) && fs.realpathSync(candidate) !== fs.realpathSync(process.execPath) && fs.statSync(candidate).isFile()) return candidate; } catch {} }
  throw Error('媒体下载需要 Switch Notion 启动器使用的 Node.js，请从应用启动入口重新打开。');
}
function run(file, args, { signal, timeout = 2400000, input, maxBytes = 16 * 1024 ** 2, env = process.env, detached = false } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env, detached: detached && process.platform !== 'win32' });
    let stdout = '', stderr = '', finished = false, failure;
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === 'win32' && detached) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else if (detached) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      else child.kill();
    };
    const abort = () => { failure = signal.reason || Error('操作已停止。'); kill(); };
    const timer = setTimeout(() => { failure = Error('媒体处理超时，进度已保留。'); kill(); }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    const finish = error => {
      if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { error.stderr = stderr; error.stdout = stdout; reject(error); } else resolve({ stdout, stderr });
    };
    child.stdout.on('data', b => { stdout += b.toString(); if (Buffer.byteLength(stdout) > maxBytes) { failure = Error('媒体处理输出过大。'); kill(); } });
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-maxBytes); });
    child.once('error', finish); child.once('close', code => finish(failure || (code !== 0 ? Error('媒体处理程序未成功结束。') : null)));
    child.stdin.on('error', () => {}); child.stdin.end(input || '');
  });
}
function workerEnvironment(binDirectory) {
  const allow = /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|USERPROFILE|LOCALAPPDATA|APPDATA|HOME|LANG|LC_ALL|LC_CTYPE)$/i;
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => allow.test(k))), PATH: binDirectory + path.delimiter + (process.env.PATH || ''), ELECTRON_RUN_AS_NODE: '1', MEDIAKIT_BIN_DIR: binDirectory };
}
module.exports = { run, workerEnvironment, nodeExecutable };
