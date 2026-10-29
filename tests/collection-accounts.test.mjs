import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { inspectAccount } = require('../src/collection/account-status.cjs');
const { CollectionBrowser } = require('../src/collection/browser.cjs');

function inspect(site, { url, title = '', selectors = {}, state, response, fetchError } = {}) {
  const domains = { bilibili: 'www.bilibili.com', xiaohongshu: 'www.xiaohongshu.com', youtube: 'www.youtube.com', x: 'x.com' };
  const location = new URL(url || 'https://' + domains[site] + '/');
  const context = { location, AbortSignal, window: { __INITIAL_STATE__: state },
    document: { title, querySelectorAll: selector => selectors[selector] || [] }, getComputedStyle: () => ({ visibility: 'visible' }),
    fetch: async (url, options) => { assert.equal(url, 'https://api.bilibili.com/x/web-interface/nav'); assert.equal(options.credentials, 'include'); assert.equal(options.cache, 'no-store'); if (fetchError) throw Error('offline'); return { ok: response?.ok !== false, json: async () => response?.data }; }
  };
  return vm.runInNewContext('(' + inspectAccount.toString() + ')(' + JSON.stringify(site) + ')', context);
}
const visible = { getClientRects: () => [{ width: 32, height: 32 }] };

test('Bilibili checks the authenticated endpoint and distinguishes expired sessions from network failures', async () => {
  assert.equal((await inspect('bilibili', { response: { data: { code: 0, data: { isLogin: true, uname: 'private', mid: 'private' } } } })).state, 'valid');
  assert.equal((await inspect('bilibili', { response: { data: { code: -101, data: { isLogin: false } } } })).state, 'missing');
  assert.equal((await inspect('bilibili', { response: { ok: false } })).state, 'unknown');
  assert.equal((await inspect('bilibili', { fetchError: true })).state, 'unknown');
  assert.equal((await inspect('bilibili', { response: { data: { code: 0, data: {} } } })).state, 'unknown');
  assert.equal(JSON.stringify(await inspect('bilibili', { response: { data: { code: 0, data: { isLogin: true, uname: 'private' } } } })).includes('private'), false);
});

test('Xiaohongshu uses current-account state and never treats recommendation authors as the current user', async () => {
  assert.equal((await inspect('xiaohongshu', { state: { user: { userInfo: { guest: false, userId: 'synthetic-id' } } } })).state, 'valid');
  assert.equal((await inspect('xiaohongshu', { state: { user: { userInfo: { _value: { guest: true, userId: 'visitor' } } } } })).state, 'missing');
  assert.equal((await inspect('xiaohongshu', { state: { note: { author: { userId: 'other-person' } } } })).state, 'unknown');
});

test('account controls are read only and redirects, challenges and hidden controls cannot turn the indicator green', async () => {
  const selector = '[data-testid="SideNav_AccountSwitcher_Button"]';
  assert.equal((await inspect('x', { selectors: { [selector]: [visible] } })).state, 'valid');
  assert.equal((await inspect('x', { selectors: { [selector]: [{ getClientRects: () => [] }] } })).state, 'unknown');
  assert.equal((await inspect('x', { url: 'https://x.com/i/flow/login' })).state, 'missing');
  assert.equal((await inspect('x', { url: 'https://x.com/account/access', selectors: { [selector]: [visible] } })).state, 'unknown');
  assert.equal((await inspect('x', { title: '安全验证', selectors: { [selector]: [visible] } })).state, 'unknown');
  assert.equal((await inspect('x', { url: 'https://x.com.evil.example/', selectors: { [selector]: [visible] } })).state, 'unknown');
});

test('opening the account panel starts no browser and makes no login-validity claim', async () => {
  const browser = new CollectionBrowser({});
  browser.ensure = async () => { throw Error('must not start browser'); };
  const rows = await browser.accounts();
  assert.equal(rows.filter(row => row.state === 'valid').length, 0);
  assert.equal(rows.find(row => row.id === 'wechat').state, 'link');
  assert.equal(rows.filter(row => row.state === 'deferred').length, 6);
});

test('explicit verification isolates failed sites, bounds concurrency, and does not probe video-channel login', async () => {
  const browser = new CollectionBrowser({}), checked = [];
  let concurrent = 0, peak = 0;
  browser.ensure = async () => {};
  browser.verifyAccount = async site => {
    checked.push(site.id); concurrent++; peak = Math.max(peak, concurrent);
    await new Promise(resolve => setTimeout(resolve, 5)); concurrent--;
    if (site.id === 'tiktok') throw Error('offline');
    return { state: site.id === 'bilibili' ? 'valid' : 'missing', message: 'synthetic verdict' };
  };
  const rows = await browser.accounts(AbortSignal.timeout(1000), { verify: true });
  assert.equal(checked.includes('wechat'), false); assert.equal(checked.length, 6); assert.ok(peak <= 3);
  assert.equal(rows.find(row => row.id === 'bilibili').state, 'valid');
  assert.equal(rows.find(row => row.id === 'tiktok').state, 'unknown');
  assert.equal(rows.find(row => row.id === 'wechat').state, 'link');
  assert.equal((await browser.accounts()).find(row => row.id === 'bilibili').state, 'valid');
  browser.getSettings = () => ({ browserProfile: 'another-profile' });
  assert.equal((await browser.accounts()).some(row => row.state === 'valid'), false, 'Cached results belong to one browser profile');
  browser.getSettings = undefined;
  browser.accountChecks.at = 0;
  assert.equal((await browser.accounts()).find(row => row.id === 'bilibili').state, 'deferred');
  browser.ensure = async () => { throw Error('browser missing'); };
  assert.equal((await browser.accounts(undefined, { verify: true })).filter(row => row.state === 'unknown').length, 6);
  assert.equal((await browser.accounts()).some(row => row.state === 'valid'), false, 'A failed new check must not revive an old green status');
});
