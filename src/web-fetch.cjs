const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const { isIP } = require('node:net');
const zlib = require('node:zlib');
const fail = message => { throw Error('Notion 联网读取' + message); };
function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6 || !/^[23][\da-f]{3}:/i.test(address)) return false;
  const first = parseInt(address.split(':')[0], 16), second = parseInt(address.split(':')[1] || '0', 16);
  return !(first === 0x2001 && (second < 0x200 || second === 0xdb8) || first === 0x2002 || first === 0x3ffe || first === 0x3fff && second < 0x1000);
}
function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value)) fail('网址无效。');
  let url; try { url = new URL(value); } catch { fail('网址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) fail('只支持无账号信息、使用标准端口的公开 HTTP(S) 网址。');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || /^(?:localhost|local|metadata|metadata\.google\.internal)$/.test(host) || /\.(?:localhost|local|internal|home\.arpa|onion)$/.test(host) || isIP(host) && !publicAddress(host)) fail('不支持本机、内网或保留地址。');
  url.hash = ''; return url;
}
function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function requestOnce(url, { addresses, headers, signal, limit }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, { method: 'GET', headers, signal, agent: false,
      lookup(_host, options, callback) {
        if (options?.all) callback(null, addresses); else callback(null, addresses[0].address, addresses[0].family);
      }
    }, response => {
      const status = response.statusCode, responseHeaders = response.headers;
      if (status !== 200) { response.destroy(); resolve({ status, headers: responseHeaders, body: Buffer.alloc(0) }); return; }
      if (Number(responseHeaders['content-length']) > limit) { response.destroy(); reject(Error('Notion 联网读取响应超过大小上限。')); return; }
      const encoding = String(responseHeaders['content-encoding'] || 'identity').toLowerCase();
      const decoder = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate() : encoding === 'br' ? zlib.createBrotliDecompress() : null;
      if (!decoder && encoding !== 'identity') { response.destroy(); reject(Error('Notion 联网读取返回了不支持的压缩格式。')); return; }
      const body = decoder ? response.pipe(decoder) : response;
      let encodedBytes = 0;
      if (decoder) response.on('data', chunk => { encodedBytes += chunk.length; if (encodedBytes > limit) response.destroy(Error('Notion 联网读取压缩响应超过大小上限。')); });
      const abort = () => body.destroy(signal.reason);
      signal.addEventListener('abort', abort, { once: true }); response.on('error', error => body.destroy(error));
      void (async () => {
        const chunks = []; let size = 0;
        try { for await (const chunk of body) { size += chunk.length; if (size > limit) fail('响应超过大小上限。'); chunks.push(chunk); } return { status, headers: responseHeaders, body: Buffer.concat(chunks) }; }
        finally { signal.removeEventListener('abort', abort); response.destroy(); decoder?.destroy(); }
      })().then(resolve, reject);
    });
    request.on('error', reject); request.end();
  });
}
function createPublicFetcher({ lookup = (host, options) => dns.lookup(host, options), transport = requestOnce } = {}) {
  return async function fetchPublic(value, { signal: parentSignal, headers = {}, limit = 2 * 1024 * 1024, redirect = true, timeoutMs = 20000 } = {}) {
    let url = publicUrl(value); const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), visited = new Set();
    for (const key of Object.keys(headers)) if (!['accept', 'user-agent', 'x-subscription-token'].includes(key.toLowerCase()) || key.toLowerCase() === 'x-subscription-token' && (url.origin !== 'https://api.search.brave.com' || redirect)) fail('请求头范围无效。');
    for (let hop = 0; hop <= 5; hop++) {
      signal.throwIfAborted();
      if (visited.has(url.href)) fail('遇到重复跳转。'); visited.add(url.href);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(lookup(host, { all: true, verbatim: true }), signal);
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(item => !publicAddress(item.address) || item.family !== isIP(item.address))) fail('目标解析到本机、内网、保留或无效地址。');
      signal.throwIfAborted();
      const response = await transport(url, { addresses, signal, limit, headers: { accept: 'text/html, text/plain;q=0.9, application/json;q=0.8', 'user-agent': 'NotionSwitch/0.2 PublicReader', 'accept-encoding': 'identity', ...headers } });
      signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status) && redirect) {
        if (hop === 5 || typeof response.headers.location !== 'string') fail('跳转过多或目标无效。');
        let next; try { next = new URL(response.headers.location, url).href; } catch { fail('跳转目标无效。'); }
        url = publicUrl(next); continue;
      }
      if (response.status !== 200) throw Object.assign(Error('Notion 联网读取返回 HTTP ' + response.status + '，未读取正文。'), { status: response.status });
      if (!Buffer.isBuffer(response.body) || response.body.length > limit) fail('响应超过大小上限或格式无效。');
      return { ...response, url: url.href, redirects: [...visited].slice(0, -1) };
    }
  };
}
module.exports = { publicAddress, publicUrl, createPublicFetcher, requestOnce };
