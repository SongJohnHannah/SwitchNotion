const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { mediaPort } = require('./notion-smart-launch.cjs');
const { httpsUrl, readRoute, videoRange, officialMediaSend, preparationRequest, smallJson, UploadGrants } = require('./notion-media-requests.cjs');

const redirects = new Set([301, 302, 303, 307, 308]);
const nullBody = new Set([204, 205, 304]);
const hopHeaders = ['host', 'connection', 'transfer-encoding', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection'];
const directIdleMs = 15_000;
const videoSegmentBytes = 256 * 1024;
const ports = port => Number.isInteger(port) && port > 0 && port <= 65535;
const noGrants = new UploadGrants();
const isHtml = response => /^text\/html\b/i.test(response?.headers.get('content-type') || '');

function unavailableRoute(response) {
  return !response || response.status < 400 || response.status >= 500 || [429, 451].includes(response.status) ||
    response.status === 403 && isHtml(response);
}

function toHeaders(values) {
  const headers = new Headers();
  for (const [name, items] of Object.entries(values || {})) {
    for (const item of Array.isArray(items) ? items : [items]) {
      if (item !== undefined) headers.append(name, item);
    }
  }
  return headers;
}
function streamResponse(message, method) {
  const headers = toHeaders(message.headers);
  for (const name of hopHeaders) headers.delete(name);
  const body = method !== 'HEAD' && !nullBody.has(message.statusCode) ? Readable.toWeb(message) : null;
  if (!body) message.resume();
  return new Response(body, { status: message.statusCode, statusText: message.statusMessage, headers });
}

function directHttps(target, init, port) {
  const url = new URL(target);
  const headers = new Headers(init.headers);
  for (const name of hopHeaders) headers.delete(name);
  headers.set('host', url.hostname);
  headers.set('accept-encoding', 'identity');
  return new Promise((resolve, reject) => {
    let handshakeTimer;
    const stopHandshakeTimer = () => clearTimeout(handshakeTimer);
    const request = https.request({
      hostname: '127.0.0.1', port, servername: url.hostname, rejectUnauthorized: true, agent: false,
      path: url.pathname + url.search, method: init.method, headers: Object.fromEntries(headers), signal: init.signal
    }, response => {
      stopHandshakeTimer();
      try {
        const result = streamResponse(response, init.method);
        result.headers.delete('set-cookie');
        resolve(result);
      } catch (error) { request.destroy(error); }
    });
    handshakeTimer = setTimeout(() => request.destroy(Error('Media TLS handshake stalled')), directIdleMs);
    request.once('error', error => { stopHandshakeTimer(); reject(error); });
    request.once('close', stopHandshakeTimer);
    // The socket timeout measures inactivity while Caddy is transferring data.
    request.setTimeout(directIdleMs, () => request.destroy(Error('Media route stalled')));
    const streamingUpload = init.body && !Buffer.isBuffer(init.body);
    request.once('socket', socket => socket.once('secureConnect', () => {
      stopHandshakeTimer();
      // Keep a signed upload untouched until the direct route establishes TLS.
      if (streamingUpload && !request.destroyed) pipeline(Readable.fromWeb(init.body), request).catch(error => request.destroy(error));
    }));
    if (!streamingUpload) request.end(init.body);
  });
}

function authorizeFile(request, session) {
  // Electron's net.fetch with redirect:'manual' rejects redirects. Use the
  // original session's net.request to observe the signed Location safely.
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) return reject(request.signal.reason);
    const headers = new Headers(request.headers);
    for (const name of hopHeaders) headers.delete(name);
    const native = require('electron').net.request({ url: request.url, method: request.method, session,
      useSessionCookies: true, redirect: 'manual', bypassCustomProtocolHandlers: true, headers: Object.fromEntries(headers) });
    const cancel = () => { native.abort(); reject(request.signal.reason); };
    const timer = setTimeout(() => { native.abort(); reject(Error('Media authorization stalled')); }, 6500);
    request.signal.addEventListener('abort', cancel, { once: true });
    const detach = () => { clearTimeout(timer); request.signal.removeEventListener('abort', cancel); };
    native.once('close', detach);
    native.once('error', error => { detach(); reject(error); });
    native.once('response', response => {
      clearTimeout(timer);
      try { resolve(streamResponse(response, request.method)); }
      catch (error) { native.abort(); reject(error); }
    });
    native.once('redirect', (status, _method, location, values) => {
      const reply = toHeaders(values);
      reply.set('location', location);
      detach();
      resolve(new Response(null, { status, headers: reply }));
      native.abort();
    });
    native.end();
  });
}
function rendererOptions(request, signal) {
  const headers = new Headers(request.headers);
  // Login cookies stay in their original Electron session. Signed media
  // transfers carry authorization in the URL or the original signed form.
  for (const name of ['authorization', 'cookie', ...hopHeaders]) headers.delete(name);
  return { method: request.method, headers, signal };
}
function signedRedirect(response, request) {
  if (!redirects.has(response.status) || !response.headers.has('location')) return '';
  try {
    const url = httpsUrl(new URL(response.headers.get('location'), request.url).href);
    if (!url) return '';
    const next = new Request(url, { method: request.method, headers: request.headers });
    return readRoute(next, { knownMedia: true }) === 'direct' ? url.href : '';
  } catch { return ''; }
}
const cancelBody = response => { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); };

async function stageUpload(root, request, signal) {
  const directory = path.join(root, 'smart-direct');
  await fs.promises.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'upload-' + randomUUID() + '.tmp');
  const readers = new Set();
  async function remove() {
    await Promise.all([...readers].map(stream => new Promise(resolve => {
      stream.once('close', resolve);
      stream.destroy();
    })));
    try { await fs.promises.unlink(file); } catch {}
  }
  try {
    await pipeline(Readable.fromWeb(request.body), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
    const size = (await fs.promises.stat(file)).size;
    return {
      size, remove,
      read() {
        const stream = fs.createReadStream(file);
        readers.add(stream);
        stream.once('close', () => readers.delete(stream));
        return Readable.toWeb(stream);
      }
    };
  } catch (error) {
    await remove();
    throw error;
  }
}

async function clearAbandonedUploads(root) {
  if (!root) return;
  const directory = path.join(root, 'smart-direct');
  for (const entry of await fs.promises.readdir(directory).catch(() => [])) {
    if (!/^upload-[a-f\d-]{36}\.tmp$/i.test(entry)) continue;
    const file = path.join(directory, entry);
    const stat = await fs.promises.lstat(file).catch(() => null);
    if (stat?.isFile() && Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) await fs.promises.unlink(file).catch(() => {});
  }
}

function continuation(response, sent) {
  const tag = response.headers.get('etag'), encoding = response.headers.get('content-encoding');
  if (!tag?.startsWith('"') || encoding && encoding !== 'identity') return null;
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
  if (response.status === 206 && range) {
    const [start, end, total] = range.slice(1).map(Number);
    if ([start, end, total].every(Number.isSafeInteger) && start <= end && end < total) return { at: start + sent, end, total, tag };
    return null;
  }
  const length = Number(response.headers.get('content-length'));
  if (response.status === 200 && Number.isSafeInteger(length) && length > 0)
    return { at: sent, end: length - 1, total: length, tag };
  return null;
}

async function streamDownload(response, request, normal, lost) {
  if (!response.body || request.method !== 'GET' || redirects.has(response.status)) return response;
  const length = Number(response.headers.get('content-length'));
  if (length > 0 && length <= 512 * 1024 && response.headers.get('content-type')?.startsWith('image/')) {
    // Preview images must finish before handing them to the renderer. A CDN can
    // send headers and then stall, which would leave a broken preview otherwise.
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== length) throw Error('Incomplete media preview');
    return new Response(bytes, response);
  }
  let reader = response.body.getReader();
  let first;
  try { first = await reader.read(); }
  catch (error) { void reader.cancel(error).catch(() => {}); throw error; }
  if (first.done) {
    if (length > 0) throw Error('Media response body is empty');
    return new Response(null, response);
  }
  let sent = first.value.byteLength, switched = false;
  const following = new ReadableStream({
    start(controller) { controller.enqueue(first.value); },
    async pull(controller) {
      for (;;) {
        try {
          const part = await reader.read();
          if (part.done) {
            if (length && sent < length) throw Error('Incomplete media response');
            return controller.close();
          }
          sent += part.value.byteLength;
          return controller.enqueue(part.value);
        } catch (error) {
          void reader.cancel(error).catch(() => {});
          if (switched || request.signal.aborted) return controller.error(error);
          lost();
          const where = continuation(response, sent);
          // Rejoin only the identical representation at an exact byte boundary.
          if (!where || where.at > where.end) return controller.error(error);
          switched = true;
          let retry;
          try {
            const headers = new Headers(request.headers);
            headers.set('range', 'bytes=' + where.at + '-' + where.end);
            headers.set('if-range', where.tag);
            retry = await normal(new Request(request, { headers }));
            const expected = 'bytes ' + where.at + '-' + where.end + '/' + where.total;
            if (retry.status !== 206 || retry.headers.get('content-range') !== expected ||
                retry.headers.get('etag') !== where.tag || !retry.body) throw error;
            reader = retry.body.getReader();
          } catch (failure) { cancelBody(retry); return controller.error(failure); }
        }
      }
    },
    cancel(reason) { return reader.cancel(reason); }
  });
  return new Response(following, response);
}

async function systemSegment(request, normal, signal, start, end, expected) {
  const headers = new Headers(request.headers);
  headers.set('range', 'bytes=' + start + '-' + end);
  if (expected) headers.set('if-range', expected.tag);
  for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
    let response, reader;
    try {
      response = await normal(new Request(request, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(6500)]) }));
      const range = response.status === 206 && continuation(response, 0);
      if (!range || range.at !== start || range.end !== Math.min(end, range.total - 1) ||
          expected && (range.total !== expected.total || range.tag !== expected.tag) || !response.body) {
        cancelBody(response);
        return null;
      }
      reader = response.body.getReader();
      const bytes = new Uint8Array(range.end - start + 1);
      let filled = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes.set(part.value, filled);
        filled += part.value.byteLength;
      }
      if (filled === bytes.length) return { bytes, range, headers: response.headers };
    } catch {
      if (reader) void reader.cancel().catch(() => {});
      else cancelBody(response);
    }
  }
  return null;
}

async function systemVideoRange(request, normal) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') || '');
  if (!match) return normal(request);
  const start = Number(match[1]), requestedEnd = match[2] ? Number(match[2]) : Number.MAX_SAFE_INTEGER;
  if (![start, requestedEnd].every(Number.isSafeInteger) || requestedEnd - start < videoSegmentBytes) return normal(request);

  // Some VPN links stall on open-ended reads. Keep the player's original
  // range but load it in bounded pieces of the same file representation.
  const local = new AbortController();
  const signal = AbortSignal.any([request.signal, local.signal]);
  const first = await systemSegment(request, normal, signal, start, start + videoSegmentBytes - 1);
  if (!first) {
    signal.throwIfAborted();
    return normal(request);
  }
  const { range, headers } = first;
  const end = Math.min(requestedEnd, range.total - 1);
  let next = range.end + 1;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(first.bytes); },
    async pull(controller) {
      if (next > end) return controller.close();
      const part = await systemSegment(request, normal, signal, next, Math.min(end, next + videoSegmentBytes - 1), range);
      if (signal.aborted) return controller.error(signal.reason);
      if (!part) return controller.error(Error('The VPN video range could not be completed'));
      next = part.range.end + 1;
      controller.enqueue(part.bytes);
    },
    cancel() { local.abort(); }
  });
  const output = new Headers(headers);
  output.set('content-range', 'bytes ' + start + '-' + end + '/' + range.total);
  output.set('content-length', String(end - start + 1));
  output.delete('content-md5');
  output.delete('content-digest');
  output.delete('digest');
  return new Response(body, { status: 206, headers: output });
}

function createNotionMedia({
  enabled = process.env.NOTION_SWITCH_SMART_DIRECT === '1', root,
  runId = process.env.NOTION_SWITCH_SMART_RUN_ID, getPort = host => runId ? mediaPort(root, runId, host) : 0,
  dispatch = directHttps, authorize = authorizeFile, onResult = () => {}
} = {}) {
  const grants = new WeakMap();
  const cooldown = new Map();
  const lifetime = new AbortController();
  if (enabled) void clearAbandonedUploads(root);

  function candidate(target) {
    const host = new URL(target).hostname;
    const port = cooldown.get(host) > Date.now() ? 0 : getPort(host);
    return { host, port: ports(port) ? port : 0 };
  }
  function fellBack(host, kind, status = 0, pause = false) {
    if (pause) cooldown.set(host, Date.now() + 30_000);
    onResult({ host, kind, status, route: 'system' });
  }

  async function handle(request, session, normal) {
    if (!enabled) return normal(request);
    if (preparationRequest(request)) {
      const input = await smallJson(request);
      const response = await normal(request);
      if (!grants.has(session)) grants.set(session, new UploadGrants());
      await grants.get(session).observe(input, response);
      return response;
    }

    const read = readRoute(request);
    const write = !read && (request.method === 'PUT' || request.method === 'POST') &&
      await (grants.get(session) || noGrants).matches(request);
    if (!read && !write) return normal(request);

    let target = request.url, route, directResponse, preparedUpload;
    const kind = read ? 'read' : 'upload';
    const retryVideo = read && videoRange(request);
    const system = retryVideo ? input => systemVideoRange(input, normal) : normal;
    try {
      if (read === 'authorize') {
        const intermediate = await authorize(request, session);
        if (intermediate.status >= 400 || isHtml(intermediate)) {
          cancelBody(intermediate);
          return normal(request);
        }
        target = signedRedirect(intermediate, request);
        if (!target) return intermediate;
        cancelBody(intermediate);
      }
      route = candidate(target);
      if (!route.port) {
        fellBack(route.host, kind);
        return system(request);
      }
      const signal = AbortSignal.any([request.signal, lifetime.signal]);
      const options = rendererOptions(request, signal);
      if (write) {
        preparedUpload = await stageUpload(root, request, signal);
        options.headers.set('content-length', String(preparedUpload.size));
        options.body = preparedUpload.read();
      }
      directResponse = await dispatch(target, options, route.port);
      if (directResponse.status >= 400 || read && isHtml(directResponse)) throw Error('The direct media endpoint returned an error');
      // Preserve range responses and attempt to resume over the system route
      // if transport drops after part of a picture or video was sent.
      const result = read ? await streamDownload(directResponse, request, system, () => fellBack(route.host, kind, 0, true)) : directResponse;
      onResult({ host: route.host, kind, status: result.status, route: 'direct' });
      return result;
    } catch (error) {
      if (request.signal.aborted || lifetime.signal.aborted) throw error;
      fellBack(route?.host || new URL(request.url).hostname, kind, directResponse?.status || 0, !!route?.port && unavailableRoute(directResponse));
      cancelBody(directResponse);
      if (preparedUpload) {
        // Reuse the exact signed upload and original bytes. The page's file
        // block is committed by Notion only after this request succeeds.
        const headers = new Headers(request.headers);
        headers.set('content-length', String(preparedUpload.size));
        return await normal(new Request(request.url, { method: request.method, headers, body: preparedUpload.read(),
          signal: request.signal, duplex: 'half' }));
      }
      if (write && (request.bodyUsed || request.body?.locked)) return new Response('未能准备上传文件。请重试。', { status: 503 });
      return system(request);
    } finally {
      if (preparedUpload) await preparedUpload.remove();
    }
  }

  async function sendOfficial(target, init, system) {
    const kind = 'api-upload', { host, port } = candidate(target);
    if (!port) {
      fellBack(host, kind);
      return system(target, init);
    }
    let response;
    try {
      const request = new Request(target, init);
      // Official uploads are already bounded to small parts by CollectionNotion.
      const bytes = Buffer.from(await request.arrayBuffer());
      const headers = new Headers(request.headers);
      headers.set('content-length', String(bytes.length));
      const signal = AbortSignal.any([request.signal, lifetime.signal]);
      response = await dispatch(target, { method: 'POST', headers, body: bytes, signal }, port);
      if (response.ok) { onResult({ host, kind, status: response.status, route: 'direct' }); return response; }
    } catch (error) { if (init.signal?.aborted || lifetime.signal.aborted) throw error; }
    fellBack(host, kind, response?.status || 0, true);
    cancelBody(response);
    // A lost reply may hide a completed upload. Check the same upload ID over
    // the original route before retrying that ID and part, without creating a file.
    if (!response || response.status >= 500 || response.status === 409) {
      const status = await system(String(target).replace(/\/send$/, ''), { method: 'GET',
        headers: init.headers, signal: init.signal, redirect: 'error' }).catch(() => null);
      if (status?.ok) {
        const info = await status.json().catch(() => null);
        if (info?.status === 'uploaded') return Response.json(info);
      } else cancelBody(status);
    }
    return system(target, init);
  }
  function upload(target, init, system = globalThis.fetch) {
    if (!enabled || !officialMediaSend(target, init)) throw Error('只允许已识别的 Notion 图片和视频文件发送经过媒体直连。');
    return sendOfficial(target, init, system);
  }

  return { handle, upload: enabled ? upload : undefined, close() { lifetime.abort(); } };
}

module.exports = { createNotionMedia };
