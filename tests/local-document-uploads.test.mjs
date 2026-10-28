import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { LocalDocumentUploads } = require('../src/local-document-uploads.cjs');
const { uuid } = require('../src/native-context.cjs');
const id = n => 'be00aa00-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0'), USER = id(1), SPACE = id(2), THREAD = id(3), SECOND = id(4);
const data = Buffer.from('本次合成文件青色927 😀'), origin = 'https://app.notion.com';
function fixture(t) {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-local-documents-中文 空格-'));
  const record = (value, scope) => [THREAD, SECOND].includes(uuid(value)) && (!scope || uuid(scope.userId) === USER && uuid(scope.spaceId) === SPACE) ? { id: uuid(value), created_by_id: USER, space_id: SPACE } : undefined;
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, record, store: new LocalDocumentUploads({ root, record }) };
}
async function upload(store, target = { type: 'user' }) {
  const input = { spaceId: SPACE, target, filename: '合成 文档.txt', mediaType: 'text/plain', sizeBytes: data.length };
  const result = store.create(input, USER, origin), token = new URL(result.upload.url).pathname.split('/').at(-1);
  assert.equal((await store.put(token, new Request(result.upload.url, { method: 'PUT', body: data }))).status, 200);
  const completion = { spaceId: SPACE, target, fileId: result.file.id }, file = store.complete(completion, USER);
  return { input, result, token, completion, file };
}

for (const target of [{ type: 'user' }, { type: 'thread', threadId: THREAD }]) test(`local ${target.type} document uploads restore with stable UUID paths and idempotent completion`, async t => {
  const f = fixture(t), uploaded = await upload(f.store, target);
  assert.equal(f.store.complete(uploaded.completion, USER).sha256, uploaded.file.sha256);
  const restored = new LocalDocumentUploads({ root: f.root, record: f.record });
  assert.deepEqual(restored.complete(uploaded.completion, USER), uploaded.file);
  const scope = { fileId: uploaded.file.id.replaceAll('-', '').toUpperCase(), spaceId: SPACE, threadId: THREAD, userId: USER };
  assert.deepEqual(restored.read(scope).bytes, data); assert.equal(restored.hasFile(scope.fileId), true);
  const resolved = restored.resolve({ ...scope, includeFileMetadata: true }, USER, origin);
  assert.equal(resolved.file.filename, '合成 文档.txt'); assert.ok(!JSON.stringify(resolved).includes(f.root));
  const preview = restored.preview(new Request(resolved.url)); assert.equal(preview.status, 200); assert.deepEqual(Buffer.from(await preview.arrayBuffer()), data);
  assert.match(preview.headers.get('content-disposition'), /attachment; filename\*=UTF-8/);
  assert.equal(restored.preview(new Request(resolved.url, { method: 'HEAD' })).headers.get('content-length'), String(data.length));
  assert.equal(restored.preview(new Request(resolved.url, { headers: { 'x-notion-active-user-header': id(99) } })).status, 404);
  assert.equal((await restored.put(uploaded.token, new Request(uploaded.result.upload.url, { method: 'PUT', body: data }))).status, 404);
});

test('document reads, completion and downloads enforce the current account, workspace and thread binding', async t => {
  const f = fixture(t), { file, completion } = await upload(f.store, { type: 'thread', threadId: THREAD });
  const scope = { fileId: file.id, spaceId: SPACE, threadId: THREAD, userId: USER };
  for (const edit of [{ userId: id(99) }, { spaceId: id(99) }, { threadId: SECOND }]) assert.throws(() => f.store.read({ ...scope, ...edit }), /不属于/);
  assert.throws(() => f.store.complete(completion, id(99)), /不属于/);
  const descriptor = f.store.resolve({ ...scope, includeFileMetadata: true }, USER, origin);
  assert.equal(f.store.preview(new Request(descriptor.url, { headers: { origin: 'https://evil.example' } })).status, 404);
  assert.equal(f.store.preview(new Request(descriptor.url, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 404);
  assert.throws(() => f.store.create({ spaceId: SPACE, target: { type: 'thread', threadId: THREAD }, filename: 'a.txt', mediaType: 'text/plain', sizeBytes: 2 }, id(99), origin), /不属于/);
});

test('invalid paths, types, quotas and incomplete payloads never produce a readable document', async t => {
  const f = fixture(t), input = { spaceId: SPACE, target: { type: 'user' }, filename: 'a.txt', mediaType: 'text/plain', sizeBytes: data.length };
  for (const edit of [{ filename: '../a.txt' }, { filename: 'C:\\a.txt' }, { filename: 'a.txt\n' }, { mediaType: 'application/pdf' }, { filename: 'a.exe' }, { sizeBytes: 0 }, { sizeBytes: 16 * 1024 * 1024 + 1 }]) assert.throws(() => f.store.create({ ...input, ...edit }, USER, origin));
  const result = f.store.create(input, USER, origin), token = new URL(result.upload.url).pathname.split('/').at(-1);
  assert.equal((await f.store.put(token, new Request(result.upload.url, { method: 'PUT', body: data.subarray(0, 2) }))).status, 400);
  assert.throws(() => f.store.complete({ ...input, fileId: result.file.id }, USER), /尚未完成/); assert.equal(f.store.hasFile(result.file.id), false);
  assert.equal((await f.store.put(token, new Request(result.upload.url, { method: 'PUT', body: Buffer.concat([data, Buffer.from('too much')]) }))).status, 413);
  assert.equal((await f.store.put(token, new Request(result.upload.url, { method: 'PUT', headers: { origin: 'https://evil.example' }, body: data }))).status, 404);
  const large = new LocalDocumentUploads({ root: f.root, record: f.record });
  for (let i = 0; i < 2; i++) large.create({ ...input, sizeBytes: 16 * 1024 * 1024 }, USER, origin);
  assert.throws(() => large.create(input, USER, origin), /过多/);
});

test('concurrent PUT cannot consume the same token and cancellation leaves no partial successful upload', async t => {
  const f = fixture(t), input = { spaceId: SPACE, target: { type: 'user' }, filename: 'a.txt', mediaType: 'text/plain', sizeBytes: data.length };
  const result = f.store.create(input, USER, origin), token = new URL(result.upload.url).pathname.split('/').at(-1), controller = new AbortController();
  const pending = f.store.put(token, new Request(result.upload.url, { method: 'PUT', body: new ReadableStream({ start() {} }), duplex: 'half', signal: controller.signal }));
  assert.equal((await f.store.put(token, new Request(result.upload.url, { method: 'PUT', body: data }))).status, 404);
  controller.abort(); assert.equal((await pending).status, 408); assert.equal(f.store.hasFile(result.file.id), false);
  assert.equal((await f.store.put(token, new Request(result.upload.url, { method: 'PUT', body: data }))).status, 200);
  assert.equal(f.store.complete({ ...input, fileId: result.file.id }, USER).size_bytes, data.length);
});

test('tampered or missing local data fails integrity checks and never becomes an unknown remote file', async t => {
  const f = fixture(t), { file } = await upload(f.store), scope = { fileId: file.id, spaceId: SPACE, threadId: THREAD, userId: USER };
  const binary = path.join(f.store.directory, file.id + '.bin'), metadata = path.join(f.store.directory, file.id + '.json');
  fs.writeFileSync(binary, Buffer.alloc(data.length)); assert.throws(() => f.store.read(scope), /校验/);
  fs.rmSync(metadata); assert.equal(f.store.hasFile(file.id), true); assert.throws(() => f.store.read(scope), /元数据丢失/);
});
