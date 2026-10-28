import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NativeMock, json } = require('../../src/native-mock.cjs');
const { LocalDocumentUploads, prefix: localDocumentUploadPrefix, previewPrefix: localDocumentPreviewPrefix } = require('../../src/local-document-uploads.cjs');
const { LocalInlineDocuments, uploadPrefix: inlineDocumentUploadPrefix, referencePrefix: inlineDocumentReferencePrefix } = require('../../src/local-inline-documents.cjs');
const { LocalImageUploads, prefix: localUploadPrefix } = require('../../src/local-image-uploads.cjs');
const { createNativeAttachmentAdapter } = require('../../src/native-attachments.cjs');
const { createNativeImageAdapter } = require('../../src/native-images.cjs');
const { localRecords } = require('../../src/local-records.cjs');
export const id = n => 'c200aa00-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
export const USER = id(1), SPACE = id(2), THREAD = id(3), ORIGIN = 'https://app.notion.com';
export function inlineDocumentRoute(root, { provider, allowUpstream = false } = {}) {
  fs.mkdirSync(root, { recursive: true }); let native;
  const calls = [], forwarded = [], options = { stateFile: path.join(root, 'conversations.json'), provider: provider || {
    status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek', model: 'deepseek-v4-pro', multiAgent: false }), async* generate(args) {
      calls.push(args); assert.equal(args.tools, undefined); assert.match(JSON.stringify(args.messages), /927/); yield '合成文件中的代码为927。';
    }
  } };
  const stores = () => {
    const localDocuments = new LocalDocumentUploads({ root, record: (value, scope) => native.record(value, 'thread', scope) });
    return { localDocuments, localImages: new LocalImageUploads({ root, owns: value => native.owns(value), record: value => native.record(value) }),
      localInlineDocuments: new LocalInlineDocuments({ root, store: localDocuments, reserve: value => native.reserveInlineUpload(value) }) };
  };
  native = new NativeMock(options);
  const context = { Request, Response, Headers, URL, mock: native, provider: options.provider, json, localRecords, aiRecords: native, ...stores(),
    localDocumentUploadPrefix, localDocumentPreviewPrefix, localUploadPrefix, inlineDocumentUploadPrefix, inlineDocumentReferencePrefix,
    createNativeAttachmentAdapter, createNativeImageAdapter, settings: { speech: { enabled: false }, isLoginSyncing: () => false }, nativeSpeech: { enabled: false },
    meetingBridge: { observe() {} }, recordings: { wake() {} }, log() {}, isNotion: hostname => hostname === 'app.notion.com', endpoints: new Set(['runInferenceTranscript', 'stopWorkflowAutomationRunThread']) };
  const source = fs.readFileSync(new URL('../../src/desktop-hook.cjs', import.meta.url), 'utf8');
  const route = vm.runInNewContext(source.slice(source.indexOf('async function route('), source.indexOf('\nfunction install(ses)')) + '\nroute', context);
  const raw = request => route(request, async value => { forwarded.push(new URL(value.url).pathname); assert.ok(allowUpstream, 'Local document operation must not go upstream'); return json({ syntheticUpstream: true }); });
  const call = (endpoint, value, userId = USER) => raw(new Request(ORIGIN + '/api/v3/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-notion-active-user-header': userId,
    ...(endpoint === 'processAgentAttachment' ? { 'x-notion-switch-inline-documents-client': '1' } : {}) }, body: JSON.stringify(value) }));
  let sequence = 10;
  const create = (name, contentType, bytes, threadId = THREAD, userId = USER) => call('getUploadFileUrlForAssistantChatTranscriptUpload', {
    name, contentType, contentLength: bytes.length, createThread: true, assistantChatTranscriptSessionPointer: { table: 'thread', id: threadId, spaceId: SPACE }
  }, userId);
  const upload = async (filename, contentType, bytes, { type = 'attachment', threadId = THREAD, userId = USER } = {}) => {
    const response = await create('transport-' + sequence + path.extname(filename), contentType, bytes, threadId, userId);
    assert.equal(response.status, 200); const created = await response.json();
    const form = new FormData(); for (const [key, value] of Object.entries(created.fields)) form.append(key, value);
    form.append('file', new Blob([bytes], { type: contentType }), 'transport-' + sequence + path.extname(filename));
    const post = await raw(new Request(created.signedUploadPostUrl, { method: 'POST', body: form })); assert.equal(post.status, 204);
    return { id: id(sequence++), type, fileUrl: created.url, fileName: filename, contentType, metadata: { attachmentSource: 'user_upload' } };
  };
  const input = (attachments, text = '只根据上传的合成文档回答代码，保留来源位置', threadId = THREAD) => ({ threadId, spaceId: SPACE, createdSource: 'writer', transcript: [
    { id: id(100), type: 'config', value: { type: 'writer' } }, ...attachments,
    { id: id(101), type: 'user', value: [[text]] }
  ] });
  const process = (step, edits = {}, userId = USER) => call('processAgentAttachment', { url: step.fileUrl, source: 'user_upload', spaceId: SPACE,
    aiSessionPointer: { table: 'thread', id: THREAD, spaceId: SPACE }, permissionRecord: { table: 'thread', id: THREAD, spaceId: SPACE }, ...edits }, userId);
  const close = () => { native.close(); clearTimeout(native.agent.saveTimer); };
  return { root, context, calls, forwarded, raw, call, create, upload, input, process, close, get native() { return native; }, restore() {
    close(); native = new NativeMock(options); Object.assign(context, { mock: native, aiRecords: native, ...stores() }); return native;
  } };
}
