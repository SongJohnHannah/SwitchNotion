const fs = require('node:fs');
const path = require('node:path');
const { SpeechProvider } = require('../speech-provider.cjs');
class SpeechSettings {
  constructor({ root, provider, isBusy = () => false, chooseWav, onChange = () => {} } = {}) {
    Object.assign(this, { root, isBusy, chooseWav, onChange });
    this.file = path.join(root, 'speech.local.json'); this.lastError = ''; this.preparing = false;
    let saved; try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { saved = {}; }
    this.enabled = saved.enabled === true;
    this.provider = provider || new SpeechProvider({ root, runtime: saved.runtime });
    this.testAbort = null;
  }
  status() { return { ...this.provider.status(), enabled: this.enabled, preparing: this.preparing,
    lastError: this.lastError, modelName: 'Whisper Medium', engineName: 'faster-whisper',
    summaryUsesNetwork: true, nativeMeetingAdapter: !!this.native?.status().available }; }
  save() {
    const { provider, model, platform, architecture, device, computeType } = this.provider.status();
    fs.writeFileSync(this.file, JSON.stringify({ version: 2, provider, model, platform, architecture,
      device, computeType, enabled: this.enabled, runtime: this.provider.runtime }, null, 2) + '\n', { mode: 0o600, flush: true });
  }
  async prepare() {
    if (this.preparing || this.provider.status().busy || this.provider.leases) throw Error('离线引擎正在工作，请稍后重试。');
    this.preparing = true; this.lastError = '';
    try { await this.provider.configure(); await this.provider.probe(); this.save(); return this.status(); }
    catch (error) { this.lastError = '本机离线引擎检测失败，请检查 faster-whisper、Medium 模型和当前系统运行环境。'; throw error; }
    finally { this.preparing = false; }
  }
  async request(action, input = {}) {
    const fields = action === 'speech.save' ? ['enabled'] : [];
    if (!['speech.status', 'speech.prepare', 'speech.probe', 'speech.save', 'speech.test', 'speech.release'].includes(action) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k))) return { ok: false, error: '无法识别这项离线语音操作。' };
    try {
      if (action === 'speech.status') return { ok: true, result: this.status() };
      if (this.isBusy() && action !== 'speech.save') throw Error('Notion 任务正在执行，请结束后再检测或测试语音。');
      if (action === 'speech.prepare' || action === 'speech.probe') {
        await this.prepare(); return { ok: true, result: { ...this.status(), message: `已检测到 Medium 中英文模型，${this.provider.status().hardwareLabel} 离线引擎就绪。` } };
      }
      if (action === 'speech.save') {
        if (typeof input.enabled !== 'boolean') throw Error('请选择是否启用离线转写。');
        if (this.provider.leases) throw Error('请先停止录音，再更改离线转写设置。');
        if (input.enabled && !this.provider.runtime) await this.prepare();
        this.enabled = input.enabled; this.save(); await this.onChange(this.enabled);
        return { ok: true, result: { ...this.status(), message: '离线语音设置已保存。' } };
      }
      if (action === 'speech.release') {
        if (this.provider.leases) throw Error('仍有录音正在转写，请先停止录音。');
        this.testAbort?.abort(); this.provider.close(); return { ok: true, result: { ...this.status(), message: '已结束本机语音进程并释放资源。' } };
      }
      if (this.testAbort || this.provider.leases) throw Error('已有录音正在转写，请等待完成。');
      const file = await this.chooseWav?.(); if (!file) return { ok: true, result: { cancelled: true } };
      if (!fs.statSync(file).isFile() || fs.statSync(file).size > 128 * 1024 * 1024) throw Error('测试录音过大，请选择不超过 10 分钟的 WAV。');
      this.testAbort = new AbortController();
      try {
        const start = Date.now(), text = await this.provider.transcribeWav({ wav: fs.readFileSync(file), signal: this.testAbort.signal });
        return { ok: true, result: { text, elapsedMs: Date.now() - start, message: '本机转写完成，录音和文字未发送给云端。' } };
      } finally { this.testAbort = null; }
    } catch (error) {
      const known = /^(?:离线|Notion |本机|请选择|仍有|已有|测试录音|请使用|请先|未找到|音频)/.test(error.message || '');
      return { ok: false, error: known ? error.message : '离线语音操作失败，请重新检测本机引擎。' };
    }
  }
  close() { this.testAbort?.abort(); this.provider.close(); }
}
module.exports = { SpeechSettings };
