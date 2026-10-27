const fs = require('node:fs');
const path = require('node:path');
class RecordingCapture {
  constructor({ directory, complete, failed }) {
    this.directory = directory; this.complete = complete; this.failed = failed;
    this.queue = Promise.resolve(); this.bytes = 0; this.queuedBytes = 0; this.handles = new Map(); this.sealed = false; this.error = null;
  }
  write({ source, pcm }) {
    if (this.sealed || this.error) return;
    if (!['microphone', 'system_audio'].includes(source) || !Buffer.isBuffer(pcm) || pcm.length % 4) return this.fail();
    if (this.queuedBytes + pcm.length > 32 * 1024 * 1024) return this.fail();
    this.bytes += pcm.length; this.queuedBytes += pcm.length;
    this.queue = this.queue.then(async () => {
      if (!this.handles.has(source)) this.handles.set(source, await fs.promises.open(path.join(this.directory, source + '.pcm'), 'wx', 0o600));
      const handle = this.handles.get(source); let at = 0;
      while (at < pcm.length) { const result = await handle.write(pcm, at, pcm.length - at); if (!result.bytesWritten) throw Error('Incomplete audio write'); at += result.bytesWritten; }
    }).catch(() => this.fail()).finally(() => { this.queuedBytes -= pcm.length; });
  }
  fail() { this.error ||= Error('会议录音临时保存失败，转写继续；未上传不完整音频。'); }
  async closeFiles() {
    await this.queue;
    const results = await Promise.allSettled([...this.handles.values()].map(async handle => { try { await handle.sync(); } finally { await handle.close(); } }));
    this.handles.clear();
    if (results.some(result => result.status === 'rejected')) throw Error('会议录音临时保存失败，音频留在本机。');
  }
  finish() {
    if (this.sealed) return this.finishing;
    this.sealed = true;
    this.finishing = this.closeFiles().then(() => {
      if (this.error || !this.bytes) throw this.error || Error('会议没有可保存的音频。');
      return this.complete();
    }).catch(error => this.failed(error));
    return this.finishing;
  }
  abort() {
    if (this.sealed) return;
    this.sealed = true; this.fail();
    this.finishing = this.closeFiles().catch(() => {}).then(() => this.failed(Error('会议录音连接中断，未自动上传；已接收部分留在本机。')));
  }
}
module.exports = { RecordingCapture };
