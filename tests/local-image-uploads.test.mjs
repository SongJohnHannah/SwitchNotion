import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { LocalImageUploads } = require('../src/local-image-uploads.cjs');
const { createNativeImageAdapter } = require('../src/native-images.cjs');
const USER = '11111111-1111-4111-8111-111111111111', SPACE = '22222222-2222-4222-8222-222222222222', THREAD = '33333333-3333-4333-8333-333333333333';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64');
function fixture(t) {
  const root = fs.mkdtempSync(path.resolve('.notion-switch/test-local-images-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new LocalImageUploads({ root, owns: input => input.threadId === THREAD, record: id => id === THREAD ? { space_id: SPACE } : null });
}
for (const target of [{ type: 'user' }, { type: 'thread', threadId: THREAD }]) test(`local ${target.type} image upload reaches model and stays scoped to its owner`, async t => {
  const store = fixture(t), input = { spaceId: SPACE, target, filename: 'image.png', mediaType: 'image/png', sizeBytes: PNG.length };
  const created = store.create(input, USER, 'https://app.notion.com');
  const token = new URL(created.upload.url).pathname.split('/').at(-1);
  assert.equal((await store.put(token, new Request(created.upload.url, { method: 'PUT', body: PNG }))).status, 200);
  assert.equal((await store.put(token, new Request(created.upload.url, { method: 'PUT', body: PNG }))).status, 404);
  const complete = store.complete({ spaceId: SPACE, target, fileId: created.file.id }, USER);
  assert.equal(complete.filename, 'image.png'); assert.equal(complete.size_bytes, PNG.length);
  const args = { spaceId: SPACE, threadId: THREAD, fileId: complete.id, userId: USER };
  assert.deepEqual(store.read(args), PNG);
  assert.throws(() => store.read({ ...args, userId: SPACE }), /不属于/);
  const adapter = createNativeImageAdapter({ readLocalFile: () => store.read(args), resolveFile: () => assert.fail('must not call Notion for local image'), fetchImage: () => assert.fail('must not fetch local image') });
  const result = await adapter.prepare({ content: [{ type: 'text', text: '看图片' }, { type: 'file', file_id: complete.id }], model: 'deepseek-flash', spaceId: SPACE, threadId: THREAD });
  assert.match(result.content[1].image_url.url, /^data:image\/png;base64,/);
});
test('local upload rejects unowned threads, oversized or incomplete data', async t => {
  const store = fixture(t), input = { spaceId: SPACE, target: { type: 'user' }, filename: 'image.png', mediaType: 'image/png', sizeBytes: PNG.length };
  assert.equal(store.handlesTarget({ type: 'thread', threadId: USER }), false);
  assert.throws(() => store.create({ ...input, sizeBytes: 17 * 1024 * 1024 }, USER, 'https://app.notion.com'), /16 MB/);
  const created = store.create(input, USER, 'https://app.notion.com');
  const token = new URL(created.upload.url).pathname.split('/').at(-1);
  assert.equal((await store.put(token, new Request(created.upload.url, { method: 'PUT', body: PNG.subarray(1) }))).status, 400);
  assert.throws(() => store.complete({ spaceId: SPACE, target: input.target, fileId: created.file.id }, USER), /尚未上传完成/);
});

test('native chat previews resolve metadata and serve original bytes without a cloud upload', async t => {
  const store = fixture(t), target = { type: 'user' };
  const created = store.create({ spaceId: SPACE, target, filename: 'color.png', mediaType: 'image/png', sizeBytes: PNG.length }, USER, 'https://app.notion.com');
  await store.put(new URL(created.upload.url).pathname.split('/').at(-1), new Request(created.upload.url, { method: 'PUT', body: PNG }));
  const file = store.complete({ spaceId: SPACE, target, fileId: created.file.id }, USER);
  const input = { spaceId: SPACE, threadId: THREAD, fileId: file.id, includeFileMetadata: true };
  const preview = store.resolve(input, USER, 'https://app.notion.com');
  assert.deepEqual(preview.file, file);
  assert.ok(!JSON.stringify(preview).includes(USER));
  const response = store.preview(new Request(preview.url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  const thumbnail = store.preview(new Request('https://app.notion.com/image/' + encodeURIComponent(preview.url) + '?width=240'));
  assert.deepEqual(Buffer.from(await thumbnail.arrayBuffer()), PNG);
  assert.equal(store.preview(new Request(preview.url, { method: 'HEAD' })).headers.get('content-length'), String(PNG.length));
  assert.throws(() => store.resolve(input, SPACE, 'https://app.notion.com'), /不属于/);
  assert.equal(store.preview(new Request(preview.url, { headers: { origin: 'https://evil.example' } })).status, 404);
  assert.equal(store.preview(new Request(preview.url, { method: 'POST' })).status, 404);
  assert.equal(store.preview(new Request(preview.url.replace('app.notion.com', 'www.notion.so'))).status, 404);
  assert.equal(store.preview(new Request('https://app.notion.com/image/' + encodeURIComponent('https://evil.example/notion-switch-local-image/x'))), null);
  const token = new URL(preview.url).pathname.split('/').at(-1);
  store.previews.get(token).expires = 0;
  assert.equal(store.preview(new Request(preview.url)).status, 404);
});
