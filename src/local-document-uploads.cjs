// Documents explicitly uploaded through the native chat input. No server-file
// resolver and no caller-controlled filesystem path is exposed by this store.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { documentType, MAX_BYTES } = require('./document-content.cjs');
const prefix = '/notion-switch-local-document-upload/', previewPrefix = '/notion-switch-local-document/';
const fail = message => { throw Error('Notion 附件' + message); };
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
class LocalDocumentUploads {
  constructor({ root, record, fileType = documentType }) { this.directory = path.join(root, 'document-attachments'); this.record = record; this.fileType = fileType; this.pending = new Map(); this.tokens = new Map(); this.previews = new Map(); }
  // Sidebar images keep their existing preview/Flash upload route. The inline
  // uploader may still explicitly create an OCR image in this document store.
  handles(filename) { try { return this.fileType(filename, '').format !== 'image-ocr'; } catch { return false; } }
  handlesTarget(target) { return target?.type === 'user' || target?.type === 'thread' && !!this.record(target.threadId); }
  thread(threadId, userId, spaceId) {
    const result = this.record(uuid(threadId), { userId: uuid(userId), spaceId: uuid(spaceId) });
    if (!uuid(userId) || !uuid(spaceId) || !result || uuid(result.created_by_id) !== uuid(userId) || uuid(result.space_id) !== uuid(spaceId)) fail('不属于当前账号、工作区或对话。');
    return result;
  }
  create(input, userId, origin) {
    for (const [id, item] of this.pending) if (Date.now() - item.created > 1800000) { this.pending.delete(id); this.tokens.delete(item.token); }
    const type = this.fileType(input?.filename, input?.mediaType), owner = uuid(userId), spaceId = uuid(input.spaceId);
    if (!owner || !spaceId || !this.handlesTarget(input.target) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_BYTES) fail('上传信息无效或超过 16 MB。');
    if (input.target.type === 'thread') this.thread(input.target.threadId, owner, spaceId);
    if (this.pending.size >= 8 || [...this.pending.values()].reduce((sum, item) => sum + item.sizeBytes, input.sizeBytes) > 32 * 1024 * 1024) fail('正在上传的文件过多，请完成当前上传后重试。');
    const parsed = new URL(origin); if (parsed.protocol !== 'https:' || parsed.origin !== origin || !['notion.so', 'notion.com'].some(host => parsed.hostname === host || parsed.hostname.endsWith('.' + host))) fail('上传来源无效。');
    const id = randomUUID(), token = randomBytes(32).toString('hex'), item = { id, token, userId: owner, spaceId,
      threadId: input.target.type === 'thread' ? uuid(input.target.threadId) : null, targetType: input.target.type,
      filename: input.filename.normalize('NFC'), mediaType: type.mediaType, sizeBytes: input.sizeBytes, origin, created: Date.now() };
    this.pending.set(id, item); this.tokens.set(token, item);
    return { file: { id }, upload: { type: 'single_part', url: origin + prefix + token, method: 'PUT', headers: { 'content-type': type.mediaType } } };
  }
  hasPending(id) { return this.pending.has(uuid(id)); }
  hasFile(id) { id = uuid(id); return !!id && (fs.existsSync(path.join(this.directory, id + '.json')) || fs.existsSync(path.join(this.directory, id + '.bin'))); }
  async put(token, request) {
    const item = this.tokens.get(token), url = new URL(request.url), headerUser = request.headers.get('x-notion-active-user-header');
    if (!item || item.receiving || item.data || request.method !== 'PUT' || item.origin !== url.origin || Date.now() - item.created > 1800000 ||
        headerUser && uuid(headerUser) !== item.userId || request.headers.get('origin') && request.headers.get('origin') !== item.origin || request.headers.get('sec-fetch-site') === 'cross-site') return new Response(null, { status: 404 });
    const reader = request.body?.getReader(); if (!reader) return new Response(null, { status: 400 });
    const timeout = new AbortController(), signal = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(() => timeout.abort(), 30000), abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true }); item.receiving = true;
    const chunks = []; let size = 0;
    try {
      for (;;) { signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted(); if (done) break;
        size += value.byteLength; if (size > item.sizeBytes || size > MAX_BYTES) { await reader.cancel(); return new Response(null, { status: 413 }); } chunks.push(Buffer.from(value)); }
      if (size !== item.sizeBytes) return new Response(null, { status: 400 });
      item.data = Buffer.concat(chunks, size); this.tokens.delete(token); return new Response(null, { status: 200 });
    } catch { return new Response(null, { status: 408 }); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); item.receiving = false; reader.releaseLock(); }
  }
  complete(input, userId) {
    const id = uuid(input?.fileId), item = this.pending.get(id);
    if (!item) {
      const saved = this.metadata(id);
      if (!saved || saved.userId !== uuid(userId) || saved.spaceId !== uuid(input?.spaceId) ||
          (saved.threadId ? input.target?.type !== 'thread' || uuid(input.target.threadId) !== saved.threadId : input.target?.type !== 'user')) fail('上传回执不属于当前账号或目标。');
      if (saved.threadId) this.thread(saved.threadId, saved.userId, saved.spaceId);
      this.bytes(saved);
      return this.receipt(saved);
    }
    if (!item || !item.data || item.userId !== uuid(userId) || item.spaceId !== uuid(input.spaceId) || Date.now() - item.created > 1800000 ||
        item.targetType !== input.target?.type || item.threadId !== (input.target.type === 'thread' ? uuid(input.target.threadId) : null)) fail('尚未完成上传，或账号与目标不匹配。');
    if (item.threadId) this.thread(item.threadId, item.userId, item.spaceId);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); if (fs.lstatSync(this.directory).isSymbolicLink()) fail('保存目录无效。');
    const meta = { version: 1, id, userId: item.userId, spaceId: item.spaceId, threadId: item.threadId, filename: item.filename,
      mediaType: item.mediaType, sizeBytes: item.sizeBytes, sha256: checksum(item.data) }, base = path.join(this.directory, id);
    fs.writeFileSync(base + '.bin', item.data, { flag: 'wx', mode: 0o600, flush: true });
    try { fs.writeFileSync(base + '.json', JSON.stringify(meta), { flag: 'wx', mode: 0o600, flush: true }); }
    catch (error) { fs.unlinkSync(base + '.bin'); throw error; }
    this.pending.delete(id);
    return this.receipt(meta);
  }
  receipt(meta) { return { id: meta.id, filename: meta.filename, media_type: meta.mediaType, size_bytes: meta.sizeBytes, sha256: meta.sha256 }; }
  metadata(fileId) {
    fileId = uuid(fileId); if (!fileId) return null;
    const base = path.join(this.directory, fileId), metadata = base + '.json';
    if (!fs.existsSync(metadata)) { if (fs.existsSync(base + '.bin')) fail('元数据丢失，请重新上传。'); return null; }
    const directory = fs.lstatSync(this.directory), metaStat = fs.lstatSync(metadata);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !metaStat.isFile() || metaStat.isSymbolicLink() || metaStat.size > 8000) fail('元数据已损坏。');
    let meta; try { meta = JSON.parse(fs.readFileSync(metadata, 'utf8')); } catch { fail('元数据已损坏。'); }
    if (meta.version !== 1 || meta.id !== fileId || !uuid(meta.userId) || !uuid(meta.spaceId) || meta.threadId !== null && !uuid(meta.threadId)) fail('元数据已损坏。');
    this.fileType(meta.filename, meta.mediaType);
    if (!Number.isSafeInteger(meta.sizeBytes) || meta.sizeBytes < 1 || meta.sizeBytes > MAX_BYTES || !/^[a-f0-9]{64}$/.test(meta.sha256 || '')) fail('元数据已损坏。');
    return meta;
  }
  bytes(meta) {
    let bytes;
    try {
      const file = path.join(this.directory, meta.id + '.bin'), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== meta.sizeBytes) fail('文件已损坏。');
      bytes = fs.readFileSync(file);
    } catch { fail('文件已损坏或丢失，请重新上传。'); }
    if (checksum(bytes) !== meta.sha256) fail('文件校验失败。'); return bytes;
  }
  read(scope) {
    const fileId = uuid(scope.fileId); if (!fileId) return null;
    const meta = this.metadata(fileId); if (!meta) return null;
    this.thread(scope.threadId, scope.userId, scope.spaceId);
    if (meta.userId !== uuid(scope.userId) || meta.spaceId !== uuid(scope.spaceId) || meta.threadId && meta.threadId !== uuid(scope.threadId)) fail('不属于当前账号、工作区或对话。');
    return { ...meta, bytes: this.bytes(meta) };
  }
  resolve(input, userId, origin) {
    const scope = { fileId: uuid(input.fileId), threadId: uuid(input.threadId), spaceId: uuid(input.spaceId), userId: uuid(userId) }, file = this.read(scope);
    if (!file) fail('文件不存在。');
    for (const [token, item] of this.previews) if (item.expires < Date.now()) this.previews.delete(token);
    if (this.previews.size >= 256) this.previews.delete(this.previews.keys().next().value);
    const token = randomBytes(32).toString('hex'); this.previews.set(token, { scope, origin, expires: Date.now() + 1800000 });
    return { url: origin + previewPrefix + token, ...(input.includeFileMetadata ? { file: { id: file.id, filename: file.filename, media_type: file.mediaType, size_bytes: file.sizeBytes, sha256: file.sha256 } } : {}) };
  }
  preview(request) {
    const url = new URL(request.url); if (!url.pathname.startsWith(previewPrefix)) return null;
    const item = this.previews.get(url.pathname.slice(previewPrefix.length));
    if (!item || item.origin !== url.origin || item.expires < Date.now() || !['GET', 'HEAD'].includes(request.method) || request.headers.get('sec-fetch-site') === 'cross-site' ||
        request.headers.get('origin') && request.headers.get('origin') !== item.origin || request.headers.get('x-notion-active-user-header') && uuid(request.headers.get('x-notion-active-user-header')) !== item.scope.userId) return new Response(null, { status: 404 });
    try {
      const file = this.read(item.scope); return new Response(request.method === 'HEAD' ? null : file.bytes, { headers: {
        'content-type': file.mediaType, 'content-length': String(file.bytes.length), 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16)),
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' } });
    } catch { return new Response(null, { status: 404 }); }
  }
}
module.exports = { LocalDocumentUploads, prefix, previewPrefix };
