// Legacy native writer uploads: multipart POST -> local document -> transcript
// fileUrl. Only locally generated, account/thread-bound references are readable.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { documentType, MAX_BYTES } = require('./document-content.cjs');
const { parseAttachment } = require('./document-parser.cjs');
const uploadPrefix = '/notion-switch-inline-document-upload/', referencePrefix = '/notion-switch-inline-document/';
const fail = message => { throw Error('Notion 浮动附件' + message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
class LocalInlineDocuments {
  constructor({ root, store, reserve, fileType = documentType, parseContent = parseAttachment }) {
    this.fileType = fileType; this.parseContent = parseContent;
    this.store = store; this.reserve = reserve; this.file = path.join(root, 'inline-document-refs.local.json'); this.pending = new Map(); this.references = new Map();
    if (fs.existsSync(this.file)) {
      const stat = fs.lstatSync(this.file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail('本地引用记录无效。');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.references) || saved.references.length > 2048) fail('本地引用记录无效。');
      for (const item of saved.references) {
        if (!uuid(item.id) || !uuid(item.userId) || !uuid(item.spaceId) || !uuid(item.threadId) || !/^[a-f0-9]{64}$/.test(item.token || '') || this.references.has(item.id)) fail('本地引用记录无效。');
        this.origin(item.origin); this.references.set(item.id, item);
      }
    }
  }
  origin(value) {
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== 'https:' || !['notion.com', 'notion.so'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) fail('来源无效。');
    return value;
  }
  handles(value) { try { return new URL(value).pathname.startsWith(referencePrefix); } catch { return false; } }
  reference(value, origin) {
    let url; try { url = new URL(value); } catch { fail('地址无效，请重新上传。'); }
    const match = new RegExp('^' + referencePrefix + '([a-f0-9-]{36})/([a-f0-9]{64})$').exec(url.pathname);
    const item = match && this.references.get(uuid(match[1]));
    if (!item || item.origin !== origin || url.origin !== origin || url.username || url.password || url.hash || url.search || !same(item.token, match[2])) fail('不是可核对的本次本地上传，请重新上传文档。');
    return item;
  }
  create(input, userId, origin) {
    this.origin(origin); const type = this.fileType(input?.name, input?.contentType), pointer = input?.assistantChatTranscriptSessionPointer;
    const owner = uuid(userId), threadId = uuid(pointer?.id), spaceId = uuid(pointer?.spaceId);
    if (!owner || !threadId || !spaceId || pointer.table !== 'thread' || input.createThread !== true ||
        input.threadType !== undefined && input.threadType !== 'workflow' || input.workflowId !== undefined ||
        !Number.isSafeInteger(input.contentLength) || input.contentLength < 1 || input.contentLength > MAX_BYTES || this.references.size >= 2048) fail('上传范围无效、超过 16 MiB 或本地引用数量已满。');
    for (const [token, item] of this.pending) if (Date.now() - item.created > 1800000) this.pending.delete(token);
    this.reserve({ threadId, spaceId, userId: owner });
    const target = { type: 'thread', threadId }, created = this.store.create({ spaceId, target, filename: input.name, mediaType: type.mediaType, sizeBytes: input.contentLength }, owner, origin);
    const token = randomBytes(32).toString('hex'), referenceToken = randomBytes(32).toString('hex');
    this.pending.set(token, { id: created.file.id, userId: owner, spaceId, threadId, token: referenceToken, origin, created: Date.now(),
      coreUrl: created.upload.url, mediaType: type.mediaType, size: input.contentLength });
    return { type: 'POST', url: origin + referencePrefix + created.file.id + '/' + referenceToken,
      signedUploadPostUrl: origin + uploadPrefix + token, postHeaders: [], fields: { 'notion-switch-document': '1' }, signedGetUrl: '' };
  }
  async post(request) {
    const url = new URL(request.url), token = url.pathname.slice(uploadPrefix.length), item = this.pending.get(token), owner = request.headers.get('x-notion-active-user-header');
    if (!item || item.receiving || item.origin !== url.origin || request.method !== 'POST' || Date.now() - item.created > 1800000 ||
        owner && uuid(owner) !== item.userId || request.headers.get('origin') && request.headers.get('origin') !== item.origin || request.headers.get('sec-fetch-site') === 'cross-site') return new Response(null, { status: 404 });
    if (!/^multipart\/form-data;\s*boundary=/i.test(request.headers.get('content-type') || '')) return new Response(null, { status: 400 });
    const maximum = item.size + 65536, length = Number(request.headers.get('content-length'));
    if (length > maximum) return new Response(null, { status: 413 });
    const reader = request.body?.getReader(); if (!reader) return new Response(null, { status: 400 });
    const deadline = new AbortController(), signal = AbortSignal.any([request.signal, deadline.signal]);
    const abort = () => { void reader.cancel().catch(() => {}); }, timer = setTimeout(() => deadline.abort(), 30000);
    signal.addEventListener('abort', abort, { once: true }); item.receiving = true;
    try {
      const chunks = []; let size = 0;
      for (;;) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break; size += part.value.length;
        if (size > maximum) { await reader.cancel(); return new Response(null, { status: 413 }); } chunks.push(Buffer.from(part.value)); }
      const form = await new Request(request.url, { method: 'POST', headers: { 'content-type': request.headers.get('content-type') }, body: Buffer.concat(chunks, size) }).formData();
      const fields = [...form.entries()], file = form.get('file');
      if (fields.length !== 2 || form.getAll('file').length !== 1 || form.get('notion-switch-document') !== '1' || typeof file?.arrayBuffer !== 'function' || file.size !== item.size) return new Response(null, { status: 400 });
      const bytes = Buffer.from(await file.arrayBuffer()); signal.throwIfAborted();
      const uploaded = await this.store.put(new URL(item.coreUrl).pathname.split('/').at(-1), new Request(item.coreUrl, { method: 'PUT', body: bytes, signal }));
      if (!uploaded.ok) return uploaded;
      this.store.complete({ fileId: item.id, spaceId: item.spaceId, target: { type: 'thread', threadId: item.threadId } }, item.userId);
      const saved = { id: item.id, token: item.token, origin: item.origin, userId: item.userId, spaceId: item.spaceId, threadId: item.threadId };
      this.references.set(item.id, saved);
      try { this.save(); } catch (error) { this.references.delete(item.id); throw error; }
      this.pending.delete(token); return new Response(null, { status: 204 });
    } catch { return new Response(null, { status: signal.aborted ? 408 : 400 }); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); item.receiving = false; reader.releaseLock(); }
  }
  save() {
    const data = JSON.stringify({ version: 1, references: [...this.references.values()] }); if (Buffer.byteLength(data) > 1024 * 1024) fail('本地引用记录已满。');
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600, flush: true });
    try { fs.renameSync(temporary, this.file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  async process(input, userId, origin, signal) {
    const item = this.reference(input.url, origin), pointer = input.aiSessionPointer;
    if (input.source !== 'user_upload' || uuid(input.spaceId) !== item.spaceId || pointer?.table !== 'thread' || uuid(pointer.id) !== item.threadId || uuid(pointer.spaceId) !== item.spaceId ||
        input.permissionRecord?.table !== 'thread' || uuid(input.permissionRecord.id) !== item.threadId || uuid(input.permissionRecord.spaceId) !== item.spaceId) fail('处理请求不属于此上传对话。');
    const file = this.store.read({ fileId: item.id, spaceId: item.spaceId, threadId: item.threadId, userId });
    const result = await this.parseContent(file.bytes, file.filename, file.mediaType, { signal });
    const data = { attachmentRisk: 'skipped', contentType: file.mediaType, fileSizeBytes: file.bytes.length,
      ...(result.format === 'pdf' ? { numPages: result.pages.length } : result.format === 'csv' ? { numRows: result.rows.length, numFields: Math.max(0, ...result.rows.map(row => row.values.length)) } : {}) };
    return { notionSwitchDocument: { version: 1, result: { ...data, stepMetadata: { ...data } } } };
  }
  async prepare({ step, spaceId, threadId, userId, origin, signal }) {
    const item = this.reference(step.fileUrl, origin);
    if (uuid(spaceId) !== item.spaceId || uuid(threadId) !== item.threadId || uuid(userId) !== item.userId || step.metadata?.attachmentSource !== 'user_upload') fail('引用不属于当前账号、工作区或对话。');
    if (step.permissionRecord !== undefined && (step.permissionRecord.table !== 'thread' || uuid(step.permissionRecord.id) !== item.threadId || uuid(step.permissionRecord.spaceId) !== item.spaceId)) fail('引用权限目标不匹配。');
    const file = this.store.read({ fileId: item.id, spaceId, threadId, userId });
    // The legacy uploader randomizes its transport filename; the transcript
    // carries the actual display name. It remains data, never a filesystem path.
    const type = this.fileType(step.fileName, step.contentType);
    if (type.mediaType !== file.mediaType) fail('文件类型与上传回执不匹配。');
    const document = await this.parseContent(file.bytes, step.fileName, file.mediaType, { signal });
    return { document: { ...document, file_id: file.id, sha256: file.sha256, treat_as_data: true }, bytes: file.bytes.length };
  }
  download(request) {
    try {
      const url = new URL(request.url), item = this.reference(request.url, url.origin), user = request.headers.get('x-notion-active-user-header');
      if (!['GET', 'HEAD'].includes(request.method) || user && uuid(user) !== item.userId || request.headers.get('origin') && request.headers.get('origin') !== item.origin || request.headers.get('sec-fetch-site') === 'cross-site') return new Response(null, { status: 404 });
      const resolved = this.store.resolve({ fileId: item.id, threadId: item.threadId, spaceId: item.spaceId }, item.userId, item.origin);
      return this.store.preview(new Request(resolved.url, { method: request.method }));
    } catch { return new Response(null, { status: 404 }); }
  }
}
module.exports = { LocalInlineDocuments, uploadPrefix, referencePrefix };
