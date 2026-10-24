const { randomUUID } = require('node:crypto');
class RecordingTest {
  constructor({ provider, isBusy = () => false }) { this.provider = provider; this.isBusy = isBusy; this.session = null; this.generation = 0; }
  get active() { return !!this.session; }
  async start() {
    if (this.session || this.isBusy() || this.provider.leases || this.provider.status().busy) throw Error('已有录音或任务正在执行，请结束后再测试。');
    if (!this.provider.runtime) throw Error('请先检测并准备离线语音引擎。');
    const session = { id: randomUUID(), abort: new AbortController(), started: Date.now() };
    this.session = session; this.provider.retain();
    session.warmup = this.provider.probe({ signal: session.abort.signal }); session.warmup.catch(() => {});
    session.timer = setTimeout(() => this.cancel(session.id), 120000); session.timer.unref?.();
    return { recordingId: session.id, maxSeconds: 60 };
  }
  async finish({ recordingId, audio, mimeType }) {
    const session = this.session;
    if (!session || session.id !== recordingId || session.finishing) throw Error('本机录音测试已结束，请重新开始。');
    if (!(audio instanceof Uint8Array) && !(audio instanceof ArrayBuffer)) throw Error('音频数据格式无效。');
    const data = Buffer.from(audio instanceof ArrayBuffer ? new Uint8Array(audio) : audio);
    if (!data.length || data.length > 16 * 1024 * 1024 || !/^audio\/webm(?:;codecs=opus)?$/.test(mimeType || '')) throw Error('音频数据格式无效或过长。');
    session.finishing = true; const start = Date.now();
    try {
      await session.warmup;
      const text = await this.provider.transcribeRecording({ audio: data, signal: session.abort.signal });
      return { text, elapsedMs: Date.now() - start, message: '本机录音转写完成，录音和文字未发送给云端。' };
    } finally { this.release(session); }
  }
  release(session) { if (this.session !== session) return; clearTimeout(session.timer); this.session = null; this.provider.release(); }
  cancel(id) { const session = this.session; if (id && (!session || id !== session.id)) return; this.generation++; if (!session) return; session.abort.abort(); this.release(session); }
}
module.exports = { RecordingTest };
