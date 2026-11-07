'use strict';
const { GpuOperatorClient } = require('./operator-client.cjs');
const turbo = 'large-v3-turbo';
const methods = ['status', 'configure', 'probe', 'transcribeDetailed', 'transcribe', 'transcribeWav', 'transcribeRecording', 'retain', 'release', 'close'];
const profile = Object.freeze({ platform: 'win32', architecture: 'x64', supported: true, provider: 'faster-whisper', model: turbo,
  device: 'cuda', hardwareLabel: 'NVIDIA GPU', offline: true });

// Only an app facade: all inference, worker lifetime and GPU lease ownership
// stay inside the shared package's session. Missing packages never create the
// legacy provider or install a second Python/CUDA environment.
class OperatorSessionClient {
  constructor({ root, idleMs, timeoutMs, ...operatorOptions } = {}) {
    this.client = new GpuOperatorClient({ root, ...operatorOptions });
    this.options = { ...(idleMs !== undefined ? { idleMs } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
    this.session = null; this.lastFailure = ''; this.operatorSession = true;
    this.unavailablePlatform = { profile, withModel: model => { if (model !== turbo) throw Error('独立 GPU 算子只支持 Whisper Large-v3 Turbo。'); return this.platform; },
      environment: () => { throw Error(this.lastFailure || '独立 GPU 算子尚未配置。'); } };
  }
  getSession() {
    try {
      if (this.session) {
        const status = this.session.status();
        if (status.device !== 'cuda' || status.model !== turbo) throw Error('独立录音会话必须使用 NVIDIA GPU 和 Large-v3 Turbo，未改用旧引擎。');
        return this.session;
      }
      const operator = this.client.load();
      if (typeof operator.createSpeechSession !== 'function') throw Object.assign(Error('独立 GPU 算子尚未提供 createSpeechSession；请更新同一独立包。'), { code: 'GPU_OPERATOR_SESSION_UNAVAILABLE' });
      const session = operator.createSpeechSession(this.options);
      if (!session || methods.some(method => typeof session[method] !== 'function')) throw Error('独立 GPU 算子的录音会话接口不完整。');
      const status = session.status();
      if (status.device !== 'cuda' || status.model !== turbo) throw Error('独立录音会话必须使用 NVIDIA GPU 和 Large-v3 Turbo，未改用旧引擎。');
      this.session = session; this.lastFailure = ''; return session;
    } catch (error) { this.lastFailure = error.message; throw error; }
  }
  status() {
    try {
      const status = this.getSession().status();
      return { ...status, ...profile, configured: status.configured === true, resourcesReady: status.configured === true,
        ready: status.ready === true && status.loaded === true, loaded: status.loaded === true, busy: status.busy === true,
        operatorSession: true, lastFailure: this.lastFailure || status.lastFailure || '' };
    } catch {
      return { ...profile, configured: false, resourcesReady: false, ready: false, loaded: false, busy: false,
        operatorSession: true, lastFailure: this.lastFailure };
    }
  }
  get runtime() { try { return this.getSession().runtime || null; } catch { return null; } }
  get leases() { return this.session?.leases || 0; }
  get platform() { try { return this.getSession().platform || this.unavailablePlatform; } catch { return this.unavailablePlatform; } }
  async call(method, options) {
    options?.signal?.throwIfAborted();
    try {
      const result = await this.getSession()[method](options);
      this.getSession();
      options?.signal?.throwIfAborted(); this.lastFailure = ''; return result;
    } catch (error) { this.lastFailure = error.message; throw error; }
  }
  configure(options) { return this.call('configure', options); }
  probe(options) { return this.call('probe', options); }
  transcribeDetailed(options) { return this.call('transcribeDetailed', options); }
  transcribe(options) { return this.call('transcribe', options); }
  transcribeWav(options) { return this.call('transcribeWav', options); }
  transcribeRecording(options) { return this.call('transcribeRecording', options); }
  retain() { return this.getSession().retain(); }
  release() { return this.session?.release(); }
  close() { return this.session?.close(); }
}
module.exports = { OperatorSessionClient };
