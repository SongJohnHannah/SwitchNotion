import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const smart = require('../src/notion-smart-network.cjs');
const { NotionSmartService } = require('../src/notion-smart-service.cjs');
const smartLaunch = require('../src/notion-smart-launch.cjs');
const { SettingsService } = require('../src/settings-service.cjs');

test('the relay accepts only exact hosts used by recognized media transfers', () => {
  for (const host of ['app.notion.com', 'file.notion.so', 'img.notionusercontent.com',
    'prod-files-secure.s3.us-west-2.amazonaws.com', 'images.unsplash.com']) assert.equal(smart.allowedHost(host), true, host);
  for (const host of ['msgstore.app.notion.com', 'one.notion.site', 'notion.com.attacker.example', 'notion-so.example', 'localhost',
    'other.s3.us-west-2.amazonaws.com', 'api.unsplash.com']) assert.equal(smart.allowedHost(host), false, host);
  for (const ip of ['127.0.0.1', '10.2.3.4', '172.16.5.2', '192.168.0.1', '169.254.1.2', '100.64.1.1']) assert.equal(smart.publicIPv4(ip), false, ip);
  assert.equal(smart.publicIPv4('208.103.161.17'), true);
});

test('selects a physical interface rather than the VPN adapter', () => {
  const selected = smart.chooseInterface({
    'neko-tun': [{ family: 'IPv4', address: '172.19.0.1', internal: false }],
    'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
    WLAN: [{ family: 'IPv4', address: '192.168.0.106', internal: false }]
  });
  assert.deepEqual(selected, { name: 'WLAN', address: '192.168.0.106' });
  assert.equal(smart.chooseInterface({ 'neko-tun': [{ family: 'IPv4', address: '172.19.0.1', internal: false }] }), null);
});

test('each host selects only an address that completes both direct probes', async () => {
  const calls = [];
  const lookup = async host => host === 'api.notion.com'
    ? ['208.103.161.1', '208.103.161.2', '127.0.0.1'] : ['52.92.154.210'];
  const resolve = async () => ['208.103.161.2'];
  const request = async ({ host, target, localAddress, pathname }) => {
    calls.push({ host, target, localAddress, pathname });
    if (target === '208.103.161.1') return null;
    return { status: host === 'api.notion.com' ? 401 : 403, ms: target === '52.92.154.210' ? 15 : 70 };
  };
  const api = await smart.probeHost('api.notion.com', { localAddress: '192.168.0.106', lookup, resolve, request });
  const video = await smart.probeHost('prod-files-secure.s3.us-west-2.amazonaws.com', { localAddress: '192.168.0.106', lookup,
    resolve: async () => [], request });
  assert.equal(api.best.ip, '208.103.161.2');
  assert.equal(api.candidates.find(value => value.ip === '208.103.161.1').ms, null);
  assert.equal(api.candidates.some(value => value.ip === '127.0.0.1'), false);
  assert.equal(video.best.ip, '52.92.154.210');
  assert.ok(calls.filter(value => value.host === 'api.notion.com').every(value => value.pathname === '/v1/file_uploads'));
  await assert.rejects(smart.probeHost('attacker.example', { localAddress: '192.168.0.106', lookup, resolve, request }));
});

test('does not choose an address that fails one of the two health checks', async () => {
  let count = 0;
  const result = await smart.probeHost('api.notion.com', { localAddress: '192.168.0.106',
    lookup: async () => ['208.103.161.2'], resolve: async () => [],
    request: async () => ++count === 1 ? { status: 401, ms: 20 } : null });
  assert.equal(result.best, null);
  assert.equal(result.candidates[0].successes, 1);
});

test('a stalled system DNS lookup cannot prevent direct address selection', async () => {
  const result = await Promise.race([
    smart.addressesFor('api.notion.com', { localAddress: '192.168.0.106', timeoutMs: 30,
      lookup: () => new Promise(() => {}), resolve: async () => ['208.103.161.2'] }),
    new Promise(resolve => setTimeout(() => resolve('timed out waiting for address selection'), 200))
  ]);
  assert.deepEqual(result, ['208.103.161.2']);
});

test('image selection measures a real image response rather than only a TLS handshake', async () => {
  const calls = [];
  const result = await smart.probeHost('images.unsplash.com', { localAddress: '192.168.0.106',
    lookup: async () => ['151.101.2.208'], resolve: async () => [],
    request: async options => { calls.push(options); return { status: 200, ms: 50, body: Buffer.from('image') }; } });
  assert.equal(result.best.ip, '151.101.2.208');
  assert.ok(calls.every(options => options.method === 'GET' && options.pathname.includes('photo-') && options.maxBytes > 0));
});

test('Caddy configuration preserves TLS and restricts listening to loopback', () => {
  const config = smart.caddyConfig({ port: 18443, adminPort: 19019, localAddress: '192.168.0.106',
    selections: { 'api.notion.com': '208.103.161.2', 'prod-files-secure.s3.us-west-2.amazonaws.com': '52.92.154.210' } });
  assert.deepEqual(config.apps.layer4.servers.notion_direct.listen, ['127.0.0.1:18443']);
  assert.equal(config.admin.listen, '127.0.0.1:19019');
  const routes = config.apps.layer4.servers.notion_direct.routes;
  assert.equal(routes.length, 2, 'there is no unverified DNS fallback');
  assert.deepEqual(routes[0].match[0].tls.sni, ['api.notion.com']);
  assert.deepEqual(routes[0].handle[0].upstreams[0].dial, ['208.103.161.2:443']);
  assert.equal(JSON.stringify(config).includes('insecure_skip_verify'), false);
  assert.equal(JSON.stringify(config).includes('certificate'), false);
  assert.throws(() => smart.caddyConfig({ port: 18443, adminPort: 19019, localAddress: '192.168.0.106', selections: { 'attacker.example': '208.103.161.2' } }));
  assert.throws(() => smart.caddyConfig({ port: 18443, adminPort: 19019, localAddress: '192.168.0.106', selections: { 'api.notion.com': '127.0.0.1' } }));
});

test('starts without probing the remote network and updates media hosts in the background', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-smart-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const process = new EventEmitter(); process.pid = 123; process.exitCode = null; process.stderr = new EventEmitter();
  process.kill = () => { process.exitCode = 0; process.emit('exit', 0); };
  const applied = [], tried = [];
  const service = new NotionSmartService({ root, executable: processExecPath(), port: 18443,
    pickInterface: () => ({ name: 'WLAN', address: '192.168.0.106' }), startProcess: () => process, ready: async () => true,
    applyConfig: async (_port, config) => applied.push(config),
    probe: async (host, { timeoutMs }) => {
      tried.push(host);
      const responders = { 'api.notion.com': '208.103.161.2', 'prod-files-secure.s3.us-west-2.amazonaws.com': '52.92.154.210' };
      return { host, best: timeoutMs >= 8000 && responders[host] ? { ip: responders[host], ms: 8000 } : null };
    }
  });
  const ready = await service.start(); assert.equal(ready.state, 'ready');
  assert.deepEqual(tried, []);
  const refreshed = await service.refresh();
  assert.equal(refreshed.selections['api.notion.com'], '208.103.161.2');
  assert.equal(refreshed.selections['prod-files-secure.s3.us-west-2.amazonaws.com'], '52.92.154.210');
  assert.equal(refreshed.selections['identity.notion.com'], undefined);
  assert.equal(applied.length, 1);
  service.stop(); assert.equal(process.exitCode, 0); assert.equal(service.status.state, 'stopped');
});

test('an unsuccessful configuration reload preserves the last active addresses', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-smart-reload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter(); child.pid = 124; child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  const service = new NotionSmartService({ root, executable: processExecPath(), port: 18443,
    previous: { scope: 'media', interface: 'WLAN', localAddress: '192.168.0.106', lastCheck: new Date().toISOString(),
      selections: { 'api.notion.com': '208.103.161.2' } },
    pickInterface: () => ({ name: 'WLAN', address: '192.168.0.106' }), startProcess: () => child, ready: async () => true,
    applyConfig: async () => { throw Error('reload rejected'); },
    probe: async host => ({ host, best: host === 'api.notion.com' ? { ip: '208.103.161.17' } : null })
  });
  await service.start();
  await assert.rejects(service.refresh(), /reload rejected/);
  assert.equal(service.status.selections['api.notion.com'], '208.103.161.2');
  assert.equal(service.status.refreshing, false);
  service.stop();
});

function processExecPath() { return process.execPath; }

test('platform binary lookup uses extensionless Caddy files and leaves a Mac integration point', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-smart-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['windows-amd64', 'darwin-arm64']) {
    const dir = path.join(root, 'caddy-route', name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'caddy'), 'fixture');
  }
  assert.equal(smartLaunch.executable(root, root, 'win32', 'x64'), path.join(root, 'caddy-route', 'windows-amd64', 'caddy'));
  assert.equal(smartLaunch.executable(root, root, 'darwin', 'arm64'), path.join(root, 'caddy-route', 'darwin-arm64', 'caddy'));
  assert.equal(smartLaunch.executable(root, root, 'linux', 'x64'), '');
});

test('the Windows setting enables one direct mode and turns off the old conflicting switches', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-smart-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'caddy-route', 'windows-amd64'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'caddy'), 'fixture');
  const service = new SettingsService({ root });
  const enabled = await service.saveAccelerator({ smartDirect: 'enabled' });
  assert.equal(enabled.smartDirect, true); assert.equal(enabled.autoIp, false); assert.equal(enabled.bypassVpn, false);
  assert.equal((await service.saveAccelerator({ smartDirect: 'disabled' })).smartDirect, false);
});
