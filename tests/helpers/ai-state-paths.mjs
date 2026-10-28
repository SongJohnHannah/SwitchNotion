// Spawned from an unrelated cwd. Exercise the real AI modules with an explicit
// Application Support profile; this is a path contract test, not a Mac OS run.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { inlineDocumentRoute, id, SPACE, USER } from './inline-document-route.mjs';
import { officeZip, docxParts, xlsxParts, chineseCmapPdf } from './document-fixtures.mjs';
const require = createRequire(import.meta.url), { LocalDocumentUploads } = require('../../src/local-document-uploads.cjs');
const root = path.resolve(process.argv[2]);
assert.ok(path.isAbsolute(root)); assert.ok(root.includes('用户 甲'));
let calls = 0;
const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek', model: 'deepseek-v4-pro', multiAgent: false }), async* generate({ messages }) {
  calls++;
  const sources = messages.filter(value => value.role === 'user' && typeof value.content === 'string' && value.content.includes('native-local-documents')).flatMap(value => JSON.parse(value.content).documents);
  assert.equal(sources.length, calls <= 2 ? 3 : 1);
  assert.ok(!JSON.stringify(messages).includes(root), 'Local profile paths must not reach model input');
  if (calls <= 2) { assert.deepEqual(sources.map(value => value.format), ['pdf', 'docx', 'xlsx']); assert.match(JSON.stringify(sources[0]), /中文/); }
  else assert.match(JSON.stringify(sources), /独立工作目录927/);
  yield '路径核对完成927';
} };
const f = inlineDocumentRoute(root, { provider });
try {
  const steps = [];
  for (const [name, mime, bytes] of [
    ['中文 字体.pdf', 'application/pdf', chineseCmapPdf()],
    ['段落 表格.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', officeZip(docxParts())],
    ['隐藏 工作表.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', officeZip(xlsxParts())]
  ]) steps.push(await f.upload(name, mime, bytes, { type: name.endsWith('.pdf') ? 'attachment' : 'computer-file' }));
  assert.match(await (await f.call('runInferenceTranscript', f.input(steps))).text(), /路径核对完成927/);
  f.restore(); const transcript = f.native.record(id(3)).messages.map(value => f.native.record(value, 'thread_message').step);
  assert.match(await (await f.call('runInferenceTranscript', { threadId: id(3), spaceId: SPACE, createdSource: 'writer', transcript: [
    ...transcript, { id: id(450), type: 'user', value: [['继续核对三份合成文档']] }
  ] })).text(), /路径核对完成927/);
  const bytes = Buffer.from('独立工作目录927'), target = { type: 'user' };
  const upload = await (await f.call('createAgentServiceFileUploadURL', { spaceId: SPACE, target, filename: '侧栏 中文.txt', mediaType: 'text/plain', sizeBytes: bytes.length })).json();
  assert.equal((await f.raw(new Request(upload.upload.url, { method: 'PUT', body: bytes }))).status, 200);
  const file = await (await f.call('completeAgentServiceFileUpload', { spaceId: SPACE, target, fileId: upload.file.id })).json();
  assert.equal((await f.call('createAgentThread', { threadId: id(451), spaceId: SPACE, content: [{ type: 'text', text: '根据上传的合成文档回答代码' }, { type: 'file', file_id: file.id }] })).status, 200);
  for (let i = 0; f.native.status().activeTurns && i < 1500; i++) await sleep(5);
  assert.equal(f.native.status().activeTurns, 0); assert.equal(f.native.agent.status().failed, 0); assert.equal(calls, 3);
  const other = path.join(path.dirname(path.dirname(path.dirname(path.dirname(root)))), '用户 乙', 'Library', 'Application Support', 'Switch Notion');
  const isolated = new LocalDocumentUploads({ root: other, record: () => ({ created_by_id: USER, space_id: SPACE }) });
  assert.equal(isolated.hasFile(file.id), false); assert.equal(isolated.read({ fileId: file.id, threadId: id(451), userId: USER, spaceId: SPACE }), null);
  assert.deepEqual(fs.readdirSync(process.cwd()), []);
  for (const name of ['inline-document-refs.local.json', 'inline-conversations.local.json', 'conversations.json', 'document-attachments']) assert.ok(fs.existsSync(path.join(root, name)), name);
  console.log(JSON.stringify({ status: 'passed', modelFixtureCalls: calls, differentCwd: true, explicitProfileLayout: root.includes('Application Support') ? 'app-support' : 'project-mac-arm64',
    bundledPdfCmapLoaded: true, writerRestartFollowup: true, sidebarUpload: true, otherProfileIsolated: true, filesWrittenToCwd: 0 }));
} finally { f.close(); }
