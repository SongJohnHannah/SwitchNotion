import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../src/collection/network.cjs', import.meta.url));
const source = fs.readFileSync(new URL('../src/collection/network.cjs', import.meta.url), 'utf8');
function network(env = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source, { require, module, process: { platform: 'win32', env }, URL });
  return module.exports;
}

test('environment proxies stay valid Chrome host-and-port identifiers instead of gaining a URL path', () => {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    for (const value of ['http://127.0.0.1:2080', 'http://127.0.0.1:2080/']) {
      assert.equal(network({ [name]: value }).effectiveProxy(), 'http://127.0.0.1:2080');
    }
  }
});

test('explicit proxies use the same Chrome-compatible format and override the environment', () => {
  const { effectiveProxy } = network({ HTTPS_PROXY: 'http://127.0.0.1:2080' });
  assert.equal(effectiveProxy('https://proxy.example:8443/'), 'https://proxy.example:8443');
  assert.equal(effectiveProxy('http://[::1]:7890/'), 'http://[::1]:7890');
});

test('invalid inherited proxies are skipped without leaking credentials into browser arguments', () => {
  for (const value of ['not a URL', 'socks5://127.0.0.1:1080', 'http://user:password@proxy.example:8080',
    'http://proxy.example:8080/path', 'http://proxy.example:8080/?query=1', 'http://proxy.example:8080/#fragment']) {
    assert.equal(network({ HTTPS_PROXY: value, HTTP_PROXY: 'http://127.0.0.1:7890' }).effectiveProxy(), 'http://127.0.0.1:7890');
  }
  assert.equal(network().effectiveProxy(), '');
  assert.equal(network({ HTTPS_PROXY: 'http://127.0.0.1:2080', HTTP_PROXY: 'http://127.0.0.1:7890' }).effectiveProxy(), 'http://127.0.0.1:2080');
});

test('invalid explicit proxies report a configuration error instead of being silently rewritten', () => {
  const { effectiveProxy } = network();
  for (const value of ['socks5://127.0.0.1:1080', 'http://user:password@proxy.example:8080', 'http://proxy.example/path']) {
    assert.throws(() => effectiveProxy(value), /代理/);
  }
});
