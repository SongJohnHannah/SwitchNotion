const dns = require('node:dns').promises;
const tls = require('node:tls');
const accelerator = require('./notion-accelerator.cjs');

const probeHost = 'api.notion.com';

function handshake(ip, timeoutMs = 4000) {
  return new Promise(resolve => {
    const started = process.hrtime.bigint();
    let settled = false;
    const socket = tls.connect({ host: ip, port: 443, servername: probeHost, rejectUnauthorized: true });
    const finish = ms => { if (settled) return; settled = true; socket.destroy(); resolve(ms); };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.once('secureConnect', () => finish(Number(process.hrtime.bigint() - started) / 1e6));
    socket.once('error', () => finish(null));
  });
}

// 只用 Notion 官方 DNS 返回的地址，测的是真实 TLS 握手，证书必须是 Notion 自己的。
// 用系统解析器而不是 c-ares 的 resolve4：Windows 上 c-ares 有时直接 ECONNREFUSED。
async function check({ lookup = () => dns.lookup(probeHost, { all: true, family: 4 }), handshakeImpl = handshake, timeoutMs = 4000 } = {}) {
  let addresses = [];
  try { addresses = await lookup(); } catch {}
  const ips = [...new Set((Array.isArray(addresses) ? addresses : [])
    .map(row => typeof row === 'string' ? row : row?.address)
    .filter(ip => typeof ip === 'string'))].slice(0, 16);
  const results = (await Promise.all(ips.map(async ip => ({ ip, ms: await handshakeImpl(ip, timeoutMs) }))))
    .sort((a, b) => (Number.isFinite(a.ms) ? a.ms : Infinity) - (Number.isFinite(b.ms) ? b.ms : Infinity));
  return { host: probeHost, candidates: results, best: results.find(row => Number.isFinite(row.ms)) || null, checkedAt: new Date().toISOString() };
}

async function refresh(root, options) {
  const result = await check(options);
  if (!result.best) return { ...result, saved: false };
  accelerator.save(root, { ...accelerator.read(root), bestIp: result.best.ip, checkedAt: result.checkedAt });
  return { ...result, saved: true };
}

module.exports = { probeHost, handshake, check, refresh };
