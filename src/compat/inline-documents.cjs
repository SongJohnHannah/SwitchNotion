const { createHash } = require('node:crypto');
const { parse } = require('./parser.cjs');
const assetName = '51103-3324439f61c31e75.js';
const sourceHash = '4bfc72339b57ee5fddbd9428afa5f2b5060ff4f190501ce79e47488dc254f924';
const isInlineDocumentAsset = value => /^51103-[a-f\d]{16}\.js$/.test(value);
const isInlineDocumentCandidate = (source, asset) => isInlineDocumentAsset(asset) || /[,{]\s*175529\s*\(/.test(source);
async function invokeProcessAttachment(environment, request) {
  let local = false;
  try { const url = new URL(request.data.url); local = url.origin === globalThis.location?.origin && url.pathname.startsWith('/notion-switch-inline-document/'); } catch {}
  return environment.api.callCellCompatibleApi(local ? { ...request, headers: { ...(request.headers || {}), 'x-notion-switch-inline-documents-client': '1' } } : request);
}

// Runs in the reviewed native attachment consumer. Ordinary Notion responses,
// images and their task subscriptions are unchanged. The local response carries
// only parsed file metadata; document body is supplied later with the question.
function localProcessedAttachment(nativeRequire, response, fileName, originalFileUrl, pointer) {
  const marker = response?.data?.notionSwitchDocument;
  if (response?.type !== 'success' || marker?.version !== 1) return undefined;
  const value = marker.result;
  if (!value || !['application/pdf', 'text/csv', 'text/plain', 'text/markdown', 'application/json'].includes(value.contentType) ||
      !Number.isSafeInteger(value.fileSizeBytes) || value.fileSizeBytes < 1 || value.fileSizeBytes > 16 * 1024 * 1024 ||
      value.contentType === 'application/pdf' && (!Number.isSafeInteger(value.numPages) || value.numPages < 1 || value.numPages > 200) ||
      value.contentType === 'text/csv' && (!Number.isSafeInteger(value.numRows) || !Number.isSafeInteger(value.numFields) || value.numRows < 0 || value.numFields < 0))
    throw Error('Notion 本地附件处理回执无效。');
  const data = nativeRequire(917398).tX({ result: value, attachmentSource: 'user_upload', fileName, originalFileUrl, threadId: pointer.id });
  if (!data) throw Error('Notion 本地附件类型不受此原生入口支持。');
  return nativeRequire(80279).Q.success(data);
}
function adaptInlineDocuments(source, asset, onAdaptation) {
  if (!isInlineDocumentAsset(asset) || createHash('sha256').update(source).digest('hex') !== sourceHash)
    throw Object.assign(Error('Unreviewed native attachment consumer'), { notionSwitchKind: 'attachments' });
  const anchor = 'try{let e=await (0,a(655696).cK)({environment:t,outputKey:u.data.outputKey';
  if (source.split(anchor).length !== 2) throw Error('Changed native attachment task consumer');
  const requestAt = 'await t.api.callCellCompatibleApi({eventName:"processAgentAttachment"';
  if (source.split(requestAt).length !== 2) throw Error('Changed native attachment processing request');
  const injected = 'const __notionSwitchLocalDocument=(' + localProcessedAttachment.toString() + ')(a,u,r,s,o);if(__notionSwitchLocalDocument!==undefined)return __notionSwitchLocalDocument;';
  const output = source.replace(anchor, injected + anchor).replace(requestAt, 'await (' + invokeProcessAttachment.toString() + ')(t,{eventName:"processAgentAttachment"');
  parse(output, { ecmaVersion: 2024 });
  onAdaptation?.({ moduleId: '175529', kind: 'attachments', mode: 'reviewed' });
  return output;
}
module.exports = { localProcessedAttachment, invokeProcessAttachment, adaptInlineDocuments, isInlineDocumentAsset, isInlineDocumentCandidate, assetName, sourceHash };
