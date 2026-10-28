// User-authorized local chat documents only. This adapter does not add a
// resolver for Notion page files, personal instructions, or skills.
const { inspectNativeContent } = require('./native-images.cjs');
const { parseAttachment } = require('./document-parser.cjs');
const { uuid } = require('./native-context.cjs');
const { createHash } = require('node:crypto');
function createNativeAttachmentAdapter({ images, readLocalDocument, parseContent = parseAttachment } = {}) {
  return { supportsDocuments: true, supportsOcr: images?.supportsOcr === true, async prepare({ content, model, spaceId, threadId, signal, skipImages = false, allowEmptyText = false, knownDocumentIds = [] }) {
    const inspected = inspectNativeContent(content), documents = [], imageParts = [], documentFileIds = [], unique = [...new Set(inspected.files)];
    if (unique.length > 8) throw Error('Notion 附件每条消息最多 8 个文件，请分批发送。');
    const known = new Set(knownDocumentIds.map(value => uuid(value) || value)); let bytes = 0, characters = 0;
    for (const fileId of unique) {
      signal?.throwIfAborted(); let file;
      try { file = await readLocalDocument?.({ fileId, spaceId, threadId, signal }); }
      catch (error) { throw Error(/^Notion /.test(error.message || '') ? error.message : 'Notion 本地附件无法读取，请重新上传。'); }
      signal?.throwIfAborted();
      if (!file) {
        if (known.has(uuid(fileId) || fileId)) throw Error('Notion 本地文档已丢失或不可访问，请重新上传；没有转交远程读取。');
        imageParts.push({ type: 'file', file_id: fileId }); continue;
      }
      if (!allowEmptyText && !inspected.text.trim()) throw Error('Notion 附件请先输入文档处理问题后再发送。');
      if (!Buffer.isBuffer(file.bytes) || (bytes += file.bytes.length) > 24 * 1024 * 1024) throw Error('Notion 附件本条消息总大小超过 24 MB。');
      const result = await parseContent(file.bytes, file.filename, file.mediaType, { signal, forceOcr: /\bocr\b|扫描|识别.*文字/i.test(inspected.text) });
      if ((characters += JSON.stringify(result).length) > 240000) throw Error('Notion 附件本条消息文字过长，请拆分文件后重新发送。');
      documents.push({ ...result, file_id: fileId, sha256: createHash('sha256').update(file.bytes).digest('hex'), treat_as_data: true });
      documentFileIds.push(file.id || fileId);
    }
    let normalized = { content: inspected.text, images: [], hasImages: false };
    if (imageParts.length && !skipImages) {
      if (!images?.prepare) throw Error('DeepSeek 原生图片通道尚未连接。');
      normalized = await images.prepare({ content: [...(inspected.text ? [{ type: 'text', text: inspected.text }] : []), ...imageParts], model, spaceId, threadId, signal });
      bytes += normalized.sourceBytes ?? normalized.images.reduce((sum, image) => sum + image.bytes, 0);
      if (normalized.documents?.length) { documents.push(...normalized.documents); documentFileIds.push(...(normalized.documentFileIds || [])); characters += normalized.documentCharacters; }
    }
    if (bytes > 24 * 1024 * 1024) throw Error('Notion 附件本条消息总大小超过 24 MB。');
    if (characters > 240000) throw Error('Notion 附件本条消息 OCR 正文过长，请拆分后重新发送。');
    return { ...normalized, documents, documentFileIds, documentCharacters: characters, sourceBytes: bytes, fileCount: documents.length + normalized.images.length,
      omittedImages: skipImages && imageParts.length > 0 };
  } };
}
module.exports = { createNativeAttachmentAdapter };
