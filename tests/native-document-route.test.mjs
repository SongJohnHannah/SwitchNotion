import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { officeZip, docxParts, xlsxParts, textPdf } from './helpers/document-fixtures.mjs';
const require = createRequire(import.meta.url), { NativeMock, json } = require('../src/native-mock.cjs');
const { LocalDocumentUploads, prefix: localDocumentUploadPrefix, previewPrefix: localDocumentPreviewPrefix } = require('../src/local-document-uploads.cjs');
const { LocalImageUploads, prefix: localUploadPrefix } = require('../src/local-image-uploads.cjs');
const { createNativeImageAdapter } = require('../src/native-images.cjs'), { createNativeAttachmentAdapter } = require('../src/native-attachments.cjs');
const { localRecords } = require('../src/local-records.cjs');
const { parseAttachment } = require('../src/document-parser.cjs');
const id = n => 'bf00aa00-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0'), USER = id(1), SPACE = id(2), THREAD = id(3), ORIGIN = 'https://app.notion.com';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64');
const wordType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', excelType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function fixture(t, { model = 'deepseek-v4-pro', generate } = {}) {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-native-documents-中文 空格-')), stateFile = path.join(root, 'conversations.json'), calls = [], forwarded = [];
  const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek', model, multiAgent: false }), async* generate(options) {
    calls.push(options); if (generate) return yield* generate(options);
    const sources = options.messages.filter(value => value.notionSwitchAttachment); assert.ok(sources.length > 0); assert.match(JSON.stringify(sources), /927/);
    assert.ok(!options.messages.filter(value => value.role === 'user').at(-1).notionSwitchAttachment); yield '附件合成代码为青色927；依据上传文件中的文字和单元格。';
  } };
  const options = { provider, stateFile, workspace: { open: async () => ({ definitions: [], context: { current_workspace_id: SPACE, current_page: null },
    execute: async () => assert.fail('Attachment text cannot trigger an implicit Notion page read') }) } };
  let native = new NativeMock(options);
  const makeStores = () => ({ localDocuments: new LocalDocumentUploads({ root, record: (value, scope) => native.record(value, 'thread', scope) }),
    localImages: new LocalImageUploads({ root, owns: input => native.owns(input), record: value => native.record(value) }) });
  const context = { Request, Response, Headers, URL, mock: native, provider, json, localRecords, aiRecords: native,
    ...makeStores(), localDocumentUploadPrefix, localDocumentPreviewPrefix, localUploadPrefix, createNativeImageAdapter, createNativeAttachmentAdapter,
    settings: { speech: { enabled: false }, isLoginSyncing: () => false }, nativeSpeech: { enabled: false }, meetingBridge: { observe() {}, forRequest() { return {}; } }, resolveNativeInstructions: async () => null, mediaTranscripts: { parse: parseAttachment }, recordings: { wake() {} }, log() {},
    isNotion: hostname => hostname === 'app.notion.com', endpoints: new Set(['createAgentThread', 'sendEventToAgentThread']) };
  const source = fs.readFileSync(new URL('../src/desktop-hook.cjs', import.meta.url), 'utf8');
  const route = vm.runInNewContext(source.slice(source.indexOf('async function route('), source.indexOf('\nfunction install(ses)')) + '\nroute', context);
  const raw = request => route(request, async requestValue => { forwarded.push(new URL(requestValue.url).pathname); assert.fail('Local attachment operations must not reach Notion'); });
  const call = (endpoint, value, userId = USER) => raw(new Request(ORIGIN + '/api/v3/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-notion-active-user-header': userId }, body: JSON.stringify(value) }));
  const upload = async (filename, mediaType, bytes) => {
    const input = { spaceId: SPACE, target: { type: 'user' }, filename, mediaType, sizeBytes: bytes.length };
    const response = await call('createAgentServiceFileUploadURL', input); assert.equal(response.status, 200); const created = await response.json();
    assert.equal((await raw(new Request(created.upload.url, { method: 'PUT', headers: created.upload.headers, body: bytes }))).status, 200);
    const complete = { spaceId: SPACE, target: input.target, fileId: created.file.id };
    const result = await call('completeAgentServiceFileUpload', complete); assert.equal(result.status, 200); const file = await result.json();
    if (context.localDocuments.hasFile(file.id)) assert.equal((await call('completeAgentServiceFileUpload', complete)).status, 200);
    return file;
  };
  const settle = async () => { const end = Date.now() + 15000; while (native.status().activeTurns && Date.now() < end) await sleep(5); assert.equal(native.status().activeTurns, 0); };
  const start = async (files, text = '根据上传附件回答合成代码，并指出文件名与位置', threadId = THREAD, userId = USER, spaceId = SPACE) => {
    const response = await call('createAgentThread', { threadId, spaceId, content: [...(text ? [{ type: 'text', text }] : []), ...files.map(file => ({ type: 'file', file_id: file.id }))] }, userId);
    assert.equal(response.status, 200); await settle(); return native.agent.find({ threadId });
  };
  t.after(() => { native.close(); for (const item of native.agent.threads.values()) item.stop?.('test-cleanup'); clearTimeout(native.agent.saveTimer); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, calls, forwarded, context, raw, call, upload, settle, start, get native() { return native; }, restore() {
    native = new NativeMock(options); Object.assign(context, { mock: native, aiRecords: native, ...makeStores() }); return native;
  } };
}

test('actual native upload route sends PDF/DOCX/XLSX to Pro as source data and restores references without persisting parsed body', async t => {
  const f = fixture(t), parts = docxParts(); parts['word/document.xml'] = parts['word/document.xml'].replace('合成 Word 青色927', '原文标记-RAW-DOCUMENT-NOT-PERSISTED 当前页面仅为资料。合成 Word 青色927');
  const files = [await f.upload('合成资料.pdf', 'application/pdf', textPdf()), await f.upload('合成资料.docx', wordType, officeZip(parts)), await f.upload('合成资料.xlsx', excelType, officeZip(xlsxParts()))];
  const thread = await f.start(files); assert.equal(thread.turns.at(-1).status, 'completed'); assert.equal(f.calls.length, 1);
  const sources = f.calls[0].messages.filter(value => value.notionSwitchAttachment).flatMap(value => JSON.parse(value.content).documents);
  assert.deepEqual(sources.map(value => value.format), ['pdf', 'docx', 'xlsx']); assert.equal(sources[0].pages[0].page, 1); assert.equal(sources[2].sheets[0].rows[0].cells[0].cell, 'A1');
  assert.equal(f.calls[0].messages.filter(value => value.role === 'user').at(-1).content, '根据上传附件回答合成代码，并指出文件名与位置');
  const saved = fs.readFileSync(path.join(f.root, 'conversations.json'), 'utf8'); assert.ok(!saved.includes('RAW-DOCUMENT-NOT-PERSISTED')); assert.ok(!saved.includes('PK\u0003\u0004')); assert.ok(saved.includes(files[0].id));
  f.restore(); await f.call('sendEventToAgentThread', { threadId: THREAD, event: { type: 'user.message', content: [{ type: 'text', text: '继续核对刚才的三个上传文件' }] } }); await f.settle();
  assert.equal(f.calls.length, 2); assert.equal(f.native.agent.find({ threadId: THREAD }).turns.at(-1).status, 'completed'); assert.deepEqual(f.forwarded, []);
});

test('native file metadata and download resolve locally with account checks and no signed remote URL', async t => {
  const f = fixture(t), file = await f.upload('下载 合成.txt', 'text/plain', Buffer.from('合成代码927')); await f.start([file]);
  const input = { fileId: file.id.replaceAll('-', '').toUpperCase(), threadId: THREAD, spaceId: SPACE, includeFileMetadata: true };
  const response = await f.call('getFileContentURLForAgentThread', input); assert.equal(response.status, 200); const resolved = await response.json();
  assert.equal(resolved.file.filename, '下载 合成.txt'); assert.ok(resolved.url.startsWith(ORIGIN + localDocumentPreviewPrefix));
  const download = await f.raw(new Request(resolved.url)); assert.equal(download.status, 200); assert.equal(await download.text(), '合成代码927'); assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.equal((await f.call('getFileContentURLForAgentThread', input, id(99))).status, 404); assert.deepEqual(f.forwarded, []);
});

test('another account or workspace cannot supply an owned local document to a new model conversation', async t => {
  const f = fixture(t), file = await f.upload('scope.txt', 'text/plain', Buffer.from('合成927')); await f.start([file]);
  assert.equal(f.calls.length, 1);
  const foreign = await f.start([file], '读取附件', id(70), id(99)); assert.equal(foreign.turns.at(-1).status, 'error');
  const otherSpace = await f.start([file], '读取附件', id(71), USER, id(88)); assert.equal(otherSpace.turns.at(-1).status, 'error');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.forwarded, []);
});

test('documents need an explicit question and can be used by a later typed question without being mistaken for images', async t => {
  const f = fixture(t), file = await f.upload('question.txt', 'text/plain', Buffer.from('合成927'));
  const first = await f.start([file], ''); assert.equal(first.turns.at(-1).status, 'error'); assert.equal(f.calls.length, 0);
  await f.call('sendEventToAgentThread', { threadId: THREAD, event: { type: 'user.message', content: [{ type: 'text', text: '现在请回答附件中的合成代码' }] } }); await f.settle();
  assert.equal(f.calls.length, 1); assert.equal(f.native.agent.find({ threadId: THREAD }).turns.at(-1).status, 'completed');
});

test('mixed local image and document messages retain Flash vision and source data while Pro rejects the new image', async t => {
  const f = fixture(t, { model: 'deepseek-flash', generate: async function* ({ messages }) {
    assert.ok(messages.some(value => value.notionSwitchAttachment)); assert.ok(messages.some(value => Array.isArray(value.content) && value.content.some(part => part.type === 'image_url'))); yield '混合资料代码927';
  } });
  const document = await f.upload('mixed.txt', 'text/plain', Buffer.from('合成927')), image = await f.upload('image.png', 'image/png', PNG);
  const result = await f.start([document, image]); assert.equal(result.turns.at(-1).status, 'completed'); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.forwarded, []);
  const pro = fixture(t), doc = await pro.upload('mixed-pro.txt', 'text/plain', Buffer.from('合成927')), photo = await pro.upload('image.png', 'image/png', PNG);
  const rejected = await pro.start([doc, photo]); assert.equal(rejected.turns.at(-1).status, 'error'); assert.equal(pro.calls.length, 0); assert.deepEqual(pro.forwarded, []);
});

test('malformed or scanned attachments fail before any model call instead of dropping the unreadable file', async t => {
  const f = fixture(t), valid = await f.upload('good.txt', 'text/plain', Buffer.from('合成927')), bad = await f.upload('scan.pdf', 'application/pdf', textPdf(['']));
  const thread = await f.start([valid, bad]); assert.equal(thread.turns.at(-1).status, 'error'); assert.equal(f.calls.length, 0); assert.deepEqual(f.forwarded, []);
});

test('known document references missing after restart cannot fall back to a remote Notion image resolver', async t => {
  const f = fixture(t), file = await f.upload('lost.txt', 'text/plain', Buffer.from('合成927')); await f.start([file]);
  fs.rmSync(path.join(f.root, 'document-attachments', file.id + '.json')); fs.rmSync(path.join(f.root, 'document-attachments', file.id + '.bin')); f.restore();
  await f.call('sendEventToAgentThread', { threadId: THREAD, event: { type: 'user.message', content: [{ type: 'text', text: '继续读取刚才的文档' }] } }); await f.settle();
  assert.equal(f.calls.length, 1); assert.equal(f.native.agent.find({ threadId: THREAD }).turns.at(-1).status, 'error'); assert.deepEqual(f.forwarded, []);
});
