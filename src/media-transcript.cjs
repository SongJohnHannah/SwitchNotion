const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { documentType } = require('./document-content.cjs');
const { parseAttachment } = require('./document-parser.cjs');
const { NativeOcr, ocrType } = require('./native-ocr.cjs');
const { CollectionBinaries } = require('./collection/binaries.cjs');
const { CollectionMedia } = require('./collection/media.cjs');
const media = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm' };
function attachmentType(filename, type) {
  const mime = typeof filename === 'string' && media[path.extname(filename).toLowerCase()];
  if (!mime) return ocrType(filename, type) || documentType(filename, type);
  if (!filename || filename.length > 255 || !filename.isWellFormed() || /[\\/\x00-\x1f\x7f]/.test(filename) || type && ![mime, 'application/octet-stream', 'audio/x-wav', 'audio/mp3', 'audio/x-m4a', 'audio/x-flac', 'audio/webm'].includes(type.toLowerCase())) throw Error('Notion 附件媒体文件名或类型无效。');
  return { format: 'media-transcript', mediaType: mime };
}
class MediaTranscript {
  constructor({ root, speech, binaries = new CollectionBinaries({ root }), backend, chooseOpen, chooseSave, isBusy = () => false, ocr = new NativeOcr({ root }) }) {
    Object.assign(this, { root, speech, binaries, chooseOpen, chooseSave, isBusy, ocr }); this.backend = backend || new CollectionMedia({ root, speech, binaries }); this.queue = Promise.resolve(); this.active = 0; this.pending = 0; this.queuedBytes = 0; this.job = null;
  }
  status() { if (!this.job) return { status: 'idle' }; const { controller, ...job } = this.job; return structuredClone(job); }
  async request(action, input = {}) {
    try {
      if (!['transcript.state', 'transcript.prepare', 'transcript.start', 'transcript.stop', 'transcript.save'].includes(action) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw Error('Notion 附件逐字稿操作参数无效。');
      if (action === 'transcript.prepare') {
        if (this.pending || this.choosing) throw Error('Notion 附件已有媒体任务，请等待完成。');
        const job = { id: randomUUID(), filename: '媒体组件', status: 'preparing', progress: '正在检测并准备媒体组件…', text: '', error: null, controller: new AbortController() }; this.job = job; this.pending++;
        const next = this.queue.then(async () => {
          try { await this.binaries.prepare({ signal: job.controller.signal, progress: value => { job.progress = value; } }); job.status = 'ready'; job.progress = '媒体组件已就绪，可以选择音频或视频。'; }
          catch { job.status = job.controller.signal.aborted ? 'stopped' : 'failed'; job.error = '媒体组件准备未完成，请检查网络后重试。'; }
          finally { this.pending--; }
        }); this.queue = next.catch(() => {});
      } else if (action === 'transcript.start') {
        if (this.job && ['queued', 'running', 'preparing'].includes(this.job.status) || this.choosing) throw Error('Notion 附件已有逐字稿任务，请先停止或等待完成。');
        if (this.isBusy() || this.speech?.leases > 0 || this.speech?.status?.().busy) throw Error('Notion 附件语音正在准备、录音或转写，请结束后再处理文件。');
        this.choosing = true; let file;
        try { file = await this.chooseOpen(); } finally { this.choosing = false; }
        if (!file) return { ok: true, result: this.status() };
        const stat = fs.lstatSync(file), filename = path.basename(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 2 * 1024 ** 3 || attachmentType(filename, '').format !== 'media-transcript') throw Error('Notion 附件请选择 2 GB 内的音视频文件。');
        if (this.pending >= 8) throw Error('Notion 附件等待转写的任务过多，请稍后重试。');
        const job = { id: randomUUID(), filename, status: 'queued', progress: '等待本机转写引擎…', text: '', error: null, controller: new AbortController() };
        this.job = job; this.pending++;
        const run = async () => {
          const parent = path.join(this.root, 'media-transcripts'), dir = path.join(parent, randomUUID()), signal = job.controller.signal;
          try {
            signal.throwIfAborted(); if (this.isBusy() || this.speech?.leases > 0 || this.speech?.status?.().busy) throw Error('Notion 附件语音正在准备、录音或转写，请结束后再处理文件。');
            job.status = 'running'; this.active++; fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const local = path.join(dir, 'input' + path.extname(filename).toLowerCase()); job.progress = '正在准备本机文件…'; await fs.promises.copyFile(file, local, fs.constants.COPYFILE_EXCL);
            signal.throwIfAborted(); const current = fs.lstatSync(file); if (!current.isFile() || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) throw Error('Notion 附件文件在准备期间发生变化，请重新选择。');
            const info = await this.backend.probe(local, signal); if (!info.audio || !info.duration || info.duration > 14400) throw Error('Notion 附件文件没有音轨或超过四小时，请分段处理。');
            const result = await this.backend.transcript({ ...info, path: local, bytes: stat.size, kind: path.extname(filename).toLowerCase() in media && media[path.extname(filename).toLowerCase()].startsWith('video/') ? 'video' : 'audio' }, { signal, progress: value => { job.progress = value; } });
            if (result.text.length > 500000) throw Error('Notion 附件逐字稿过长，请分段处理。');
            job.text = result.text; job.status = 'completed'; job.progress = result.note || '逐字稿已完成，可保存为 TXT。';
          } catch (error) { job.status = signal.aborted ? 'stopped' : 'failed'; job.error = /^Notion 附件/.test(error.message) ? error.message : /^(?:请先|本地|本机|离线)/.test(error.message) ? error.message : '本机转写未完成，请检查媒体组件与离线语音。'; }
          finally { this.active = Math.max(0, this.active - 1); this.pending--; if (path.dirname(path.resolve(dir)) === path.resolve(parent)) fs.rmSync(dir, { recursive: true, force: true }); }
        };
        const next = this.queue.then(run); this.queue = next.catch(() => {});
      } else if (action === 'transcript.stop') this.job?.controller.abort();
      else if (action === 'transcript.save') {
        if (this.job?.status !== 'completed') throw Error('Notion 附件请等待逐字稿完成。');
        const job = this.job, file = await this.chooseSave(path.basename(job.filename, path.extname(job.filename)) + '-逐字稿.txt');
        if (file) fs.writeFileSync(file, job.text, { mode: 0o600, flush: true });
      }
      return { ok: true, result: this.status() };
    } catch (error) { return { ok: false, error: /^Notion 附件/.test(error.message) ? error.message : '逐字稿操作未完成，请检查文件或语音设置。' }; }
  }
  parse(bytes, filename, mediaType, options = {}) {
    const type = attachmentType(filename, mediaType);
    if (type.format !== 'media-transcript') return this.ocr.parse(bytes, filename, type.mediaType, options);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16 * 1024 * 1024 || this.pending >= 8 || this.queuedBytes + bytes.length > 64 * 1024 * 1024) return Promise.reject(Error('Notion 附件媒体文件过大或等待转写的任务过多，请分段或稍后重试。'));
    this.pending++; this.queuedBytes += bytes.length;
    const execute = async () => {
      options.signal?.throwIfAborted();
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16 * 1024 * 1024) throw Error('Notion 附件音视频文件需在 16 MB 内，请先分段。');
      const parent = path.join(this.root, 'media-transcripts'), dir = path.join(parent, randomUUID());
      const cacheKey = createHash('sha256').update(bytes).update(JSON.stringify(['audio-transcript-v1', this.speech?.status?.().model || 'configured'])).digest('hex'), cache = path.join(parent, cacheKey + '.json');
      if (fs.existsSync(cache)) {
        try { const stat = fs.lstatSync(cache); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error(); const saved = JSON.parse(fs.readFileSync(cache, 'utf8')); if (saved.cacheKey !== cacheKey || typeof saved.text !== 'string' || saved.text.length > 200000) throw Error(); const { cacheKey: ignored, ...result } = saved; return { ...result, filename }; }
        catch { throw Error('Notion 附件逐字稿缓存损坏，请在配置中检查本机数据。'); }
      }
      if (this.isBusy() || this.speech?.leases > 0 || this.speech?.status?.().busy) throw Error('Notion 附件语音正在准备、录音或转写，请结束后再处理音视频。');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); this.active++;
      const file = path.join(dir, 'input' + path.extname(filename).toLowerCase());
      try {
        fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
        const info = await this.backend.probe(file, options.signal);
        if (!info.audio) throw Error('Notion 附件此文件没有可转写的音轨。');
        if (!Number.isFinite(info.duration) || info.duration <= 0 || info.duration > 4 * 3600) throw Error('Notion 附件无法确认时长或超过四小时，请分段。');
        const result = await this.backend.transcript({ ...info, path: file, bytes: bytes.length, kind: type.mediaType.startsWith('video/') ? 'video' : 'audio' }, options);
        if (result.text.length > 200000) throw Error('Notion 附件逐字稿超过文字上限，请分段。');
        const document = { filename, format: 'media-transcript', text: result.text, duration_seconds: info.duration, complete: true, source_bytes: bytes.length, active_content_executed: false, external_resources_fetched: false, notes: [result.note, '离线识别音轨；没有分析视频画面，未自动润色或翻译；语音识别可能有误字。'].filter(Boolean) };
        const temporary = path.join(dir, 'result.json'); fs.writeFileSync(temporary, JSON.stringify({ cacheKey, ...document }), { mode: 0o600, flush: true }); fs.renameSync(temporary, cache); return document;
      } catch (error) {
        options.signal?.throwIfAborted();
        throw Error(/^Notion 附件/.test(error.message) ? error.message : /^(?:请先|本地|本机|离线)/.test(error.message) ? 'Notion 附件' + error.message : 'Notion 附件音视频转写未完成，请检查媒体组件和离线语音配置。');
      } finally {
        this.active--;
        // dir is a freshly generated direct child, never a user-supplied path.
        if (path.dirname(path.resolve(dir)) === path.resolve(parent)) fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const next = this.queue.then(execute).finally(() => { this.pending--; this.queuedBytes -= bytes.length; }); this.queue = next.catch(() => {}); return next;
  }
}
module.exports = { MediaTranscript, attachmentType };
