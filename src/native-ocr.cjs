const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { workerEnvironment } = require('./collection/process.cjs');
const { parseAttachment } = require('./document-parser.cjs');
const { inspectImage } = require('./native-images.cjs');
const { MediaOcr } = require('./mediaocr.cjs');
const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const executeNative = (command, args, { signal, timeout, maxBytes, env }) => new Promise((resolve, reject) => {
  execFile(command, args, { signal, timeout, maxBuffer: maxBytes, env, windowsHide: true, encoding: 'utf8', shell: false }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
});
function ocrType(filename, mediaType = '') {
  const mime = typeof filename === 'string' && imageTypes[path.extname(filename).toLowerCase()];
  if (!mime) return null;
  if (filename.length > 255 || !filename.isWellFormed() || /[\\/\x00-\x1f\x7f]/.test(filename) || typeof mediaType !== 'string' || !['', mime, 'application/octet-stream', ...(mime === 'image/jpeg' ? ['image/jpg'] : [])].includes(mediaType.toLowerCase())) throw Error('Notion 附件 OCR 图片名称或类型无效。');
  return { format: 'image-ocr', mediaType: mime };
}
class NativeOcr {
  constructor({ root, platform = process.platform, execute = executeNative, mediaocr = new MediaOcr({ root, platform }) }) { Object.assign(this, { root, platform, execute, mediaocr }); this.queue = Promise.resolve(); this.pending = 0; this.bytes = 0; this.cache = new Map(); }
  status() {
    let ready = false, error = this.preparation?.error;
    try { ready = this.mediaocr.available(); } catch (failure) { error = failure.message; }
    return { ready, preparing: !!this.preparing, engine: ready ? 'mediaocr · 微信原生 OCR' : this.platform === 'darwin' ? 'Apple Vision（尚未准备 mediaocr）' : 'Windows.Media.Ocr（尚未准备 mediaocr）', progress: this.preparation?.progress || '', error: error || null };
  }
  async request(action, input = {}) {
    try {
      if (!['ocr.state', 'ocr.prepare', 'ocr.stop'].includes(action) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw Error('OCR 操作参数无效。');
      if (action === 'ocr.stop') this.preparation?.controller.abort();
      if (action === 'ocr.prepare') {
        if (this.preparing || this.pending) throw Error('OCR 正在工作，请停止或完成后再准备。');
        const job = { controller: new AbortController(), progress: '正在检查 mediaocr…', error: null }; this.preparation = job; this.preparing = true;
        const { prepareMediaOcr } = require('./mediaocr-prepare.cjs');
        this.preparationTask = prepareMediaOcr({ root: this.root, platform: this.platform, signal: job.controller.signal, progress: value => { job.progress = value; } }).catch(error => { job.error = job.controller.signal.aborted ? 'mediaocr 准备已停止，下载缓存保留。' : error.message; }).finally(() => { this.preparing = false; });
      }
      return { ok: true, result: this.status() };
    } catch (error) { return { ok: false, error: error.message }; }
  }
  async recognize(bytes, filename, mediaType, { signal, pages, forceOcr = false } = {}) {
    signal?.throwIfAborted();
    if (this.preparing) throw Error('Notion 附件 OCR mediaocr 正在准备，请完成后重新发送。');
    if (!['win32', 'darwin'].includes(this.platform)) throw Error('Notion 附件 OCR 当前支持 Windows 和 Mac。');
    if (pages !== undefined && (!Array.isArray(pages) || !pages.length || pages.length > 200 || pages.some(page => !Number.isSafeInteger(page) || page < 1 || page > 200) || new Set(pages).size !== pages.length)) throw Error('Notion 附件 OCR 页码范围无效。');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16 * 1024 ** 2 || this.pending >= 4 || this.bytes + bytes.length > 32 * 1024 ** 2) throw Error('Notion 附件 OCR 文件过大或正在处理，请分批上传。');
    if (mediaType !== 'application/pdf') inspectImage(bytes, 8192);
    const key = createHash('sha256').update(bytes).update(JSON.stringify([this.platform, this.mediaocr.available() ? 'mediaocr' : 'native', mediaType, pages || null, forceOcr])).digest('hex');
    if (this.cache.has(key)) return { ...structuredClone(this.cache.get(key)), filename };
    this.pending++; this.bytes += bytes.length;
    const task = this.queue.then(async () => {
      signal?.throwIfAborted();
      const parent = path.resolve(this.root, 'ocr'), directory = path.join(parent, randomUUID()); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        const file = path.join(directory, mediaType === 'application/pdf' ? 'source.pdf' : 'source' + ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[mediaType] || '.png'));
        fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
        const input = path.join(directory, 'request.json');
        const command = this.platform === 'darwin' ? '/usr/bin/osascript' : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const args = this.platform === 'darwin' ? ['-l', 'JavaScript', path.join(__dirname, 'ocr', 'macos.js'), input] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'ocr', 'windows.ps1'), '-RequestFile', input];
        // Each native process handles at most eight PDF pages, releasing its
        // rendering/Vision objects before the next batch rather than retaining
        // an entire long scan in an autorelease pool.
        const batches = pages ? Array.from({ length: Math.ceil(pages.length / 8) }, (_, at) => pages.slice(at * 8, at * 8 + 8)) : [null], preferred = await this.mediaocr.recognize(file, { pages, signal, forceOcr }), value = preferred || { pages: [], languages: [] };
        for (const batch of preferred ? [] : batches) {
          signal?.throwIfAborted(); fs.writeFileSync(input, JSON.stringify({ file, pdf: mediaType === 'application/pdf', pages: batch, maxPages: 200 }), { mode: 0o600 });
          let output, result;
          try { output = await this.execute(command, args, { signal, timeout: 60000 + (batch?.length || 1) * 15000, maxBytes: 2 * 1024 ** 2, env: workerEnvironment(path.dirname(command)) }); }
          catch { signal?.throwIfAborted(); throw Error('Notion 附件 OCR 系统识别未完成，请确认本机文字识别组件及语言包可用。'); }
          signal?.throwIfAborted();
          try { result = JSON.parse(output.stdout.trim().replace(/^\uFEFF/, '')); } catch { throw Error('Notion 附件 OCR 返回格式无效。'); }
          if (!result || !Array.isArray(result.pages) || !result.pages.length || batch && (result.pages.length !== batch.length || batch.some(number => !result.pages.some(page => page?.page === number)))) throw Error('Notion 附件 OCR 缺少所选页，未发送不完整结果。');
          value.pages.push(...result.pages); if (Array.isArray(result.languages)) value.languages.push(...result.languages);
          if (JSON.stringify(value).length > 240000) throw Error('Notion 附件 OCR 正文过长，请拆分后上传。');
        }
        if (!value || !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 200 || value.pages.some(page => !Number.isSafeInteger(page.page) || page.page < 1 || page.page > 200 || typeof page.text !== 'string' || page.text.length > 200000) || new Set(value.pages.map(page => page.page)).size !== value.pages.length || JSON.stringify(value).length > 240000) throw Error('Notion 附件 OCR 返回的页码、正文或范围无效。');
        if (pages && (value.pages.length !== pages.length || pages.some(number => !value.pages.some(page => page.page === number)))) throw Error('Notion 附件 OCR 缺少所选页，未发送不完整结果。');
        // Windows inserts word separators even between adjacent Han characters.
        // Remove only that formatting artifact; do not guess or correct words.
        if (this.platform === 'win32' && !preferred) for (const page of value.pages) page.text = page.text.replace(/([\u3400-\u9fff]) +(?=[\u3400-\u9fff])/g, '$1');
        const document = { filename, format: mediaType === 'application/pdf' ? 'pdf' : 'image-ocr', pages: value.pages, complete: value.pages.every(page => !!page.text.trim()), ocr: true, ocr_engine: value.engine || (this.platform === 'darwin' ? 'Apple Vision' : 'Windows.Media.Ocr'), languages: Array.isArray(value.languages) ? [...new Set(value.languages.filter(x => typeof x === 'string'))].slice(0, 8) : [], source_bytes: bytes.length, media_type: mediaType, active_content_executed: false, external_resources_fetched: false, warnings: ['本机 OCR 结果可能有误字；未分析图片含义、执行附件指令或主动翻译。'] };
        if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value); this.cache.set(key, structuredClone(document)); return document;
      } finally { if (path.dirname(directory) !== parent) throw Error('Notion 附件 OCR 临时路径无效。'); fs.rmSync(directory, { recursive: true, force: true }); }
    }).finally(() => { this.pending--; this.bytes -= bytes.length; });
    this.queue = task.catch(() => {}); return task;
  }
  async parse(bytes, filename, mediaType, options = {}) {
    const image = ocrType(filename, mediaType);
    if (image) return this.recognize(bytes, filename, image.mediaType, options);
    if (mediaType !== 'application/pdf') return parseAttachment(bytes, filename, mediaType, options);
    const document = await parseAttachment(bytes, filename, mediaType, { ...options, allowEmptyPdf: true });
    const pages = document.pages.filter(page => options.forceOcr || !page.text.trim()).map(page => page.page);
    if (!pages.length) return document;
    const recognized = await this.recognize(bytes, filename, mediaType, { ...options, pages });
    const result = { ...document, pages: document.pages.map(page => recognized.pages.find(item => item.page === page.page) || page), text_layer_only: false, ocr: true, ocr_engine: recognized.ocr_engine, warnings: recognized.warnings };
    result.complete = result.pages.every(page => !!page.text.trim());
    if (JSON.stringify(result).length > 240000) throw Error('Notion 附件 OCR 合并正文过长，请分段上传。');
    return result;
  }
}
module.exports = { NativeOcr, ocrType };
