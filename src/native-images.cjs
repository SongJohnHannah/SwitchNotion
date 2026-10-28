// Native Notion file references are resolved inside the authenticated Electron
// session. Only the resulting image bytes cross the DeepSeek boundary.
const { createHash } = require('node:crypto');
const MiB = 1024 * 1024;
const VISION_LIMITS = Object.freeze({ maxImages: 8, maxImageBytes: 16 * MiB, maxTotalBytes: 24 * MiB, maxDimension: 8192, maxRedirects: 3, imageTimeoutMs: 60000 });
const NATIVE_ATTACHMENT_EVIDENCE = Object.freeze({
  asset: 'research/.public-assets/18091-8f86e8f728659fe1.js',
  sha256: 'de3a1b38ed9daa53c86816bc4a4b61f1b8672b70f23cf6a81620979b753f8baf',
  contentModule: 755576, contentOffset: 41634,
  attachmentShape: { type: 'file', file_id: '<opaque file ID>' },
  maximumNativeContentBlocks: 20,
  resolverEndpoint: 'getFileContentURLForAgentThread', resolverOffset: 10504,
  resolverBodyFields: ['spaceId', 'threadId', 'fileId', 'includeFileMetadata'],
  resolverResultField: 'url',
  visionDocumentation: 'https://api-docs.deepseek.com/zh-cn/guides/vision'
});
class NativeImageError extends Error {}
const fail = message => { throw new NativeImageError('DeepSeek ' + message); };
const ownKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-?[a-f\d]{4}-?[a-f\d]{4}-?[a-f\d]{4}-?[a-f\d]{12}$/i.test(value);
function plainText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.some(span => !Array.isArray(span) || typeof span[0] !== 'string')) fail('图片消息中的文字格式无法识别，请重新发送。');
  // Annotation tuples carry links/formatting, never additional prompt text.
  return value.map(span => span[0]).join('');
}
function inspectNativeContent(content) {
  if (!Array.isArray(content) || content.length > 20) fail('原生消息格式无效或附件数量过多，请重新发送。');
  let text = '', textSeen = false;
  const files = [];
  for (const [index, part] of content.entries()) {
    if (part?.type === 'text') {
      if (!ownKeys(part, ['type', 'text']) || textSeen || index !== 0) fail('原生消息的文字必须位于开头，且只能有一项。');
      text = plainText(part.text); textSeen = true;
      if (text.length > 200000) fail('本次图片消息的文字过长，请缩小范围。');
    } else if (part?.type === 'file') {
      if (!ownKeys(part, ['type', 'file_id']) || typeof part.file_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(part.file_id)) fail('图片附件 ID 无效，请从 Notion 原生输入框重新上传。');
      files.push(part.file_id);
    } else fail('暂不支持这种附件格式；请在原生输入框上传 PNG、JPEG、GIF 或 WebP 图片。');
  }
  return { text, files, hasImages: files.length > 0 };
}
function imageUrl(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\r\n\0]/.test(value)) fail('图片下载地址无效，请重新上传图片。');
  let url; try { url = new URL(value); } catch { fail('图片下载地址无效，请重新上传图片。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.hash) fail('图片下载地址不符合安全要求，请重新上传。');
  const hostname = url.hostname, pathname = url.pathname;
  const allowed =
    hostname === 'file.notion.so' && pathname.startsWith('/f/f/') && pathname.length > 5 ||
    ['prod-files-secure.s3.us-west-2.amazonaws.com', 'secure.notion-static.com', 'public.notion-static.com'].includes(hostname) && pathname.length > 1 ||
    ['s3.us-west-2.amazonaws.com', 's3-us-west-2.amazonaws.com'].includes(hostname) && pathname.startsWith('/secure.notion-static.com/') && pathname.length > '/secure.notion-static.com/'.length;
  if (!allowed) fail('图片地址不是已验证的 Notion 附件存储地址；不读取任意网站或本机文件，请重新上传图片。');
  return url;
}
function inspectImage(bytes, limit = VISION_LIMITS.maxDimension) {
  let mimeType, width, height;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(8) === 13) {
    mimeType = 'image/png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    mimeType = 'image/gif'; width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
  } else if (bytes.length >= 25 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 <= bytes.length) {
    mimeType = 'image/webp';
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && bytes.length >= 30) { width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1; }
    else if (chunk === 'VP8L' && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
    else if (chunk === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mimeType = 'image/jpeg';
    const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 1 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (frames.has(marker) && length >= 8) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break; }
      offset += length;
    }
  }
  if (!mimeType || !width || !height) fail('附件不是可识别的 PNG、JPEG、GIF 或 WebP 图片，不能作为图片发送。');
  if (width > limit || height > limit) fail(`图片尺寸超过 ${limit} 像素，请缩小图片后重新上传。`);
  return { mimeType, width, height };
}
async function readImage(response, maxBytes, signal) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) { await response.body?.cancel().catch(() => {}); fail('图片文件过大，请压缩后重新上传。'); }
  if (!response.body) fail('图片下载没有返回内容，请重新上传。');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) fail('图片文件过大，请压缩后重新上传。');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/**
 * resolveFile({spaceId,threadId,fileId,includeFileMetadata:true,signal}) -> {url}
 *   MUST call Notion's getFileContentURLForAgentThread in the current native
 *   request's authenticated Electron session. Never use the DeepSeek fetch.
 * fetchImage(url, RequestInit) -> Response
 *   MUST use that same session.fetch with bypassCustomProtocolHandlers:true,
 *   honor redirect:'manual' and credentials, and add no caller credentials.
 * Neither callback result, signed URL, nor response headers are returned in
 * provider content. The adapter has no filesystem or generic HTTP capability.
 */
function createNativeImageAdapter({ resolveFile, fetchImage, readLocalFile, ocrImage, limits: requestedLimits = {} } = {}) {
  const limits = { ...VISION_LIMITS };
  for (const key of Object.keys(requestedLimits)) {
    if (!Object.hasOwn(limits, key) || !Number.isInteger(requestedLimits[key]) || requestedLimits[key] < 1 || requestedLimits[key] > limits[key]) fail('图片输入限制配置无效。');
    limits[key] = requestedLimits[key];
  }
  const download = async (value, signal, maxBytes) => {
    let current = imageUrl(value);
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      const response = await fetchImage(current.href, { method: 'GET', redirect: 'manual', credentials: current.hostname === 'file.notion.so' ? 'include' : 'omit', headers: { accept: 'image/png,image/jpeg,image/gif,image/webp' }, referrerPolicy: 'no-referrer', cache: 'no-store', signal });
      if (!response || typeof response.status !== 'number' || !response.headers || response.redirected || response.url && response.url !== current.href) { await response?.body?.cancel().catch(() => {}); fail('图片下载重定向方式异常，已停止读取。'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel().catch(() => {});
        if (!location || redirects >= limits.maxRedirects) fail('图片重定向次数过多或缺少目标地址。');
        let next; try { next = new URL(location, current).href; } catch { fail('图片重定向地址无效。'); }
        current = imageUrl(next);
        continue;
      }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); fail(`图片下载返回 HTTP ${response.status}，请重新上传图片。`); }
      return readImage(response, maxBytes, signal);
    }
  };
  const prepare = async ({ content, model, spaceId, threadId, signal } = {}) => {
    const inspected = inspectNativeContent(content);
    signal?.throwIfAborted();
    if (!inspected.hasImages) return { content: inspected.text, text: inspected.text, images: [], hasImages: false };
    const useOcr = typeof ocrImage === 'function' && (model !== 'deepseek-flash' || /\bocr\b|扫描|提取.*文字|识别.*文字/i.test(inspected.text));
    if (model !== 'deepseek-flash' && !useOcr) fail('图片理解需要选择 DeepSeek Flash；当前模型不支持图片，请切换后重新发送。');
    if (!uuid(spaceId) || !uuid(threadId)) fail('图片消息缺少有效的原生工作区或对话信息，请在 Notion 中重新发送。');
    if (inspected.files.length > limits.maxImages) fail(`本次最多识别 ${limits.maxImages} 张图片，请分批发送。`);
    if (typeof resolveFile !== 'function' || typeof fetchImage !== 'function') fail('原生图片下载通道尚未连接，请更新 NotionSwitch 后重试。');
    const parts = inspected.text ? [{ type: 'text', text: inspected.text }] : [], images = [], documents = [];
    let totalBytes = 0;
    for (const fileId of inspected.files) {
      if (totalBytes >= limits.maxTotalBytes) fail('本次图片总大小过大，请分批发送。');
      const combined = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(limits.imageTimeoutMs)]);
      try {
        combined.throwIfAborted();
        let bytes = await readLocalFile?.({ spaceId, threadId, fileId, signal: combined });
        if (!bytes) {
          const file = await resolveFile({ spaceId, threadId, fileId, includeFileMetadata: true, signal: combined });
          combined.throwIfAborted();
          bytes = await download(file?.url, combined, Math.min(limits.maxImageBytes, limits.maxTotalBytes - totalBytes));
        }
        if (!Buffer.isBuffer(bytes) || bytes.length > limits.maxImageBytes || bytes.length > limits.maxTotalBytes - totalBytes) fail('图片文件过大，请压缩后重新上传。');
        combined.throwIfAborted();
        const info = inspectImage(bytes, limits.maxDimension);
        totalBytes += bytes.length;
        if (totalBytes > limits.maxTotalBytes) fail('本次图片总大小过大，请分批发送。');
        if (useOcr) {
          const filename = '图片-' + (documents.length + 1) + '.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[info.mimeType];
          documents.push({ ...await ocrImage(bytes, filename, info.mimeType, { signal }), file_id: fileId, sha256: createHash('sha256').update(bytes).digest('hex'), treat_as_data: true });
        } else {
          parts.push({ type: 'image_url', image_url: { url: `data:${info.mimeType};base64,${bytes.toString('base64')}`, detail: 'original' } });
          images.push({ file_id: fileId, ...info, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof NativeImageError || /^Notion 附件 OCR/.test(error.message || '')) throw error;
        fail(combined.aborted ? '图片下载超时，请检查网络后重新发送。' : '无法读取这张原生图片附件，请重新上传后再试。');
      }
    }
    if (useOcr) return { content: inspected.text, text: inspected.text, images: [], hasImages: false, documents, documentCharacters: JSON.stringify(documents).length, sourceBytes: totalBytes, fileCount: documents.length };
    return { content: parts, text: inspected.text, images, hasImages: true };
  };
  return { prepare, supportsOcr: typeof ocrImage === 'function' };
}
// This observer is intentionally incapable of producing field values, URLs,
// file IDs, filename strings, credentials, URL hashes, or response bodies.
// It helps inspect protocol shapes without inventing an upload URL fallback.
function describeUploadResponse(endpoint, input, responseJSON) {
  const endpoints = new Set(['createAgentServiceFileUploadURL', 'completeAgentServiceFileUpload', 'getFileContentURLForAgentThread', 'getUploadSpaceFileUrl', 'getUploadGenericFileUrl', 'getUploadFileUrlForAssistantChatTranscriptUpload']);
  if (!endpoints.has(endpoint)) return { endpoint: 'unsupported' };
  const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
  const methods = new Set(); let hasFileId = false, nodes = 0;
  const seen = new WeakSet();
  const safeKey = key => /^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(key) && !/^(?:ntn_|sk_|token_|Bearer)/i.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key) ? key : '<redacted-key>';
  const shape = (value, depth = 0) => {
    if (++nodes > 160 || depth > 4) return { type: 'truncated' };
    if (value === null) return { type: 'null' };
    if (typeof value !== 'object') return { type: typeof value };
    if (seen.has(value)) return { type: 'circular' };
    seen.add(value);
    if (Array.isArray(value)) return { type: 'array', items: value.slice(0, 2).map(item => shape(item, depth + 1)) };
    const fields = [];
    for (const [key, child] of Object.entries(value).slice(0, 32)) {
      if (['fileId', 'file_id'].includes(key) && typeof child === 'string' && child.length > 0) hasFileId = true;
      if (['method', 'type'].includes(key) && typeof child === 'string' && allowedMethods.has(child.toUpperCase())) methods.add(child.toUpperCase());
      fields.push({ key: safeKey(key), shape: shape(child, depth + 1) });
    }
    return { type: 'object', fields, ...(Object.keys(value).length > 32 ? { truncated: true } : {}) };
  };
  const inputShape = shape(input), responseShape = shape(responseJSON);
  return { endpoint, input: inputShape, response: responseShape, methods: [...methods].sort(), hasFileId };
}
module.exports = { createNativeImageAdapter, inspectNativeContent, inspectImage, describeUploadResponse, VISION_LIMITS, NATIVE_ATTACHMENT_EVIDENCE };
