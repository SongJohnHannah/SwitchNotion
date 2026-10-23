import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
const { createNativeImageAdapter, inspectNativeContent, describeUploadResponse, VISION_LIMITS, NATIVE_ATTACHMENT_EVIDENCE } = createRequire(import.meta.url)('../src/native-images.cjs');
const SPACE = '11111111-1111-4111-8111-111111111111', THREAD = '22222222-2222-4222-8222-222222222222';
const URL_IMAGE = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/11111111/22222222/image.png?X-Amz-Credential=synthetic-signed-value';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/BkAAAAASUVORK5CYII=', 'base64');
const native = (files = ['fixture-image']) => [{ type: 'text', text: [['描述截图', [['a', 'https://example.com/format-link']]]] }, ...files.map(file_id => ({ type: 'file', file_id }))];
const args = content => ({ content: content || native(), model: 'deepseek-flash', spaceId: SPACE, threadId: THREAD, signal: new AbortController().signal });
function fixture({ resolve, fetch, limits } = {}) {
  const resolutions = [], downloads = [];
  const adapter = createNativeImageAdapter({ limits,
    resolveFile: async input => { resolutions.push(input); return resolve ? resolve(input) : { url: URL_IMAGE, cookie: 'synthetic-cookie', apiKey: 'synthetic-notion-key' }; },
    fetchImage: async (url, options) => { downloads.push({ url, options }); return fetch ? fetch(url, options) : new Response(PNG, { headers: { 'content-type': 'application/octet-stream' } }); }
  });
  return { adapter, resolutions, downloads };
}

test('native client evidence describes opaque file references and the dedicated native resolver', () => {
  assert.deepEqual(NATIVE_ATTACHMENT_EVIDENCE.attachmentShape, { type: 'file', file_id: '<opaque file ID>' });
  assert.equal(NATIVE_ATTACHMENT_EVIDENCE.resolverEndpoint, 'getFileContentURLForAgentThread');
  assert.equal(NATIVE_ATTACHMENT_EVIDENCE.maximumNativeContentBlocks, 20);
  assert.equal(NATIVE_ATTACHMENT_EVIDENCE.sha256.length, 64);
  assert.ok(VISION_LIMITS.maxTotalBytes * 4 / 3 < 48 * 1024 * 1024);
});

test('text-only messages preserve visible rich text and perform no attachment lookup', async () => {
  const f = fixture(), content = native().slice(0, 1);
  const result = await f.adapter.prepare(args(content));
  assert.equal(result.content, '描述截图'); assert.equal(result.hasImages, false);
  assert.equal(f.resolutions.length, 0); assert.equal(f.downloads.length, 0);
  assert.equal(inspectNativeContent(content).text.includes('format-link'), false);
});

test('Flash receives only inline image bytes, never native credentials or signed storage URLs', async () => {
  const f = fixture(), result = await f.adapter.prepare(args());
  assert.equal(result.hasImages, true); assert.equal(result.content[0].text, '描述截图');
  assert.equal(result.content[1].type, 'image_url');
  assert.equal(result.content[1].image_url.url, 'data:image/png;base64,' + PNG.toString('base64'));
  assert.deepEqual(Object.keys(f.resolutions[0]).sort(), ['fileId', 'includeFileMetadata', 'signal', 'spaceId', 'threadId']);
  assert.equal(f.resolutions[0].spaceId, SPACE); assert.equal(f.resolutions[0].threadId, THREAD);
  assert.equal(f.downloads[0].options.redirect, 'manual'); assert.equal(f.downloads[0].options.credentials, 'omit');
  assert.deepEqual(Object.keys(f.downloads[0].options.headers), ['accept']);
  assert.equal(f.downloads[0].options.referrerPolicy, 'no-referrer');
  for (const forbidden of ['synthetic-signed-value', 'synthetic-cookie', 'synthetic-notion-key', 'prod-files-secure']) assert.equal(JSON.stringify(result).includes(forbidden), false);
  assert.deepEqual({ mimeType: result.images[0].mimeType, width: result.images[0].width, height: result.images[0].height, bytes: result.images[0].bytes }, { mimeType: 'image/png', width: 1, height: 1, bytes: PNG.length });
});

test('native file redirect is verified one hop at a time and drops session credentials for storage', async () => {
  const f = fixture({ resolve: () => ({ url: 'https://file.notion.so/f/f/synthetic/image' }), fetch: url => url.startsWith('https://file.notion.so/') ? new Response(null, { status: 302, headers: { location: URL_IMAGE } }) : new Response(PNG) });
  const result = await f.adapter.prepare(args());
  assert.equal(result.hasImages, true); assert.equal(f.downloads.length, 2);
  assert.deepEqual(f.downloads.map(call => call.options.credentials), ['include', 'omit']);
  assert.ok(f.downloads.every(call => call.options.redirect === 'manual'));
});

test('redirects to arbitrary hosts are rejected before another download request', async () => {
  const f = fixture({ fetch: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/collect' } }) });
  await assert.rejects(f.adapter.prepare(args()), /已验证的 Notion 附件存储地址/);
  assert.equal(f.downloads.length, 1);
});

test('arbitrary websites, local files, cloud metadata, lookalike domains and generic S3 buckets are never fetched', async () => {
  const rejected = ['file:///C:/secret.txt', 'http://file.notion.so/f/f/x', 'https://127.0.0.1/image', 'https://169.254.169.254/latest/meta-data/', 'https://file.notion.so.evil.example/f/f/x', 'https://prod-files-secure.s3.us-west-2.amazonaws.com.evil.example/image', 'https://s3.us-west-2.amazonaws.com/attacker-bucket/image', 'https://user:password@file.notion.so/f/f/x', 'https://file.notion.so/api/v3/export', 'https://app.notion.com/image/arbitrary', 'https://example.com/image.png'];
  for (const url of rejected) {
    const f = fixture({ resolve: () => ({ url }) });
    await assert.rejects(f.adapter.prepare(args()), /^Error: DeepSeek /);
    assert.equal(f.downloads.length, 0);
  }
});

test('Pro, unknown attachment types, paths, invalid context and excess image count fail before lookup', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.prepare({ ...args(), model: 'deepseek-v4-pro' }), /需要选择 DeepSeek Flash/);
  await assert.rejects(f.adapter.prepare(args([{ type: 'image_url', image_url: { url: 'https://example.com/image' } }])), /附件格式/);
  await assert.rejects(f.adapter.prepare(args([{ type: 'file', file_id: 'C:\\secret.png' }])), /附件 ID 无效/);
  await assert.rejects(f.adapter.prepare({ ...args(), spaceId: 'missing' }), /缺少有效/);
  await assert.rejects(f.adapter.prepare(args(native(Array.from({ length: 9 }, (_, i) => 'file-' + i)))), /最多识别 8 张/);
  assert.equal(f.resolutions.length, 0); assert.equal(f.downloads.length, 0);
});

test('unsupported bytes cannot masquerade as images through names or MIME headers', async () => {
  const f = fixture({ resolve: () => ({ url: URL_IMAGE, mediaType: 'image/png', filename: 'looks-like-image.png' }), fetch: () => new Response('%PDF-1.7 synthetic non-image', { headers: { 'content-type': 'image/png' } }) });
  await assert.rejects(f.adapter.prepare(args()), /不是可识别的 PNG/);
});

test('declared, streamed and aggregate byte budgets are enforced before returning any provider content', async () => {
  const declared = fixture({ limits: { maxImageBytes: 10 }, fetch: () => new Response(PNG, { headers: { 'content-length': String(PNG.length) } }) });
  await assert.rejects(declared.adapter.prepare(args()), /图片文件过大/);
  const streamed = fixture({ limits: { maxImageBytes: 10 }, fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(PNG.subarray(0, 6)); c.enqueue(PNG.subarray(6)); c.close(); } })) });
  await assert.rejects(streamed.adapter.prepare(args()), /图片文件过大/);
  const aggregate = fixture({ limits: { maxTotalBytes: PNG.length * 2 - 1 } });
  await assert.rejects(aggregate.adapter.prepare(args(native(['one', 'two']))), /图片文件过大/);
  assert.equal(aggregate.downloads.length, 2);
});

test('oversized image dimensions are read from file headers instead of attachment metadata', async () => {
  const tooWide = Buffer.from(PNG); tooWide.writeUInt32BE(9000, 16);
  const f = fixture({ fetch: () => new Response(tooWide) });
  await assert.rejects(f.adapter.prepare(args()), /尺寸超过 8192/);
});

test('GIF, JPEG and WebP signatures and dimensions produce their corresponding data URL MIME', async () => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 217]);
  const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.writeUInt32LE(22, 4); webp.write('WEBP', 8); webp.write('VP8X', 12); webp.writeUInt32LE(10, 16);
  for (const [bytes, mimeType] of [[gif, 'image/gif'], [jpeg, 'image/jpeg'], [webp, 'image/webp']]) {
    const f = fixture({ fetch: () => new Response(bytes) }), result = await f.adapter.prepare(args());
    assert.equal(result.images[0].mimeType, mimeType); assert.equal(result.images[0].width, 1); assert.equal(result.images[0].height, 1);
    assert.equal(result.content[1].image_url.url.startsWith(`data:${mimeType};base64,`), true);
  }
});

test('native stop aborts the scoped native resolver without starting image download', async () => {
  const stop = new AbortController(); let nativeSignal;
  const f = fixture({ resolve: ({ signal }) => new Promise((_resolve, reject) => { nativeSignal = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  const pending = f.adapter.prepare({ ...args(), signal: stop.signal });
  for (let i = 0; i < 50 && !nativeSignal; i++) await sleep(1);
  assert.ok(nativeSignal); stop.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(nativeSignal.aborted, true); assert.equal(f.downloads.length, 0);
});

test('native stop cancels an in-flight image body read', async () => {
  const stop = new AbortController(); let cancelled = false, started = false;
  const f = fixture({ fetch: () => new Response(new ReadableStream({ start(c) { started = true; c.enqueue(PNG.subarray(0, 10)); }, cancel() { cancelled = true; } })) });
  const pending = f.adapter.prepare({ ...args(), signal: stop.signal });
  for (let i = 0; i < 50 && !started; i++) await sleep(1);
  assert.equal(started, true); stop.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cancelled, true);
});

test('native transport errors and broken auto-follow responses never echo URLs or credentials', async () => {
  const failed = fixture({ resolve: () => { throw Error('DeepSeek synthetic-cookie synthetic-notion-key ' + URL_IMAGE); } });
  await assert.rejects(failed.adapter.prepare(args()), error => error.message === 'DeepSeek 无法读取这张原生图片附件，请重新上传后再试。');
  const followed = fixture({ fetch: () => ({ status: 200, ok: true, redirected: true, url: 'https://evil.example/image', headers: new Headers(), body: null }) });
  await assert.rejects(followed.adapter.prepare(args()), /重定向方式异常/);
});

test('upload protocol observation returns only bounded key shapes, safe HTTP methods and presence flags', () => {
  const input = { spaceId: SPACE, target: { threadId: THREAD }, filename: 'synthetic-private-name.png', mediaType: 'image/png', sizeBytes: 999 };
  const response = { fileId: 'synthetic-private-file-id', type: 'POST', signedUploadPostUrl: URL_IMAGE, fields: { token: 'synthetic-private-token' }, file: { url: URL_IMAGE, filename: 'synthetic-private-name.png' } };
  const metadata = describeUploadResponse('createAgentServiceFileUploadURL', input, response), serialized = JSON.stringify(metadata);
  assert.equal(metadata.endpoint, 'createAgentServiceFileUploadURL');
  assert.equal(metadata.hasFileId, true); assert.deepEqual(metadata.methods, ['POST']);
  assert.equal(metadata.response.fields.some(field => field.key === 'signedUploadPostUrl'), true);
  for (const forbidden of [SPACE, THREAD, 'synthetic-private-name.png', 'synthetic-private-file-id', 'synthetic-private-token', 'synthetic-signed-value', 'image/png', '999']) assert.equal(serialized.includes(forbidden), false);
  assert.deepEqual(describeUploadResponse('https://example.com/private-token', input, response), { endpoint: 'unsupported' });
});

test('upload schema observer handles adversarial keys, cyclic and oversized data without revealing values', () => {
  const data = { method: 'PUT', file_id: 'hidden-id', ['ntn_' + 'synthetic_secret_key']: 'also-hidden', ['https://example.com/signed-secret']: 'hidden-url' };
  data.circular = data;
  data.deep = { one: { two: { three: { fileId: 'deep-hidden-id', url: URL_IMAGE } } } };
  const result = describeUploadResponse('completeAgentServiceFileUpload', {}, data), serialized = JSON.stringify(result);
  assert.deepEqual(result.methods, ['PUT']); assert.equal(result.hasFileId, true);
  for (const forbidden of ['ntn_' + 'synthetic_secret_key', 'signed-secret', 'hidden-id', 'hidden-url', 'also-hidden', 'synthetic-signed-value']) assert.equal(serialized.includes(forbidden), false);
  assert.equal(serialized.includes('<redacted-key>'), true); assert.equal(serialized.includes('circular'), true);
});
