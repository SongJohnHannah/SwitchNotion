const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { publicUrl } = require('./model.cjs');
function effectiveProxy(explicit = '') {
  if (explicit) return explicit;
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    try { const value = new URL(process.env[name]); if (['http:', 'https:'].includes(value.protocol)) return value.href; } catch {}
  }
  return '';
}
function privateAddress(ip) {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v.includes(':')) {
    // Accept global unicast only. This also rejects hexadecimal IPv4-mapped
    // loopback forms such as ::ffff:7f00:1 after URL normalization.
    return !/^[23][a-f0-9]{0,3}:/.test(v) || v.startsWith('2001:db8:');
  }
  const [a, b] = v.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b);
}
async function assertPublicUrl(value, lookup = dns.lookup) {
  const url = new URL(publicUrl(value)), host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw Error('收集链接不能访问本机或内网地址。');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw Error('收集链接解析到了本机、内网或保留地址。');
  return { url, addresses };
}
async function openResponse(value, { signal, headers = {}, proxy = '', lookup, redirects = 0 } = {}) {
  signal?.throwIfAborted();
  proxy = effectiveProxy(proxy);
  const { url, addresses } = await assertPublicUrl(value, lookup);
  const options = { method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 SwitchNotion/0.2', ...headers }, signal };
  if (!proxy) options.lookup = (_host, requested, callback) => requested?.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family);
  let transport = url.protocol === 'https:' ? https : http;
  if (proxy) {
    const p = new URL(proxy);
    if (!['http:', 'https:'].includes(p.protocol)) throw Error('资源下载目前需要 HTTP 或 HTTPS 代理。');
    const tunnel = await new Promise((resolve, reject) => {
      const request = (p.protocol === 'https:' ? https : http).request(p, { method: 'CONNECT', path: url.host + (url.port ? '' : url.protocol === 'https:' ? ':443' : ':80'), signal });
      request.once('connect', (response, socket) => response.statusCode === 200 ? resolve(socket) : (socket.destroy(), reject(Error('代理连接失败。'))));
      request.once('error', reject); request.end();
    });
    options.agent = false;
    options.createConnection = () => url.protocol === 'https:' ? tls.connect({ socket: tunnel, servername: url.hostname }) : tunnel;
  }
  const response = await new Promise((resolve, reject) => {
    const request = transport.request(url, options, resolve);
    request.setTimeout(120000, () => request.destroy(Error('资源下载超时。')));
    request.once('error', reject); request.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume();
    if (!response.headers.location || redirects >= 8) throw Error('资源重定向次数过多。');
    const nextHeaders = { ...headers }; delete nextHeaders.cookie; delete nextHeaders.Cookie; delete nextHeaders.authorization;
    return openResponse(new URL(response.headers.location, url).href, { signal, headers: nextHeaders, proxy, lookup, redirects: redirects + 1 });
  }
  if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); throw Error(`资源下载返回 HTTP ${response.statusCode}，请检查登录和访问权限。`); }
  return response;
}
async function download(value, file, { maxBytes = 5 * 1024 ** 3, mime, ...options } = {}) {
  const response = await openResponse(value, options);
  const contentType = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (contentType.includes('text/html') || mime && contentType && !mime.test(contentType) && contentType !== 'application/octet-stream') { response.destroy(); throw Error('资源地址返回了网页或登录提示，没有下载到原始媒体。'); }
  if (Number(response.headers['content-length']) > maxBytes) { response.destroy(); throw Error('资源超过当前支持的单文件大小。'); }
  let bytes = 0;
  const counter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(bytes > maxBytes ? Error('资源超过当前支持的单文件大小。') : null, chunk); } });
  try { await pipeline(response, counter, fs.createWriteStream(file, { mode: 0o600 }), { signal: options.signal }); }
  catch (error) { try { fs.unlinkSync(file); } catch {} throw error; }
  if (!bytes) { fs.unlinkSync(file); throw Error('资源下载结果为空。'); }
  return { bytes, contentType };
}
module.exports = { privateAddress, assertPublicUrl, effectiveProxy, openResponse, download };
