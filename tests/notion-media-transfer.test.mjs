import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
const { createNotionMedia } = require('../src/notion-media-transfer.cjs');
const { officialMediaSend } = require('../src/notion-media-requests.cjs');
const origin = 'https://app.notion.com';
const bucket = 'https://prod-files-secure.s3.us-west-2.amazonaws.com';
const signedVideo = bucket + '/workspace/file/clip.webm?X-Amz-Signature=example%2Bpart&key=a%2Fb';
const image = 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=300';
const mockedPort = 58443;

function intercepted(url, init = {}, source = origin) {
  const request = new Request(url, init);
  Object.defineProperty(request, 'initiatorOrigin', { value: source });
  return request;
}
function setup(t, fetchDirect, extra = {}) {
  const calls = [];
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'notion-media-test-'));
  const media = createNotionMedia({ enabled: true, root, getPort: () => mockedPort, ...extra,
    dispatch: async (url, options, port) => {
      assert.equal(port, mockedPort);
      calls.push({ url, options });
      return fetchDirect(url, options);
    }
  });
  t.after(() => {
    media.close();
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { media, calls, root };
}

test('the same desktop handler leaves pages, scripts, sync, and non-media files on the normal session', async t => {
  const { media, calls } = setup(t, () => assert.fail('unexpected direct transfer'));
  const requests = [
    intercepted(origin + '/', { headers: { 'sec-fetch-dest': 'document' } }),
    intercepted(origin + '/_assets/AgentServiceWriterPopup-fixture.js', { headers: { 'sec-fetch-dest': 'script' } }),
    intercepted(origin + '/api/v3/syncPageRecordSinceTimestamp', { method: 'POST', body: '{}' }),
    intercepted('https://api.notion.com/v1/users/me'),
    intercepted('https://api.unsplash.com/search/photos?query=test'),
    intercepted(bucket + '/workspace/file/recording.mp3', { headers: { 'sec-fetch-dest': 'audio' } }),
    intercepted(bucket + '/workspace/file/document.pdf'),
    intercepted('https://file.notion.com.attacker.example/f/f/video.webm', { headers: { 'sec-fetch-dest': 'video' } }),
    intercepted(signedVideo, { headers: { 'sec-fetch-dest': 'video' } }, 'https://example.com')
  ];
  for (const request of requests) {
    const result = await media.handle(request, {}, original => {
      assert.equal(original, request);
      return new Response('system');
    });
    assert.equal(await result.text(), 'system');
  }
  assert.deepEqual(calls, []);
});

test('Notion video ranges keep the signed URL and stream the original response', async t => {
  const headers = { 'content-range': 'bytes 100-102/350', 'content-type': 'video/webm' };
  const response = new Response('xyz', { status: 206, headers });
  const { media, calls } = setup(t, () => response);
  const request = intercepted(signedVideo, { headers: { range: 'bytes=100-102', 'sec-fetch-dest': 'video', cookie: 'private-session' } });
  const result = await media.handle(request, {}, () => assert.fail('range used the system route'));
  assert.equal(result.status, 206);
  assert.equal(result.headers.get('content-range'), headers['content-range']);
  assert.equal(await result.text(), 'xyz');
  assert.equal(calls[0].url, signedVideo);
  assert.equal(calls[0].options.headers.get('range'), 'bytes=100-102');
  assert.equal(calls[0].options.headers.has('cookie'), false);
});

test('a direct media request can take eight seconds to start without using the VPN', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(https, 'request', (_options, onResponse) => {
    const wire = new EventEmitter();
    let idle;
    wire.setTimeout = (ms, onTimeout) => { idle = setTimeout(onTimeout, ms); };
    wire.destroy = error => { wire.destroyed = true; wire.emit('error', error); };
    wire.end = () => setTimeout(() => {
      if (wire.destroyed) return;
      clearTimeout(idle);
      const response = Readable.from([Buffer.from('xyz')]);
      response.statusCode = 206;
      response.headers = { 'content-range': 'bytes 100-102/350', 'content-type': 'video/webm' };
      onResponse(response);
    }, 8000);
    return wire;
  });
  const media = createNotionMedia({ enabled: true, getPort: () => mockedPort });
  t.after(() => media.close());
  const request = intercepted(signedVideo, { headers: { range: 'bytes=100-102', 'sec-fetch-dest': 'video' } });
  const response = media.handle(request, {}, () => assert.fail('a slow but available Caddy connection used the VPN'));
  t.mock.timers.tick(8000);
  const result = await response;
  assert.equal(result.status, 206);
  assert.equal(await result.text(), 'xyz');
});

test('a Caddy connection with no TLS handshake returns to the VPN after fifteen seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(https, 'request', () => {
    const wire = new EventEmitter();
    wire.setTimeout = () => {};
    wire.end = () => wire.emit('socket', new EventEmitter());
    wire.destroy = error => wire.emit('error', error);
    return wire;
  });
  const media = createNotionMedia({ enabled: true, getPort: () => mockedPort });
  t.after(() => media.close());
  const request = intercepted(signedVideo, { headers: { range: 'bytes=0-9', 'sec-fetch-dest': 'video' } });
  let attempts = 0;
  const result = media.handle(request, {}, () => {
    attempts++;
    return new Response('system video', { status: 206 });
  });
  t.mock.timers.tick(14999);
  await Promise.resolve();
  assert.equal(attempts, 0);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(attempts, 1);
  assert.equal(await (await result).text(), 'system video');
});

test('the authenticated file lookup stays in the original session and the redirect transfers over Caddy', async t => {
  const request = intercepted('https://file.notion.so/f/f/workspace/file/clip.webm', { headers: {
    range: 'bytes=1-', 'sec-fetch-dest': 'video', cookie: 'private-session'
  } });
  const session = {};
  const { media, calls } = setup(t, () => new Response('range', { status: 206 }), { authorize: async (input, original) => {
    assert.equal(input, request);
    assert.equal(original, session);
    return Response.redirect(signedVideo);
  } });
  const result = await media.handle(request, session, () => assert.fail('the signed transfer used the system route'));
  assert.equal(result.status, 206);
  assert.equal(calls[0].url, signedVideo);
  assert.equal(calls[0].options.headers.get('range'), 'bytes=1-');
  assert.equal(calls[0].options.headers.has('cookie'), false);
});

test('native upload preparation stays normal and a matching signed multipart upload preserves every byte', async t => {
  const { media, calls } = setup(t, async (_url, options) => {
    assert.equal(options.headers.get('content-type'), preparedType);
    assert.equal(Number(options.headers.get('content-length')), original.length);
    assert.deepEqual(new Uint8Array(await new Response(options.body).arrayBuffer()), original);
    return new Response(null, { status: 204 });
  });
  const session = {};
  const prepare = intercepted(origin + '/api/v3/getUploadSpaceFileUrl', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentType: 'video/webm', contentLength: 200 * 1024 }) });
  const info = { data: { signedUploadPostUrl: bucket, fields: { key: 'workspace/file/clip.webm', policy: 'signed-policy' } } };
  assert.deepEqual(await (await media.handle(prepare, session, async request => {
    assert.equal((await request.json()).contentType, 'video/webm');
    return Response.json(info);
  })).json(), info);
  function form(policy) {
    const body = new FormData();
    body.set('key', info.data.fields.key);
    body.set('policy', policy);
    body.set('file', new Blob([new Uint8Array(200 * 1024).fill(5)], { type: 'video/webm' }), 'clip.webm');
    return intercepted(bucket, { method: 'POST', body });
  }
  const mismatched = form('not-the-issued-policy');
  await media.handle(mismatched, session, async request => {
    assert.equal((await request.formData()).get('policy'), 'not-the-issued-policy');
    return new Response();
  });
  assert.equal(calls.length, 0);
  const upload = form(info.data.fields.policy);
  const preparedType = upload.headers.get('content-type');
  const original = new Uint8Array(await upload.clone().arrayBuffer());
  assert.equal((await media.handle(upload, session, () => assert.fail('approved media upload used the system route'))).status, 204);
  assert.equal(calls.length, 1);
});

test('the official upload path accepts file bytes for image and video only', async t => {
  const { media, calls } = setup(t, () => new Response('uploaded'));
  const target = 'https://api.notion.com/v1/file_uploads/d107617c-71d3-4cc1-a0ea-932613cf001a/send';
  const body = new FormData(); body.set('file', new Blob(['png'], { type: 'image/png' }), 'picture.png');
  const init = { method: 'POST', body, headers: { authorization: 'Bearer fixture' } };
  assert.equal(officialMediaSend(target, init), true);
  assert.equal(await (await media.upload(target, init)).text(), 'uploaded');
  assert.equal(calls[0].options.headers.get('authorization'), 'Bearer fixture');
  assert.equal(Number(calls[0].options.headers.get('content-length')), calls[0].options.body.length);
  body.set('file', new Blob(['wav'], { type: 'audio/wav' }), 'recording.wav');
  assert.throws(() => media.upload(target, init));
  assert.throws(() => media.upload('https://api.notion.com/v1/file_uploads', init));
  assert.equal(calls.length, 1);
});

test('a native upload that consumed its stream retries the same signed object over the system route', async t => {
  const expected = 'sample-video-bytes';
  const { media, root } = setup(t, async (_url, init) => {
    assert.equal(await new Response(init.body).text(), expected);
    throw Error('direct upload interrupted');
  });
  const upload = intercepted(signedVideo, { method: 'PUT', body: expected, headers: { 'content-type': 'video/webm' } });
  const outcome = await media.handle(upload, {}, async replay => {
    assert.equal(replay.url, signedVideo);
    assert.equal(replay.method, 'PUT');
    assert.equal(Number(replay.headers.get('content-length')), expected.length);
    assert.equal(await replay.text(), expected);
    return new Response(null, { status: 204 });
  });
  assert.equal(outcome.status, 204);
  assert.deepEqual(fs.readdirSync(path.join(root, 'smart-direct')), []);
});

test('an unavailable media address immediately returns to the original route', async t => {
  const routes = [];
  const { media, calls } = setup(t, () => assert.fail('service was not ready'), { getPort: () => 0, onResult: event => routes.push(event) });
  const request = intercepted(image, { headers: { 'sec-fetch-dest': 'image' } });
  const result = await media.handle(request, {}, original => {
    assert.equal(original, request);
    return new Response('fallback image');
  });
  assert.equal(await result.text(), 'fallback image');
  assert.equal(calls.length, 0);
  assert.equal(routes[0].route, 'system');
});

test('a CDN denial falls back without retrying each subsequent range on the rejected host', async t => {
  const target = 'https://file.notion.com/f/f/workspace/file/clip.webm?signature=fixture';
  const { media, calls } = setup(t, url => url === target
    ? new Response('<html>Forbidden</html>', { status: 403, headers: { 'content-type': 'text/html' } })
    : new Response('picture', { headers: { 'content-type': 'image/jpeg' } }));
  for (const range of ['bytes=0-4095', 'bytes=4096-8191']) {
    const request = intercepted(target, { headers: { range, 'sec-fetch-dest': 'video' } });
    const outcome = await media.handle(request, {}, input => {
      assert.equal(input, request);
      return new Response('VPN segment', { status: 206 });
    });
    assert.equal(await outcome.text(), 'VPN segment');
  }
  const outcome = await media.handle(intercepted(image), {}, () => assert.fail('the image host should remain direct'));
  assert.equal(await outcome.text(), 'picture');
  assert.deepEqual(calls.map(call => call.url), [target, image]);
});

test('a truncated video continues with the exact missing range over the system route', async t => {
  let read = false, fallback = 0;
  const headers = { 'content-length': '6', 'content-range': 'bytes 4-9/100', etag: '"version"', 'content-type': 'video/webm' };
  const body = new ReadableStream({
    pull(controller) {
      if (read) controller.error(Error('short transfer'));
      else { read = true; controller.enqueue(Buffer.from('abc')); }
    }
  });
  const { media } = setup(t, () => new Response(body, { status: 206, headers }));
  const request = intercepted(signedVideo, { headers: { range: 'bytes=4-9', 'sec-fetch-dest': 'video' } });
  const response = await media.handle(request, {}, retry => {
    fallback++;
    assert.equal(retry.headers.get('range'), 'bytes=7-9');
    assert.equal(retry.headers.get('if-range'), '"version"');
    return new Response('def', { status: 206, headers: { 'content-range': 'bytes 7-9/100', etag: '"version"' } });
  });
  assert.equal(await response.text(), 'abcdef');
  assert.equal(fallback, 1);
});

test('video on the VPN fallback splits a large range and retries an interrupted segment', async t => {
  const { media } = setup(t, () => assert.fail('unavailable direct route'), { getPort: () => 0 });
  const segment = 256 * 1024, total = segment + 5;
  const initial = intercepted(signedVideo, { headers: { range: 'bytes=0-', 'sec-fetch-dest': 'video' } });
  const first = new Uint8Array(segment).fill(97);
  const rangeCalls = [];
  const result = await media.handle(initial, {}, request => {
    rangeCalls.push(request.headers.get('range'));
    const tag = '"version"';
    if (rangeCalls.length === 1) {
      const interrupted = new ReadableStream({ pull(controller) { controller.error(Error('VPN transport reset')); } });
      return new Response(interrupted, { status: 206, headers: { 'content-range': `bytes 0-${segment - 1}/${total}`, etag: tag } });
    }
    if (rangeCalls.length === 2) return new Response(first, { status: 206,
      headers: { 'content-range': `bytes 0-${segment - 1}/${total}`, etag: tag } });
    assert.equal(request.headers.get('if-range'), '"version"');
    return new Response('12345', { status: 206, headers: { 'content-range': `bytes ${segment}-${total - 1}/${total}`, etag: tag } });
  });
  assert.equal(result.headers.get('content-range'), `bytes 0-${total - 1}/${total}`);
  assert.equal(Number(result.headers.get('content-length')), total);
  assert.equal(await result.text(), 'a'.repeat(segment) + '12345');
  assert.deepEqual(rangeCalls, [`bytes=0-${segment - 1}`, `bytes=0-${segment - 1}`, `bytes=${segment}-${total - 1}`]);
});

test('a lost official upload reply is checked by ID before replaying any bytes', async t => {
  const { media } = setup(t, () => { throw Error('reply lost'); });
  const target = 'https://api.notion.com/v1/file_uploads/d107617c-71d3-4cc1-a0ea-932613cf001a/send';
  const body = new FormData();
  body.set('file', new Blob(['mp4'], { type: 'video/mp4' }), 'video.mp4');
  const result = await media.upload(target, { method: 'POST', body }, (url, init) => {
    assert.equal(url, target.slice(0, -5));
    assert.equal(init.method, 'GET');
    return Promise.resolve(Response.json({ status: 'uploaded' }));
  });
  assert.equal((await result.json()).status, 'uploaded');
});

test('an incomplete preview uses the normal route without rerouting other media hosts', async t => {
  const { media, calls } = setup(t, url => {
    if (url === image) return new Response('short', { headers: { 'content-type': 'image/jpeg', 'content-length': '20' } });
    return new Response('video', { status: 206 });
  });
  const request = intercepted(image, { headers: { 'sec-fetch-dest': 'image' } });
  const result = await media.handle(request, {}, () => new Response('complete preview'));
  assert.equal(await result.text(), 'complete preview');
  assert.equal((await media.handle(intercepted(signedVideo, { headers: { 'sec-fetch-dest': 'video' } }), {},
    () => assert.fail('another media host must remain direct'))).status, 206);
  assert.equal(calls.length, 2);
});
