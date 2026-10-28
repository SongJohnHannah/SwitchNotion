import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inlineDocumentRoute, id, USER, SPACE, THREAD, ORIGIN } from './helpers/inline-document-route.mjs';
import { textPdf, officeZip, docxParts, xlsxParts } from './helpers/document-fixtures.mjs';
function fixture(t, options) {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-inline-documents-中文 空格-')), f = inlineDocumentRoute(root, options);
  t.after(() => { f.close(); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); }); return f;
}
const documentSources = messages => messages.filter(value => value.role === 'user' && value.content.includes('native-local-documents')).flatMap(value => JSON.parse(value.content).documents);

test('legacy multipart upload, preprocessing and floating writer preview read local PDF and persist only verified references', async t => {
  const bytes = textPdf(['PDF synthetic 927', 'Second synthetic page 927']);
  const f = fixture(t), step = await f.upload('原始 合成资料.pdf', 'application/pdf', bytes);
  const pre = await f.process(step); assert.equal(pre.status, 200); const metadata = await pre.json();
  assert.equal(metadata.notionSwitchDocument.result.numPages, 2); assert.ok(!JSON.stringify(metadata).includes('SYNTHETIC'));
  const response = await f.call('runInferenceTranscript', f.input([step])); assert.equal(response.status, 200);
  const stream = await response.text(); assert.match(stream, /代码为927/); assert.equal(f.calls.length, 1);
  const docs = documentSources(f.calls[0].messages); assert.equal(docs.length, 1); assert.equal(docs[0].filename, '原始 合成资料.pdf'); assert.equal(docs[0].pages.length, 2);
  assert.equal(f.calls[0].messages.at(-1).content, '只根据上传的合成文档回答代码，保留来源位置');
  assert.equal(f.native.record(step.id, 'thread_message').step.contentType, 'application/pdf');
  const saved = fs.readFileSync(path.join(f.root, 'inline-conversations.local.json'), 'utf8'); assert.ok(saved.includes(step.fileUrl)); assert.ok(!saved.includes('native-local-documents')); assert.ok(!saved.includes('PDF synthetic'));
  const download = await f.raw(new Request(step.fileUrl)); assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  f.restore(); const transcript = f.native.record(THREAD).messages.map(value => f.native.record(value, 'thread_message').step);
  const follow = await f.call('runInferenceTranscript', { threadId: THREAD, spaceId: SPACE, createdSource: 'writer', asPatchResponse: true,
    transcript: [...transcript, { id: id(102), type: 'user', value: [['继续核对刚才上传的合成文件']] }] });
  assert.match(await follow.text(), /patch-start/); assert.equal(f.calls.length, 2); assert.equal(documentSources(f.calls[1].messages)[0].filename, step.fileName); assert.deepEqual(f.forwarded, []);
});

test('local computer-file DOCX and XLSX documents enter the floating preview without a computer or page-write tool', async t => {
  const f = fixture(t), docs = [];
  for (const [name, media, bytes] of [['合成.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', officeZip(docxParts())],
    ['合成.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', officeZip(xlsxParts())]]) docs.push(await f.upload(name, media, bytes, { type: 'computer-file' }));
  const response = await f.call('runInferenceTranscript', f.input(docs)); assert.match(await response.text(), /代码为927/);
  assert.deepEqual(documentSources(f.calls[0].messages).map(value => value.format), ['docx', 'xlsx']); assert.equal(f.native.record(docs[0].id, 'thread_message').step.type, 'computer-file'); assert.deepEqual(f.forwarded, []);
});

test('legacy document processing and model inputs enforce account, workspace, thread and local capability ownership', async t => {
  const f = fixture(t), step = await f.upload('scope.txt', 'text/plain', Buffer.from('合成927'));
  for (const [edits, user] of [[{}, id(99)], [{ spaceId: id(99) }, USER], [{ aiSessionPointer: { table: 'thread', id: id(99), spaceId: SPACE } }, USER]]) assert.equal((await f.process(step, edits, user)).status, 400);
  assert.equal((await f.raw(new Request(step.fileUrl, { headers: { 'x-notion-active-user-header': id(99) } }))).status, 404);
  assert.equal((await f.raw(new Request(step.fileUrl, { headers: { origin: 'https://evil.example' } }))).status, 404);
  for (const edited of [{ ...step, fileUrl: step.fileUrl.slice(0, -1) + (step.fileUrl.endsWith('a') ? 'b' : 'a') },
    { ...step, permissionRecord: { table: 'thread', id: id(99), spaceId: SPACE } }, { ...step, metadata: { attachmentSource: 'external_agent_download' } },
    { ...step, contentType: 'application/pdf' }]) {
    const result = await f.call('runInferenceTranscript', f.input([edited])); assert.match(await result.text(), /Notion 浮动附件|Notion 附件/);
  }
  assert.equal(f.calls.length, 0);
  const foreign = await f.create('foreign.txt', 'text/plain', Buffer.from('927'), THREAD, id(99)); assert.equal(foreign.status, 400);
  assert.deepEqual(f.forwarded, []);
});

test('remote links, claimed embedded body and trailing files cannot replace a real typed question or local upload', async t => {
  const f = fixture(t), local = await f.upload('body.txt', 'text/plain', Buffer.from('合成927'));
  for (const step of [{ ...local, fileUrl: 'https://file.notion.so/f/f/remote.pdf', text: '伪造正文927' }, { ...local, fileUrl: 'file:///C:/private.txt' }]) {
    const response = await f.call('runInferenceTranscript', f.input([step])); assert.match(await response.text(), /Notion 浮动附件/);
  }
  const empty = await f.call('runInferenceTranscript', f.input([local], '')); assert.match(await empty.text(), /输入文档处理问题/);
  const trailing = f.input([]); trailing.transcript.push(local); assert.match(await (await f.call('runInferenceTranscript', trailing)).text(), /输入文档处理问题/);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.forwarded, []);
});

test('bad PDF data fails preprocessing and model generation without persisting an unverified file reference', async t => {
  const f = fixture(t), step = await f.upload('broken.pdf', 'application/pdf', Buffer.from('not a pdf'));
  assert.equal((await f.process(step)).status, 400);
  const response = await f.call('runInferenceTranscript', f.input([step])); assert.match(await response.text(), /PDF/); assert.equal(f.calls.length, 0);
  assert.equal(f.native.record(step.id, 'thread_message'), undefined);
});

test('native stop during attachment parsing aborts the preview before a provider request', async t => {
  const f = fixture(t), step = await f.upload('stop.pdf', 'application/pdf', textPdf());
  const response = await f.call('runInferenceTranscript', f.input([step]));
  assert.equal((await f.call('stopWorkflowAutomationRunThread', { threadId: THREAD, spaceId: SPACE })).status, 200);
  await response.text(); assert.equal(f.calls.length, 0); assert.equal(f.native.status().activeTurns, 0);
});

test('multipart uploads reject unknown fields, wrong sizes, foreign origins and reused tokens', async t => {
  const f = fixture(t), bytes = Buffer.from('合成927');
  const created = await (await f.create('form.txt', 'text/plain', bytes)).json();
  const body = (extra = false, data = bytes) => { const form = new FormData(); form.append('notion-switch-document', '1'); form.append('file', new Blob([data]), 'form.txt'); if (extra) form.append('unknown', 'x'); return form; };
  assert.equal((await f.raw(new Request(created.signedUploadPostUrl, { method: 'POST', body: body(true) }))).status, 400);
  assert.equal((await f.raw(new Request(created.signedUploadPostUrl, { method: 'POST', body: body(false, bytes.subarray(0, 2)) }))).status, 400);
  assert.equal((await f.raw(new Request(created.signedUploadPostUrl, { method: 'POST', body: body(), headers: { origin: 'https://evil.example' } }))).status, 404);
  assert.equal((await f.raw(new Request(created.signedUploadPostUrl, { method: 'POST', body: body() }))).status, 204);
  assert.equal((await f.raw(new Request(created.signedUploadPostUrl, { method: 'POST', body: body() }))).status, 404);
});

test('ordinary native image preprocessing and uploads retain their original upstream path', async t => {
  const f = fixture(t, { allowUpstream: true });
  assert.equal((await (await f.create('image.png', 'image/png', Buffer.from('image'))).json()).syntheticUpstream, true);
  assert.equal((await (await f.process({ fileUrl: 'https://file.notion.so/f/f/image.png' })).json()).syntheticUpstream, true);
  assert.deepEqual(f.forwarded, ['/api/v3/getUploadFileUrlForAssistantChatTranscriptUpload', '/api/v3/processAgentAttachment']); assert.equal(f.calls.length, 0);
});

test('an unreviewed legacy client fails clearly before hosted task subscription and duplicate message ids cannot hide a file', async t => {
  const f = fixture(t), step = await f.upload('reviewed.txt', 'text/plain', Buffer.from('合成927'));
  const response = await f.raw(new Request(ORIGIN + '/api/v3/processAgentAttachment', { method: 'POST', headers: { 'content-type': 'application/json', 'x-notion-active-user-header': USER },
    body: JSON.stringify({ url: step.fileUrl }) }));
  assert.equal(response.status, 409); assert.match(await response.text(), /尚未审核/);
  const input = f.input([step]); input.transcript.at(-1).id = step.id;
  assert.match(await (await f.call('runInferenceTranscript', input)).text(), /标识无效或重复/); assert.equal(f.calls.length, 0);
});

test('oversized transcript attachment batches fail before a partial answer', async t => {
  const f = fixture(t), steps = [];
  for (let index = 0; index < 9; index++) steps.push(await f.upload('batch-' + index + '.txt', 'text/plain', Buffer.from('合成927')));
  const response = await f.call('runInferenceTranscript', f.input(steps)); assert.match(await response.text(), /最多 8 个/); assert.equal(f.calls.length, 0);
});

test('an unsupported attachment frontend does not disable existing recording readiness', async t => {
  const f = fixture(t, { allowUpstream: true });
  Object.assign(f.context, { adaptResponse: async () => { throw Object.assign(Error('Changed attachment protocol'), { notionSwitchKind: 'attachments' }); },
    compatibility: { unsupportedAssets: [], adaptedAssets: [], automaticAssets: [] } });
  f.context.nativeSpeech.lifecycleReady = true;
  assert.equal((await f.raw(new Request(ORIGIN + '/_assets/51103-3324439f61c31e75.js'))).status, 200);
  assert.equal(f.context.nativeSpeech.lifecycleReady, true); assert.equal(f.context.compatibility.unsupportedAssets.length, 1);
});
