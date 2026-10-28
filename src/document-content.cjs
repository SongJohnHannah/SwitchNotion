const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { decodeText } = require('./document-xml.cjs');
const { docx, xlsx } = require('./document-office.cjs');
const MAX_BYTES = 16 * 1024 * 1024, MAX_CHARACTERS = 240000;
const types = Object.freeze({
  '.txt': ['text/plain', 'plain'], '.md': ['text/markdown', 'plain'], '.markdown': ['text/markdown', 'plain'],
  '.csv': ['text/csv', 'csv'], '.tsv': ['text/tab-separated-values', 'tsv'], '.json': ['application/json', 'json'],
  '.pdf': ['application/pdf', 'pdf'], '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx']
});
function documentType(filename, mediaType) {
  if (typeof filename !== 'string' || !filename || filename.length > 255 || !filename.isWellFormed() || /[\\/\u0000-\u001f\u007f]/.test(filename)) throw Error('Notion 附件文件名无效。');
  const type = types[path.extname(filename).toLowerCase()];
  if (!type || typeof mediaType !== 'string' || !['', 'application/octet-stream', type[0], ...(type[1] === 'plain' ? ['text/plain'] : type[1] === 'csv' ? ['application/csv', 'application/vnd.ms-excel', 'text/plain'] : [])].includes(mediaType.toLowerCase()))
    throw Error('Notion 附件目前支持 TXT、Markdown、CSV、TSV、JSON、PDF、DOCX 和 XLSX；文件名与类型必须一致。');
  return { mediaType: type[0], format: type[1] };
}
function csv(value, separator) {
  const rows = []; let row = [], field = '', quoted = false, afterQuote = false, count = 0;
  const cell = () => { if (++count > 100000) throw Error('Notion 附件 CSV 单元格超过 100,000 个。'); row.push(field); field = ''; afterQuote = false; };
  const line = () => { cell(); rows.push({ row: rows.length + 1, values: row }); row = []; if (rows.length > 20000) throw Error('Notion 附件 CSV 超过 20,000 行。'); };
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted) { if (char === '"') { if (value[i + 1] === '"') { field += '"'; i++; } else { quoted = false; afterQuote = true; } } else field += char; continue; }
    if (char === separator) cell();
    else if (char === '\r' || char === '\n') { if (char === '\r' && value[i + 1] === '\n') i++; line(); }
    else if (char === '"' && !field && !afterQuote) quoted = true;
    else { if (afterQuote || char === '"') throw Error('Notion 附件 CSV 引号格式无效。'); field += char; }
  }
  if (quoted) throw Error('Notion 附件 CSV 引号未闭合。');
  if (field || row.length || afterQuote) line();
  return { format: separator === '\t' ? 'tsv' : 'csv', rows, complete: true, formula_execution: false };
}
async function pdf(bytes, { allowEmptyPdf = false } = {}) {
  if (!bytes.subarray(0, 1024).toString('latin1').includes('%PDF-')) throw Error('Notion 附件不是可识别的 PDF 文件。');
  const pdfjs = await import(pathToFileURL(path.join(__dirname, 'vendor/unpdf/dist/pdfjs.mjs')).href);
  const resource = (folder, name) => {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || name.includes('..')) throw Error('Notion 附件 PDF 字体资源名称无效。');
    const file = path.join(__dirname, 'vendor/pdfjs-dist', folder, name), info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw Error('Notion 附件 PDF 字体资源无效。');
    return new Uint8Array(fs.readFileSync(file));
  };
  // PDF.js 6 uses BinaryDataFactory for both maps and fonts. It never receives
  // a document-supplied URL or a caller-selected local path.
  class BinaryResources { async fetch({ kind, filename }) {
    if (kind === 'cMapUrl' && filename.endsWith('.bcmap')) return resource('cmaps', filename);
    if (kind === 'standardFontDataUrl') return resource('standard_fonts', filename);
    throw Error('Notion 附件 PDF 请求了未支持的静态资源。');
  } }
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
    BinaryDataFactory: BinaryResources, cMapPacked: true, disableAutoFetch: true, disableStream: true, useWasm: false,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false, stopAtErrors: true, verbosity: 0 });
  let document;
  try {
    document = await task.promise;
    if (document.numPages < 1 || document.numPages > 200) throw Error('Notion 附件 PDF 超过 200 页或页数无效。');
    const pages = [], empty = []; let characters = 0, items = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent({ includeMarkedContent: false }); let value = '';
        for (const item of content.items) if (typeof item.str === 'string') {
          if (++items > 100000) throw Error('Notion 附件 PDF 文字片段过多。');
          value += item.str + (item.hasEOL ? '\n' : ' ');
          if (characters + value.length > 200000) throw Error('Notion 附件 PDF 文字过长，请缩小范围。');
        }
        value = value.trim(); characters += value.length;
        pages.push({ page: number, text: value }); if (!value) empty.push(number);
      } finally { page.cleanup(); }
    }
    if (!allowEmptyPdf && empty.length === pages.length) throw Error('Notion 附件 PDF 没有可读取的文字层；扫描件需要 OCR，尚未作为文字发送。');
    return { format: 'pdf', pages, complete: empty.length === 0, text_layer_only: true, embedded_media_read: false, layout_rendered: false,
      warnings: empty.length ? ['第 ' + empty.join('、') + ' 页没有可读取文字层，尚未 OCR 或识别图像。'] : [] };
  } catch (error) {
    if (/^Notion /.test(error.message || '')) throw error;
    throw Error(error.name === 'PasswordException' ? 'Notion 附件 PDF 已加密，请先解密后重新上传。' : 'Notion 附件 PDF 文字层无法完整解析，未发送不完整的解析结果。');
  } finally { try { await task.destroy(); } catch {} }
}
async function extractDocument(bytes, filename, mediaType, options = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw Error('Notion 附件为空或超过 16 MB。');
  const type = documentType(filename, mediaType); let result;
  if (type.format === 'pdf') result = await pdf(bytes, options);
  else if (type.format === 'docx') result = docx(bytes);
  else if (type.format === 'xlsx') result = xlsx(bytes);
  else {
    const value = decodeText(bytes); if (!value.trim()) throw Error('Notion 附件没有可读取的文字。');
    if (value.length > 200000) throw Error('Notion 附件文字过长，请缩小范围。');
    if (['csv', 'tsv'].includes(type.format)) result = csv(value, type.format === 'tsv' ? '\t' : ',');
    else { if (type.format === 'json') { try { JSON.parse(value); } catch { throw Error('Notion 附件不是有效 JSON。'); } } result = { format: type.format, text: value, complete: true }; }
  }
  if (JSON.stringify(result).length > MAX_CHARACTERS) throw Error('Notion 附件解析结果过长，请拆分文件后重新上传。');
  return { ...result, filename: filename.normalize('NFC'), media_type: type.mediaType, source_bytes: bytes.length, active_content_executed: false, external_resources_fetched: false };
}
module.exports = { documentType, extractDocument, MAX_BYTES, MAX_CHARACTERS };
