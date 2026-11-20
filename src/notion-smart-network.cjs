const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');

const { mediaHosts: knownHosts, allowedHost } = require('./notion-media-requests.cjs');
function publicIPv4(input) {
  if (net.isIP(input) !== 4) return false;
  const [a, b, c] = input.split('.').map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) &&
    !(a === 192 && b === 0 && (c === 0 || c === 2)) && !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) &&
    !(a === 203 && b === 0 && c === 113);
}
function chooseInterface(interfaces = os.networkInterfaces()) {
  const choices = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (/^(?:u?tun|tap)\d*$/i.test(name) || /(?:loopback|virtual|vethernet|vmware|hyper-v|wsl|tunnel|\btun\b|\btap\b|vpn|wireguard|tailscale|zerotier)/i.test(name)) continue;
    for (const row of addresses || []) {
      if (row.family !== 'IPv4' && row.family !== 4 || row.internal || net.isIP(row.address) !== 4 || row.address.startsWith('169.254.')) continue;
      const rank = /^(?:wlan|wi-?fi|无线)/i.test(name) ? 0 : /^(?:ethernet|以太网)/i.test(name) ? 1 : 2;
      choices.push({ name, address: row.address, rank });
    }
  }
  choices.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return choices.length ? { name: choices[0].name, address: choices[0].address } : null;
}
function requestHttps({ host, target, localAddress, pathname = '/', method = 'HEAD', headers = {}, timeoutMs = 4500, maxBytes = 0 }) {
  return new Promise(resolve => {
    const start = process.hrtime.bigint(); let done = false, request;
    const finish = value => { if (done) return; done = true; clearTimeout(deadline); request?.destroy(); resolve(value); };
    const deadline = setTimeout(() => finish(null), timeoutMs);
    try {
      request = https.request({ hostname: target || host, port: 443, servername: host, method, path: pathname, localAddress,
        family: 4, rejectUnauthorized: true, headers: { host, ...headers }, timeout: timeoutMs }, response => {
        const status = response.statusCode || 0;
        if (!maxBytes) { response.resume(); return finish({ status, ms: Number(process.hrtime.bigint() - start) / 1e6 }); }
        let bytes = 0; const chunks = [];
        response.on('data', part => { bytes += part.length; if (bytes > maxBytes) finish(null); else chunks.push(part); });
        response.once('end', () => finish({ status, ms: Number(process.hrtime.bigint() - start) / 1e6, body: Buffer.concat(chunks) }));
        response.once('error', () => finish(null));
      });
      request.once('timeout', () => finish(null)); request.once('error', () => finish(null)); request.end();
    } catch { finish(null); }
  });
}
async function dohA(host, localAddress, timeoutMs = 4500, request = requestHttps) {
  const result = await request({ host: 'doh.pub', localAddress, timeoutMs, method: 'GET', maxBytes: 256 * 1024,
    pathname: '/dns-query?name=' + encodeURIComponent(host) + '&type=A', headers: { accept: 'application/dns-json' } });
  if (result?.status !== 200 || !result.body) return [];
  try {
    const parsed = JSON.parse(result.body.toString('utf8'));
    return Array.isArray(parsed.Answer) ? parsed.Answer.filter(row => row?.type === 1).map(row => row.data).filter(publicIPv4) : [];
  } catch { return []; }
}
async function addressesFor(host, { localAddress, lookup = dns.lookup.bind(dns), resolve = dohA, timeoutMs = 4500 } = {}) {
  if (!allowedHost(host)) throw Error('The domain is outside the Notion direct-routing scope.');
  const bounded = operation => new Promise(done => {
    const timer = setTimeout(() => done([]), Math.max(1, timeoutMs));
    Promise.resolve().then(operation).then(value => { clearTimeout(timer); done(value); }, () => { clearTimeout(timer); done([]); });
  });
  const [system, doh] = await Promise.all([
    bounded(() => lookup(host, { all: true, family: 4 })),
    bounded(() => resolve(host, localAddress, timeoutMs))
  ]);
  return [...new Set([...(Array.isArray(system) ? system.map(value => typeof value === 'string' ? value : value?.address) : []),
    ...(Array.isArray(doh) ? doh : [])].filter(publicIPv4))].slice(0, 8);
}
async function probeHost(host, { localAddress, lookup, resolve, request = requestHttps, timeoutMs = 4500, rounds = 2 } = {}) {
  const normalized = typeof host === 'string' ? host.toLowerCase() : '';
  if (!allowedHost(normalized) || net.isIP(localAddress) !== 4) throw Error('A permitted domain and physical IPv4 address are required.');
  const candidates = await addressesFor(normalized, { localAddress, lookup, resolve, timeoutMs: Math.min(timeoutMs, 4000) });
  const checked = await Promise.all(candidates.map(async ip => {
    const samples = [];
    for (let i = 0; i < rounds; i++) {
      const image = normalized === 'images.unsplash.com';
      const pathname = normalized === 'api.notion.com' ? '/v1/file_uploads'
        : image ? '/photo-1500530855697-b586d89ba3ee?w=400&q=70'
          : /^file\.notion\./.test(normalized) ? '/f/f/' : /^(?:app\.|www\.)?notion\.(?:com|so)$/.test(normalized) ? '/image/' : '/';
      const result = await request({ host: normalized, target: ip, localAddress, timeoutMs,
        method: normalized === 'api.notion.com' || image ? 'GET' : 'HEAD',
        pathname,
        ...(image ? { maxBytes: 256 * 1024 } : {}) });
      if (result && Number.isFinite(result.ms) && (image ? result.status === 200 && result.body?.length :
        result.status >= 200 && result.status < 500 && result.status !== 429)) samples.push(result.ms);
    }
    samples.sort((a, b) => a - b);
    return { ip, successes: samples.length, ms: samples.length === rounds ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : null };
  }));
  checked.sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity));
  return { host: normalized, candidates: checked, best: checked.find(value => value.ms !== null) || null, checkedAt: new Date().toISOString() };
}
function caddyConfig({ port = 443, adminPort, localAddress, selections = {} }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65535 || net.isIP(localAddress) !== 4) throw Error('Invalid local Caddy configuration.');
  const routes = [];
  for (const [host, ip] of Object.entries(selections)) {
    if (!allowedHost(host) || !publicIPv4(ip)) throw Error('Invalid selected upstream.');
    routes.push({ match: [{ tls: { sni: [host] } }], handle: [{ handler: 'proxy', upstreams: [{ dial: [ip + ':443'], local_address: [localAddress] }] }] });
  }
  return { admin: { listen: '127.0.0.1:' + adminPort, enforce_origin: true, origins: ['127.0.0.1:' + adminPort], config: { persist: false } },
    logging: { logs: { default: { level: 'ERROR' } } }, apps: { layer4: { servers: { notion_direct: { listen: ['127.0.0.1:' + port], routes } } } } };
}
module.exports = { knownHosts, allowedHost, publicIPv4, chooseInterface, requestHttps, dohA, addressesFor, probeHost, caddyConfig };
