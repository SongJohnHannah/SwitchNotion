const { createHash } = require('node:crypto');
const { parse } = require('./parser.cjs');
const assetName = '51103-3324439f61c31e75.js';
const sourceHash = '4bfc72339b57ee5fddbd9428afa5f2b5060ff4f190501ce79e47488dc254f924';
const reviewed = new Map([
  [sourceHash, { converter: 917398, subscriber: 'cK' }],
  ['390857956053ace5c09b2f9c65ace352363d3244126a8f5a61a2b9c1dd997abb', { converter: 296328, subscriber: 'cK' }],
  ['f578c989a7e27f8edb0ef487f9e627e7f29108ff1f925e1fa1dd46d84bd74bbf', { converter: 296328, subscriber: 'cK' }],
  ['6843d0c2b77c8659c620236d5999061549dd54a863a6985f45f8b44de3996424', { converter: 296328, subscriber: 'cK' }],
  ['acc053555a9a22b8ff195850c30aedb65a98ce90659744e9336e6a58884289f3', { converter: 296328, subscriber: 'subscribeToTaskOutput' }]
]);
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
  const profile = reviewed.get(createHash('sha256').update(source).digest('hex'));
  if (!isInlineDocumentAsset(asset) || !profile)
    throw Object.assign(Error('Unreviewed native attachment consumer'), { notionSwitchKind: 'attachments' });
  const anchor = 'try{let e=await (0,a(655696).' + profile.subscriber + ')({environment:t,outputKey:u.data.outputKey';
  if (source.split(anchor).length !== 2) throw Error('Changed native attachment task consumer');
  const requestAt = 'await t.api.callCellCompatibleApi({eventName:"processAgentAttachment"';
  if (source.split(requestAt).length !== 2) throw Error('Changed native attachment processing request');
  const helper = localProcessedAttachment.toString().replace('nativeRequire(917398)', 'nativeRequire(' + profile.converter + ')');
  const injected = 'const __notionSwitchLocalDocument=(' + helper + ')(a,u,r,s,o);if(__notionSwitchLocalDocument!==undefined)return __notionSwitchLocalDocument;';
  const output = source.replace(anchor, injected + anchor).replace(requestAt, 'await (' + invokeProcessAttachment.toString() + ')(t,{eventName:"processAgentAttachment"');
  parse(output, { ecmaVersion: 2024 });
  onAdaptation?.({ moduleId: '175529', kind: 'attachments', mode: 'reviewed' });
  return output;
}
module.exports = { localProcessedAttachment, invokeProcessAttachment, adaptInlineDocuments, isInlineDocumentAsset, isInlineDocumentCandidate, assetName, sourceHash };
