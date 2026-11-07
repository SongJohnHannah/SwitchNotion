const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { discover, worker } = require('./discovery.cjs');
const { createSpeechPlatform } = require('./platform.cjs');
const { decodeWav, validatePcm } = require('./wav.cjs');
const { transcriptQualityIssue } = require('./transcript-quality.cjs');
class SpeechProvider {
  constructor({ root, runtime, model = runtime?.model || 'medium',
    platform = createSpeechPlatform({ model, computeType: runtime?.device === 'cuda' ? runtime.computeType || 'auto' : 'auto' }), spawnImpl = spawn, discoverImpl = discover, idleMs = 20000, timeoutMs = 120000 } = {}) {
    if (!root || !path.isAbsolute(root)) throw Error('请指定离线语音资源的绝对目录。');
    Object.assign(this, { root, platform, spawnImpl, discoverImpl, idleMs, timeoutMs });
    try { this.runtime = runtime ? platform.normalizeRuntime(runtime) : null; } catch { this.runtime = null; }
    this.child = null; this.current = null; this.sequence = 0; this.queue = Promise.resolve(); this.initializing = null;
    this.checked = false; this.epoch = 0; this.leases = 0; this.idle = null;
    this.stderrTail = ''; this.lastFailure = '';
    this.terminating = Promise.resolve();
  }
  status() {
    return { ...this.platform.profile, protocolVersion: 1, configured: !!this.runtime,
      ready: this.checked, loaded: !!this.child && this.checked, busy: !!this.current,
      lastFailure: this.lastFailure, lastWorkerExit: this.lastWorkerExit || null, languages: ['auto', 'zh', 'en'] };
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
      await this.terminating;
      const runtime = await this.configure();
      if (epoch !== this.epoch) throw Error('离线转写已停止。');
      this.stderrTail = '';
      const child = this.spawnImpl(runtime.pythonExecutable, [worker, '--root', this.root], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: this.platform.environment(this.root) });
      this.child = child; let buffer = '';
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', value => { this.stderrTail = (this.stderrTail + value).slice(-8192); });
      }
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
      const ended = (code, signal, spawnError) => { if (this.child === child) { this.child = null; this.checked = false; } if (this.current?.child === child) this.current.finish(this.exitError(code, signal, spawnError)); };
      child.on('error', error => ended(null, null, error)); child.on('exit', ended);
      const configured = await this.exchange(child, 'configure', { protocolVersion: 1, runtime });
      if (configured?.protocolVersion !== 1 || ['provider', 'model', 'platform', 'architecture', 'device', 'computeType']
        .some(key => configured[key] !== this.platform.profile[key])) throw Error('本机语音进程版本或平台不匹配，请重新检测。');
      if (this.child !== child) throw Error('离线转写已停止。');
      this.checked = true;
    })().catch(error => { const child = this.child; this.child = null; this.checked = false; this.terminateWorker(child); throw error; })
      .finally(() => { this.initializing = null; });
    return this.initializing;
  }
  detail() {
    const lines = this.stderrTail.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return lines.slice(-2).join(' ').slice(-240);
  }
  exitError(code = null, signal = null, spawnError) {
    const detail = this.detail();
    const hexCode = Number.isInteger(code) ? '0x' + (code >>> 0).toString(16).padStart(8, '0') : null;
    this.lastWorkerExit = { code, hexCode, signal, ...(spawnError?.code ? { spawnCode: spawnError.code } : {}) };
    const error = Error('离线转写进程已退出。' + (hexCode ? '退出码：' + hexCode + '。' : signal ? '信号：' + signal + '。' : '') + (detail ? ' ' + detail : ''));
    this.lastFailure = error.message;
    return error;
  }
  terminateWorker(child) {
    if (!child) return this.terminating;
    // A Windows venv python.exe can be a launcher with a real interpreter
    // child. Terminate the owned tree before loading another CUDA context.
    if (process.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
      const stopped = new Promise(resolve => execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => { if (child.exitCode == null) child.kill(); resolve(); }));
      this.terminating = Promise.all([this.terminating, stopped]).then(() => {});
    } else { child.kill(); }
    return this.terminating;
  }
  fail(child, error) { this.lastFailure = error.message; if (this.current?.child === child) this.current.finish(error); if (this.child === child) { this.child = null; this.checked = false; } this.terminateWorker(child); }
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
  request(type, fields, signal, onResult) {
    const epoch = this.epoch;
    const run = async () => {
      signal?.throwIfAborted(); if (epoch !== this.epoch) throw Error('离线转写已停止。');
      try {
        await this.start(); signal?.throwIfAborted();
        const result = await this.exchange(this.child, type, fields, signal);
        if (type === 'transcribe' || type === 'transcribe_recording') {
          await onResult?.(result);
          const issue = transcriptQualityIssue(result?.text);
          if (issue) {
            const error = Object.assign(Error(issue), { code: 'SPEECH_UNRELIABLE' });
            if (this.child) this.fail(this.child, error);
            throw error;
          }
        }
        return result;
      }
      finally { this.scheduleRelease(); }
    };
    const next = this.queue.then(run); this.queue = next.catch(() => {}); return next;
  }
  async probe({ signal } = {}) { await this.request('probe', {}, signal); return this.status(); }
  async transcribeDetailed({ pcm, language = 'auto', context = '', signal, onResult }) {
    validatePcm(pcm); if (!['auto', 'zh', 'en'].includes(language)) throw Error('请选择自动识别、中文或英文。');
    if (typeof context !== 'string' || context.length > 400 || /[\u0000-\u0008]/.test(context)) throw Error('音频上下文格式无效。');
    const result = await this.request('transcribe', { audio: pcm.toString('base64'), language, context }, signal, onResult);
    if (typeof result?.text !== 'string') throw Error('本机离线转写没有返回文字。');
    return { text: result.text, context: typeof result.contextText === 'string' ? result.contextText.slice(-120) : '', language: result.language };
  }
  async transcribe(options) { return (await this.transcribeDetailed(options)).text; }
  async transcribeRecording({ audio, signal }) {
    if (!Buffer.isBuffer(audio) || audio.length < 4 || audio.length > 16 * 1024 * 1024 || audio.readUInt32BE() !== 0x1a45dfa3) throw Error('音频录音格式无效。');
    const result = await this.request('transcribe_recording', { audio: audio.toString('base64') }, signal);
    if (typeof result?.text !== 'string') throw Error('本机离线转写没有返回文字。'); return result.text;
  }
  async transcribeWav({ wav, language = 'auto', signal, onProgress = () => {}, onResult, chunkSeconds = 30 }) {
    if (!Number.isInteger(chunkSeconds) || chunkSeconds < 1 || chunkSeconds > 30) throw Error('语音分段须为 1 到 30 秒。');
    const { pcm } = decodeWav(wav), texts = [], limit = chunkSeconds * 16000 * 4; this.retain();
    try { for (let at = 0; at < pcm.length; at += limit) { texts.push(await this.transcribe({ pcm: pcm.subarray(at, Math.min(pcm.length, at + limit)), language, signal,
      onResult: onResult && (result => onResult({ ...result, start: at / 64000, duration: Math.min(limit, pcm.length - at) / 64000 })) })); onProgress(Math.min(1, (at + limit) / pcm.length)); } return texts.filter(Boolean).join('\n'); }
    finally { this.release(); }
  }
  retain() { this.leases++; clearTimeout(this.idle); }
  release() { this.leases = Math.max(0, this.leases - 1); this.scheduleRelease(); }
  scheduleRelease() { clearTimeout(this.idle); if (!this.leases && !this.current) { this.idle = setTimeout(() => this.close(), this.idleMs); this.idle.unref?.(); } }
  close() { this.epoch++; clearTimeout(this.idle); const child = this.child; this.child = null; this.checked = false; this.current?.finish(Error('离线转写已停止。')); return this.terminateWorker(child); }
}
module.exports = { SpeechProvider, decodeWav };
