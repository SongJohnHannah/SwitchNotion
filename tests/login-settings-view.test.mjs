import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');
const start = source.indexOf('async function checkLogin() {');
const end = source.indexOf("$('check-login').addEventListener", start);
assert.ok(start >= 0 && end > start);

async function renderLogin(status) {
  const nodes = new Map(), messages = [];
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, hidden: false, disabled: false, textContent: '' });
    return nodes.get(id);
  };
  const context = vm.createContext({ api: { loginStatus: async () => ({ ok: true, result: status }) }, $: element, result: (...args) => messages.push(args) });
  vm.runInContext(source.slice(start, end) + '\nthis.checkLogin = checkLogin;', context);
  await context.checkLogin();
  return { element, messages };
}

test('Mac login page reflects known, missing and unknown login status without offering Windows sync', async () => {
  for (const [hasLogin, expected] of [[true, '已检测到保存的登录信息'], [false, '尚未检测到本机登录信息'], [null, '暂时无法检查登录状态']]) {
    const view = await renderLogin({ syncSupported: false, loginStrategy: 'interactive', hasLogin });
    assert.equal(view.element('login-title').textContent, expected);
    assert.equal(view.element('sync-login').hidden, true);
    assert.equal(view.element('login-sync-help').hidden, true);
    assert.equal(view.element('open-login-notion').hidden, false);
  }
});

test('Windows login page keeps the existing sync option and guidance', async () => {
  const view = await renderLogin({ syncSupported: true, loginStrategy: 'windows-local-copy', hasLogin: false, message: '可同步原版 Notion 的本机登录' });
  assert.equal(view.element('sync-login').hidden, false);
  assert.equal(view.element('sync-login').disabled, false);
  assert.equal(view.element('login-sync-help').hidden, false);
  assert.equal(view.element('open-login-notion').hidden, true);
  assert.equal(view.element('login-description').textContent, '可同步原版 Notion 的本机登录');
});

test('Mac login page offers Keychain sync and direct login', async () => {
  const view = await renderLogin({ syncSupported: true, loginStrategy: 'macos-keychain-copy', hasLogin: false, message: '可同步原版 Notion 的本机登录' });
  assert.equal(view.element('sync-login').hidden, false);
  assert.equal(view.element('login-mac-help').hidden, false);
  assert.equal(view.element('login-sync-help').hidden, true);
  assert.equal(view.element('open-login-notion').hidden, false);
});
