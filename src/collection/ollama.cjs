const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const endpoint = 'http://127.0.0.1:11434';
const autoStartPort = 21434;

function candidates(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return ['/Applications/Ollama.app/Contents/Resources/ollama', '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama'];
  return [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'), env.ProgramFiles && path.join(env.ProgramFiles, 'Ollama', 'ollama.exe')];
}

class OllamaService {
  constructor({ fetchImpl = fetch, spawnImpl = spawn, platform = process.platform, env = process.env, executable = '', timeoutMs = 60000, startPort = autoStartPort } = {}) {
    Object.assign(this, { fetchImpl, spawnImpl, platform, env, executable, timeoutMs, startPort });
    this.starting = null; this.active = '';
  }
  async available(signal) {
    return (await this.reachable(signal)) || (await this.reachable(signal, 'http://127.0.0.1:' + this.startPort));
  }
  async reachable(signal, base = endpoint) {
    const timeout = AbortSignal.timeout(1500), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try { return (await this.fetchImpl(base + '/api/tags', { signal: combined })).ok; }
    catch { return false; }
  }
  locate() {
    const found = [this.executable, this.env.OLLAMA_EXE, ...candidates(this.platform, this.env)].filter(Boolean).find(file => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    });
    if (!found) throw Error('未找到 Ollama，请先安装，或用 OLLAMA_EXE 指定可执行文件。');
    return found;
  }
  async ensure(signal) {
    if (this.active && await this.reachable(signal, this.active)) return this.active;
    if (await this.reachable(signal)) { this.active = endpoint; return this.active; }
    if (!this.starting) this.starting = this.start(signal).finally(() => { this.starting = null; });
    return this.starting;
  }
  async start(signal) {
    if (await this.reachable(signal)) { this.active = endpoint; return this.active; }
    const fallback = 'http://127.0.0.1:' + this.startPort;
    if (await this.reachable(signal, fallback)) { this.active = fallback; return fallback; }
    const executable = this.locate();
    // Windows may reserve the default port at boot; OLLAMA_HOST moves this
    // instance to a port outside the excluded ranges without touching others.
    try {
      const child = this.spawnImpl(executable, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...this.env, OLLAMA_HOST: '127.0.0.1:' + this.startPort } });
      child.unref?.();
    } catch (error) { throw Error('无法启动本机 Ollama：' + error.message); }
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) signal.throwIfAborted();
      if (await this.reachable(signal, fallback)) { this.active = fallback; return fallback; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw Error('已尝试启动本机 Ollama，但服务尚未就绪；请手动打开 Ollama 后重试。');
  }
}

module.exports = { OllamaService };
