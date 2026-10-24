const fs = require('node:fs');
const path = require('node:path');
const { SpeechProvider } = require('../speech-provider.cjs');
const { RecordingTest } = require('./recording-test.cjs');
const { install } = require('./install.cjs');
const models = require('./models.json');
class SpeechSettings {
  constructor({ root, provider, isBusy = () => false, installImpl = install, onChange = () => {}, runtimeExists = runtime => fs.existsSync(runtime.pythonExecutable) && fs.existsSync(path.join(runtime.modelDirectory, 'model.bin')) } = {}) {
    Object.assign(this, { root, isBusy, installImpl, onChange, runtimeExists });
    this.file = path.join(root, 'speech.local.json'); this.lastError = ''; this.preparing = false;
    let saved; try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { saved = {}; }
    this.enabled = saved.enabled === true;
    const model = Object.hasOwn(models, saved.model) ? saved.model : 'medium';
    this.provider = provider || new SpeechProvider({ root, runtime: saved.runtime, model });
    this.progress = null; this.capture = new RecordingTest({ provider: this.provider, isBusy });
  }
  get recording() { return this.capture.active; }
  status() { return { ...this.provider.status(), enabled: this.enabled, preparing: this.preparing,
    lastError: this.lastError, progress: this.progress, recording: this.recording, modelName: models[this.provider.status().model || 'medium']?.name, engineName: 'faster-whisper',
    summaryUsesNetwork: true, nativeMeetingAdapter: !!this.native?.status().available }; }
  save() {
    const { provider, model, platform, architecture, device, computeType } = this.provider.status();
    fs.writeFileSync(this.file, JSON.stringify({ version: 2, provider, model, platform, architecture,
      device, computeType, enabled: this.enabled, runtime: this.provider.runtime }, null, 2) + '\n', { mode: 0o600, flush: true });
  }
  async prepare() {
    if (this.preparing || this.provider.status().busy || this.provider.leases) throw Error('离线引擎正在工作，请稍后重试。');
    this.preparing = true; this.lastError = '';
    this.installAbort = new AbortController();
    try {
      if (this.provider.runtime && !this.runtimeExists(this.provider.runtime)) this.provider.runtime = null;
      let installed = false;
      const ready = async () => {
        try { await this.provider.configure(); }
        catch (error) {
          if (error.code !== 'SPEECH_RUNTIME_NOT_FOUND') throw error;
          installed = true;
          this.provider.runtime = await this.installImpl({ root: this.root, platform: this.provider.platform, signal: this.installAbort.signal, onProgress: value => { this.progress = value; } });
          await this.provider.configure();
        }
        await this.provider.probe();
      };
      try { await ready(); }
      catch (error) {
        if (installed || error.code === 'SPEECH_PLATFORM_UNSUPPORTED' || this.installAbort.signal.aborted) throw error;
        this.provider.close(); this.provider.runtime = null;
        await ready();
      }
      this.save(); this.progress = null; return this.status();
    }
    catch (error) { this.lastError = '本机离线引擎检测失败，请检查 faster-whisper、所选模型和当前系统运行环境。'; throw error; }
    finally { this.preparing = false; this.installAbort = null; }
  }
  async request(action, input = {}) {
    const fields = action === 'speech.save' ? ['enabled', 'model'] : action === 'speech.record.finish' ? ['recordingId', 'audio', 'mimeType'] : action === 'speech.record.cancel' ? ['recordingId'] : [];
    if (!['speech.status', 'speech.prepare', 'speech.probe', 'speech.save', 'speech.record.start', 'speech.record.finish', 'speech.record.cancel', 'speech.release'].includes(action) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k))) return { ok: false, error: '无法识别这项离线语音操作。' };
    try {
      if (action === 'speech.status') return { ok: true, result: this.status() };
      if (action === 'speech.record.cancel') { this.capture.cancel(input.recordingId); return { ok: true, result: {} }; }
      if (action === 'speech.record.finish') return { ok: true, result: await this.capture.finish(input) };
      if (this.isBusy() && action !== 'speech.save') throw Error('Notion 任务正在执行，请结束后再检测或测试语音。');
      if (action === 'speech.prepare' || action === 'speech.probe') {
        await this.prepare(); return { ok: true, result: { ...this.status(), message: `已检测到 ${this.status().modelName} 中英文模型，${this.provider.status().hardwareLabel} 离线引擎就绪。` } };
      }
      if (action === 'speech.save') {
        if (typeof input.enabled !== 'boolean') throw Error('请选择是否启用离线转写。');
        const model = input.model ?? this.provider.status().model ?? 'medium';
        if (!Object.hasOwn(models, model)) throw Error('请选择有效的离线语音模型。');
        if (this.provider.leases) throw Error('请先停止录音，再更改离线转写设置。');
        if (this.preparing) throw Error('本机语音正在准备，请完成后再保存。');
        if (model !== (this.provider.status().model || 'medium')) {
          if (this.isBusy()) throw Error('Notion 任务正在执行，请结束后再更改模型。');
          const previous = { platform: this.provider.platform, runtime: this.provider.runtime };
          this.provider.close(); this.provider.platform = previous.platform.withModel(model); this.provider.runtime = null;
          try { await this.prepare(); }
          catch (error) { Object.assign(this.provider, previous); throw error; }
        }
        if (input.enabled && !this.provider.runtime) await this.prepare();
        this.enabled = input.enabled; this.save(); await this.onChange(this.enabled);
        return { ok: true, result: { ...this.status(), message: '离线语音设置已保存。' } };
      }
      if (action === 'speech.release') {
        if (this.provider.leases) throw Error('仍有录音正在转写，请先停止录音。');
        this.provider.close(); return { ok: true, result: { ...this.status(), message: '已结束本机语音进程并释放资源。' } };
      }
      const generation = this.capture.generation;
      if (!this.provider.runtime) await this.prepare();
      if (generation !== this.capture.generation) throw Error('本机录音测试已取消。');
      return { ok: true, result: await this.capture.start() };
    } catch (error) {
      const known = /^(?:离线|Notion |本机|请选择|仍有|已有|测试录音|请使用|请先|未找到|音频)/.test(error.message || '');
      return { ok: false, error: known ? error.message : '离线语音操作失败，请重新检测本机引擎。' };
    }
  }
  close() { this.installAbort?.abort(); this.capture.cancel(); this.provider.close(); }
}
module.exports = { SpeechSettings };
