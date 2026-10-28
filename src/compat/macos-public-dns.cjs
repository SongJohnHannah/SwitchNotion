const dns = require('node:dns').promises;
const net = require('node:net');

const fakeAddress = record => record.family === 4 && /^198\.(?:18|19)\./.test(record.address);
const dnsName = value => typeof value === 'string' ? value.toLowerCase().replace(/\.$/, '') : '';
function resolved(records) {
  const copy = records.map(record => ({ ...record }));
  // The downloader must pin CONNECT tunnels too, instead of asking a proxy
  // to resolve this hostname again after validating the public DNS answer.
  Object.defineProperty(copy, 'macPublicDns', { value: true });
  return copy;
}
function createMacPublicLookup({ lookup = dns.lookup, fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  return async function macPublicLookup(hostname, options) {
    const original = await lookup(hostname, options);
    // Preserve normal DNS and every other private/reserved-address rejection.
    if (!Array.isArray(original) || !original.length || !original.every(fakeAddress) || net.isIP(hostname)) return original;
    const host = dnsName(hostname), saved = cache.get(host);
    if (saved && saved.until > now()) return resolved(saved.records);
    if (!pending.has(host)) {
      const query = (async () => {
        // Cloudflare's fixed HTTPS DNS endpoint: no cookies or source URL.
        // https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
        const url = new URL('https://cloudflare-dns.com/dns-query');
        url.search = new URLSearchParams({ name: host, type: 'A' }).toString();
        const response = await fetchImpl(url, { headers: { accept: 'application/dns-json' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw Error('Mac 代理 DNS 未能确认公网地址，请检查网络后重试。');
        const text = await response.text(); if (text.length > 65536) throw Error('Mac 公网 DNS 回包无效。');
        const data = JSON.parse(text);
        if (data.Status !== 0 || data.TC || !Array.isArray(data.Question) || data.Question.length !== 1 || data.Question[0].type !== 1 || dnsName(data.Question[0].name) !== host || !Array.isArray(data.Answer) || data.Answer.length > 64) throw Error('Mac 公网 DNS 回包无效。');
        const names = new Set([host]);
        for (let round = 0; round < data.Answer.length; round++) for (const answer of data.Answer) {
          if (answer.type === 5 && names.has(dnsName(answer.name)) && /^[a-z\d.-]+\.?$/i.test(answer.data || '')) names.add(dnsName(answer.data));
        }
        const answers = data.Answer.filter(answer => answer.type === 1 && names.has(dnsName(answer.name)));
        if (!answers.length || answers.some(answer => net.isIP(answer.data) !== 4)) throw Error('Mac 公网 DNS 没有返回有效 IPv4 地址。');
        const records = [...new Set(answers.map(answer => answer.data))].map(address => ({ address, family: 4 }));
        const chain = data.Answer.filter(answer => [1, 5].includes(answer.type) && names.has(dnsName(answer.name)));
        const ttl = Math.max(0, Math.min(30, ...chain.map(answer => Number.isFinite(answer.TTL) ? answer.TTL : 0)));
        cache.delete(host); cache.set(host, { records, until: now() + ttl * 1000 });
        while (cache.size > 128) cache.delete(cache.keys().next().value);
        return records;
      })();
      pending.set(host, query);
      void query.finally(() => pending.delete(host)).catch(() => {});
    }
    return resolved(await pending.get(host));
  };
}
module.exports = { createMacPublicLookup, macPublicLookup: createMacPublicLookup() };
