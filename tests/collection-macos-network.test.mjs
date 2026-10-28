import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { createMacPublicLookup } from '../src/compat/macos-public-dns.cjs';
import { assertPublicUrl } from '../src/collection/network.cjs';

const fake = [{ address: '198.18.0.56', family: 4 }];
const answer = (host = 'example.com', address = '93.184.216.34', TTL = 30) => ({ Status: 0, Question: [{ name: host, type: 1 }], Answer: [{ name: host, type: 1, data: address, TTL }] });
const reply = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/dns-json' } });

test('Mac retries only all-fake-IP DNS answers and caches independent copies within the returned TTL', async () => {
  let current = fake, calls = 0, tick = 0;
  const lookup = createMacPublicLookup({ lookup: async () => current, now: () => tick, fetchImpl: async (url, options) => {
    calls++; assert.equal(url.origin, 'https://cloudflare-dns.com'); assert.equal(url.searchParams.get('name'), 'example.com');
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    return reply(answer('example.com', '93.184.216.34', 2));
  } });
  for (const records of [[{ address: '93.184.216.34', family: 4 }], [{ address: '10.0.0.1', family: 4 }], [...fake, { address: '10.0.0.1', family: 4 }]]) {
    current = records; assert.equal(await lookup('example.com', { all: true }), records);
  }
  assert.equal(calls, 0); current = fake;
  const first = await lookup('example.com', { all: true }); assert.equal(first.macPublicDns, true);
  first[0].address = '127.0.0.1';
  assert.equal((await lookup('example.com', { all: true }))[0].address, '93.184.216.34'); assert.equal(calls, 1);
  tick = 2001; await lookup('example.com', { all: true }); assert.equal(calls, 2);
});

test('Mac HTTPS DNS fallback still rejects private destinations, wrong questions, unrelated answers and invalid responses', async () => {
  for (const data of [answer('example.com', '127.0.0.1'), answer('example.com', '10.0.0.1'), answer('example.com', '198.18.1.2'),
    answer('other.example'), { ...answer(), Status: 3 }, { ...answer(), TC: true }, { ...answer(), Answer: [{ name: 'other.example', type: 1, data: '93.184.216.34' }] }, answer('example.com', '999.1.2.3')]) {
    const lookup = createMacPublicLookup({ lookup: async () => fake, fetchImpl: async () => reply(data) });
    await assert.rejects(assertPublicUrl('https://example.com/file', lookup), /内网|保留|DNS|IPv4/);
  }
  let calls = 0;
  const lookup = createMacPublicLookup({ lookup: async () => fake, fetchImpl: async () => { calls++; return new Response('', { status: 503 }); } });
  await assert.rejects(assertPublicUrl('https://example.com', lookup), /公网地址/);
  await assert.rejects(assertPublicUrl('http://localhost', lookup), /本机/);
  await assert.rejects(assertPublicUrl('http://198.18.0.1', lookup), /保留/);
  assert.equal(calls, 1);
});

test('Mac HTTPS DNS accepts only addresses in the requested CNAME chain and deduplicates in-flight requests', async () => {
  let calls = 0, release;
  const lookup = createMacPublicLookup({ lookup: async () => fake, fetchImpl: async () => {
    calls++; await new Promise(resolve => { release = resolve; });
    return reply({ ...answer(), Answer: [{ name: 'example.com.', type: 5, data: 'cdn.example.com.', TTL: 10 }, { name: 'cdn.example.com.', type: 1, data: '93.184.216.34', TTL: 10 }] });
  } });
  const a = lookup('example.com', { all: true }), b = lookup('example.com', { all: true });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); release();
  assert.deepEqual(await a, await b); assert.equal((await a)[0].address, '93.184.216.34');
});

function network(platform) {
  const require = createRequire(import.meta.url), calls = [], sockets = [], module = { exports: {} };
  const addresses = [{ address: '93.184.216.34', family: 4 }]; Object.defineProperty(addresses, 'macPublicDns', { value: true });
  const request = (url, options, done) => {
    calls.push({ url, options }); const req = new EventEmitter(); req.setTimeout = () => {};
    req.end = () => queueMicrotask(() => options.method === 'CONNECT' ? req.emit('connect', { statusCode: 200 }, { destroy() {} }) : done({ statusCode: 200, headers: {} }));
    return req;
  };
  const load = id => {
    if (id === 'node:dns') return { promises: { lookup: async () => addresses } };
    if (id === '../compat/macos-public-dns.cjs') { assert.equal(platform, 'darwin', 'Windows must not load the Mac resolver'); return { macPublicLookup: async () => addresses }; }
    if (['node:http', 'node:https'].includes(id)) return { request };
    if (id === 'node:tls') return { connect: options => { sockets.push(options); return options.socket; } };
    if (id === './model.cjs') return require('../src/collection/model.cjs');
    return require(id);
  };
  vm.runInNewContext(fs.readFileSync(new URL('../src/collection/network.cjs', import.meta.url), 'utf8'), { require: load, module, process: { platform, env: {} }, URL });
  return { ...module.exports, calls, sockets };
}
test('Mac downloads pin the validated address including proxy CONNECT; Windows preserves its existing hostname route', async () => {
  for (const platform of ['darwin', 'win32']) {
    const n = network(platform); await n.openResponse('https://example.com/video.mp4');
    n.calls[0].options.lookup('example.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
    await n.openResponse('https://example.com/video.mp4', { proxy: 'http://127.0.0.1:7890' });
    assert.equal(n.calls[1].options.path, platform === 'darwin' ? '93.184.216.34:443' : 'example.com:443');
    n.calls[2].options.createConnection(); assert.equal(n.sockets[0].servername, 'example.com');
  }
});
