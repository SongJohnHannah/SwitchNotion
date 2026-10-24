const path = require('node:path');
const { spawn } = require('node:child_process');
const { discover, worker } = require('./discovery.cjs');
const { createSpeechPlatform } = require('./platform.cjs');
const { decodeWav, validatePcm } = require('./wav.cjs');
class SpeechProvider {
  constructor({ root, runtime, platform = createSpeechPlatform(), spawnImpl = spawn, discoverImpl = discover, idleMs = 20000, timeoutMs = 120000 } = {}) {
    if (!root || !path.isAbsolute(root)) throw Error('请指定离线语音资源的绝对目录。');
    Object.assign(this, { root, platform, spawnImpl, discoverImpl, idleMs, timeoutMs });
    try { this.runtime = runtime ? platform.normalizeRuntime(runtime) : null; } catch { this.runtime = null; }
    this.child = null; this.current = null; this.sequence = 0; this.queue = Promise.resolve(); this.initializing = null;
    this.checked = false; this.epoch = 0; this.leases = 0; this.idle = null;
  }
  status() {
    return { ...this.platform.profile, protocolVersion: 1, configured: !!this.runtime,
      ready: this.checked, loaded: !!this.child && this.checked, busy: !!this.current, languages: ['auto', 'zh', 'en'] };
  }
  async configure() {
    this.platform.requireSupported();
    this.runtime = this.platform.normalizeRuntime(this.runtime || await this.discoverImpl(this.root, { platform: this.platform }));
    return this.runtime;
  }
  async start() {
    clearTimeout(this.idle);
    if (this.initializing) return this.initializing;
    if (this.child && this.checked) return;
    const epoch = this.epoch;
    this.initializing = (async () => {
      const runtime = await this.configure();
      if (epoch !== this.epoch) throw Error('离线转写已停止。');
      const child = this.spawnImpl(runtime.pythonExecutable, [worker, '--root', this.root], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: this.platform.environment(this.root) });
      this.child = child; let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', value => {
        buffer += value;
        if (buffer.length > 2 * 1024 * 1024) { this.fail(child, Error('离线转写进程返回过多数据。')); return; }
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); let message;
          try { message = JSON.parse(line); } catch { this.fail(child, Error('离线转写进程返回无效结果。')); return; }
          const job = this.current;
          if (job?.child !== child || message.id !== job.id) continue;
          message.ok ? job.finish(null, message.result) : job.finish(Error('本机离线转写失败，请在配置中重新检测。'));
        }
      });
      const ended = () => { if (this.child === child) { this.child = null; this.checked = false; } if (this.current?.child === child) this.current.finish(Error('离线转写进程已退出。')); };
      child.on('error', ended); child.on('exit', ended);
      const configured = await this.exchange(child, 'configure', { protocolVersion: 1, runtime });
      if (configured?.protocolVersion !== 1 || ['provider', 'model', 'platform', 'architecture', 'device', 'computeType']
        .some(key => configured[key] !== this.platform.profile[key])) throw Error('本机语音进程版本或平台不匹配，请重新检测。');
      if (this.child !== child) throw Error('离线转写已停止。');
      this.checked = true;
    })().catch(error => { const child = this.child; this.child = null; this.checked = false; child?.kill(); throw error; })
      .finally(() => { this.initializing = null; });
    return this.initializing;
  }
  fail(child, error) { if (this.current?.child === child) this.current.finish(error); if (this.child === child) { this.child = null; this.checked = false; } child.kill(); }
  exchange(child, type, fields = {}, signal) {
    signal?.throwIfAborted(); const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (this.current?.id === id) this.current = null; error ? reject(error) : resolve(result); };
      const abort = () => this.fail(child, signal.reason || Error('离线转写已取消。'));
      const timer = setTimeout(() => this.fail(child, Error('本机离线转写超时，请停止后重新开始。')), this.timeoutMs);
      this.current = { id, child, finish }; signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n', 'utf8', error => { if (error) this.fail(child, Error('无法向离线转写进程发送音频。')); }); }
      catch { this.fail(child, Error('离线转写进程不可用。')); }
    });
  }
  request(type, fields, signal) {
    const epoch = this.epoch;
    const run = async () => {
      signal?.throwIfAborted(); if (epoch !== this.epoch) throw Error('离线转写已停止。');
      await this.start(); signal?.throwIfAborted();
      try { return await this.exchange(this.child, type, fields, signal); }
      finally { this.scheduleRelease(); }
    };
    const next = this.queue.then(run); this.queue = next.catch(() => {}); return next;
  }
  async probe({ signal } = {}) { await this.request('probe', {}, signal); return this.status(); }
  async transcribe({ pcm, language = 'auto', signal }) {
    validatePcm(pcm); if (!['auto', 'zh', 'en'].includes(language)) throw Error('请选择自动识别、中文或英文。');
    const result = await this.request('transcribe', { audio: pcm.toString('base64'), language }, signal);
    if (typeof result?.text !== 'string') throw Error('本机离线转写没有返回文字。');
    return result.text;
  }
  async transcribeWav({ wav, language = 'auto', signal, onProgress = () => {} }) {
    const { pcm } = decodeWav(wav), texts = [], limit = 30 * 16000 * 4; this.retain();
    try { for (let at = 0; at < pcm.length; at += limit) { texts.push(await this.transcribe({ pcm: pcm.subarray(at, Math.min(pcm.length, at + limit)), language, signal })); onProgress(Math.min(1, (at + limit) / pcm.length)); } return texts.filter(Boolean).join('\n'); }
    finally { this.release(); }
  }
  retain() { this.leases++; clearTimeout(this.idle); }
  release() { this.leases = Math.max(0, this.leases - 1); this.scheduleRelease(); }
  scheduleRelease() { clearTimeout(this.idle); if (!this.leases && !this.current) { this.idle = setTimeout(() => this.close(), this.idleMs); this.idle.unref?.(); } }
  close() { this.epoch++; clearTimeout(this.idle); const child = this.child; this.child = null; this.checked = false; this.current?.finish(Error('离线转写已停止。')); child?.kill(); }
}
module.exports = { SpeechProvider, decodeWav };
