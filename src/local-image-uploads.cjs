// Uploads for local agent threads never leave the machine until the user sends
// the image to their configured model. Notion has no server-side thread for them.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const maxSize = 16 * 1024 * 1024;
const prefix = '/notion-switch-local-upload/';
const previewPrefix = '/notion-switch-local-image/';

class LocalImageUploads {
  constructor({ root, owns, record }) {
    this.directory = path.join(root, 'image-attachments'); this.owns = owns; this.record = record;
    this.pending = new Map(); this.tokens = new Map();
    this.previews = new Map();
  }
  handlesTarget(target) {
    return target?.type === 'user' || target?.type === 'thread' && !!this.owns({ threadId: target.threadId });
  }
  create(input, userId, origin) {
    for (const [id, item] of this.pending) if (Date.now() - item.created > 30 * 60 * 1000) { this.pending.delete(id); this.tokens.delete(item.token); }
    if (this.pending.size >= 8) throw Error('正在处理的图片过多，请稍后重试。');
    if (!uuid(userId) || !uuid(input.spaceId) || !this.handlesTarget(input.target) ||
        (input.target.type === 'thread' && (!uuid(input.target.threadId) || this.record(input.target.threadId)?.space_id !== input.spaceId)) ||
        typeof input.filename !== 'string' || input.filename.length < 1 || input.filename.length > 255 || /[\0\r\n]/.test(input.filename) ||
        !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(input.mediaType) ||
        !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > maxSize) throw Error('图片附件信息无效或超过 16 MB。');
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    const item = { id, userId, spaceId: input.spaceId, target: input.target, filename: input.filename,
      mediaType: input.mediaType, sizeBytes: input.sizeBytes, token, created: Date.now() };
    this.pending.set(id, item); this.tokens.set(token, item);
    return { file: { id }, upload: { type: 'single_part', url: origin + prefix + token, method: 'PUT', headers: { 'content-type': input.mediaType } } };
  }
  async put(token, request) {
    const item = this.tokens.get(token);
    if (!item || request.method !== 'PUT' || item.data || Date.now() - item.created > 30 * 60 * 1000) return new Response(null, { status: 404 });
    const reader = request.body?.getReader(), chunks = []; let size = 0;
    if (!reader) return new Response(null, { status: 400 });
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
        if (size > item.sizeBytes || size > maxSize) { await reader.cancel(); return new Response(null, { status: 413 }); }
        chunks.push(Buffer.from(value)); }
    } finally { reader.releaseLock(); }
    if (size !== item.sizeBytes) return new Response(null, { status: 400 });
    item.data = Buffer.concat(chunks, size); this.tokens.delete(token);
    return new Response(null, { status: 200 });
  }
  hasPending(id) { return this.pending.has(id); }
  hasFile(id) { return !!uuid(id) && fs.existsSync(path.join(this.directory, id + '.json')); }
  complete(input, userId) {
    const item = this.pending.get(input.fileId);
    if (!item || !item.data || Date.now() - item.created > 30 * 60 * 1000 || item.userId !== userId || item.spaceId !== input.spaceId ||
        item.target.type !== input.target?.type || item.target.threadId !== input.target?.threadId) throw Error('图片附件尚未上传完成，请重新添加。');
    const hash = createHash('sha256').update(item.data).digest('hex');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw Error('图片附件目录无效。');
    const base = path.join(this.directory, item.id);
    fs.writeFileSync(base + '.bin', item.data, { mode: 0o600, flag: 'wx' });
    try { fs.writeFileSync(base + '.json', JSON.stringify({ id: item.id, userId, spaceId: item.spaceId,
      threadId: item.target.threadId || null, filename: item.filename, mediaType: item.mediaType, sizeBytes: item.sizeBytes, sha256: hash }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { fs.unlinkSync(base + '.bin'); throw error; }
    this.pending.delete(item.id);
    return { id: item.id, filename: item.filename, media_type: item.mediaType, size_bytes: item.sizeBytes, sha256: hash };
  }
  read({ fileId, spaceId, threadId, userId }) {
    if (!uuid(fileId)) return null;
    const base = path.join(this.directory, fileId); let meta;
    try { meta = JSON.parse(fs.readFileSync(base + '.json', 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!this.owns({ threadId }) || this.record(threadId)?.space_id !== spaceId || meta.spaceId !== spaceId || meta.userId !== userId || meta.threadId && meta.threadId !== threadId) throw Error('图片附件不属于当前对话。');
    const stat = fs.lstatSync(base + '.bin');
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== meta.sizeBytes || stat.size > maxSize) throw Error('图片附件已损坏。');
    const data = fs.readFileSync(base + '.bin');
    if (createHash('sha256').update(data).digest('hex') !== meta.sha256) throw Error('图片附件校验失败。');
    return data;
  }
  resolve(input, userId, origin) {
    const scope = { fileId: input.fileId, spaceId: input.spaceId, threadId: input.threadId, userId };
    if (!this.read(scope)) throw Error('图片附件不存在。');
    const meta = JSON.parse(fs.readFileSync(path.join(this.directory, input.fileId + '.json'), 'utf8'));
    for (const [token, item] of this.previews) if (item.expires < Date.now()) this.previews.delete(token);
    if (this.previews.size >= 256) this.previews.delete(this.previews.keys().next().value);
    const token = randomBytes(32).toString('hex');
    this.previews.set(token, { scope, origin, expires: Date.now() + 30 * 60 * 1000 });
    return { url: origin + previewPrefix + token, ...(input.includeFileMetadata ? { file: {
      id: meta.id, filename: meta.filename, media_type: meta.mediaType, size_bytes: meta.sizeBytes, sha256: meta.sha256
    } } : {}) };
  }
  preview(request) {
    const url = new URL(request.url); let pathname = url.pathname;
    // Native thumbnails can wrap the content URL in Notion's /image proxy.
    // Serve the local bytes before that proxy reaches the network.
    if (pathname.startsWith('/image/')) {
      try { const nested = new URL(decodeURIComponent(pathname.slice(7))); if (nested.origin !== url.origin) return null; pathname = nested.pathname; }
      catch { return null; }
    }
    if (!pathname.startsWith(previewPrefix)) return null;
    const item = this.previews.get(pathname.slice(previewPrefix.length));
    if (!item || item.expires < Date.now() || item.origin !== url.origin || !['GET', 'HEAD'].includes(request.method) ||
        request.headers.get('sec-fetch-site') === 'cross-site' || request.headers.get('origin') && request.headers.get('origin') !== url.origin) return new Response(null, { status: 404 });
    try {
      const data = this.read(item.scope);
      const meta = JSON.parse(fs.readFileSync(path.join(this.directory, item.scope.fileId + '.json'), 'utf8'));
      return new Response(request.method === 'HEAD' ? null : data, { headers: { 'content-type': meta.mediaType,
        'content-length': String(data.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' } });
    } catch { return new Response(null, { status: 404 }); }
  }
}
module.exports = { LocalImageUploads, prefix, previewPrefix };
