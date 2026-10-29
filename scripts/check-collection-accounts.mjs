// Exercise the real account panel with delayed/failed IPC replies. No real login.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { preferences } = require('../src/collection/model.cjs');
const { templates } = require('../src/collection/prompts.cjs');
const { inspectAccount } = require('../src/collection/account-status.cjs');
const project = path.resolve(import.meta.dirname, '..');
const { chromium } = await import(pathToFileURL(process.env.COLLECTION_PLAYWRIGHT_PATH || path.join(os.homedir(), 'media-kit/node_modules/playwright-core/index.mjs')).href);
const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file => file && fs.existsSync(file));
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 620, height: 768 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(data => {
    window._accountCalls = 0; window._deletedTasks = []; window._accountInputs = []; window._loginCalls = [];
    window.collection = { request: async (action, input) => {
      if (action === 'accounts') { window._accountCalls++; window._accountInputs.push(input); return new Promise(resolve => { window._accountFinish = resolve; }); }
      if (action === 'login') { window._loginCalls.push(input.site); return { ok: true, result: { message: '已打开腾讯元宝，用于解析授权，并非视频号登录页。' } }; }
      if (action === 'state') return { ok: true, result: data };
      if (action === 'workspaces') return { ok: true, result: { workspaces: [], unavailable: [] } };
      if (action === 'delete-task') { window._deletedTasks.push(input.id); data.jobs = data.jobs.filter(j => j.id !== input.id); return { ok: true, result: { message: '已删除本机任务及相关文件。' } }; }
      return { ok: true, result: {} };
    }, onChange() {}, onShow() {} };
  }, { settings: preferences(), promptTemplates: templates, jobs: [
    { id: 'failed-fixture', title: '下载失败的任务', url: 'https://example.com/failed', status: 'failed', canDelete: true, options: preferences() },
    { id: 'active-fixture', title: '正在下载的任务', url: 'https://example.com/active', status: 'downloading', canDelete: false, options: preferences() }
  ], active: 1, binaries: {} });
  const saved = [{ id: 'xiaohongshu', name: '小红书', state: 'deferred', message: '收集时检查' }, { id: 'wechat', name: '微信视频号', state: 'link' }];
  const finish = result => page.evaluate(result => window._accountFinish({ ok: true, result }), result);
  await page.goto(pathToFileURL(path.join(project, 'src/collection/ui/index.html')).href);
  await page.waitForFunction(() => window._accountCalls === 1);
  await finish(saved);
  await page.locator('#expand').click();
  await page.locator('#settings-tab-accounts').click();
  await page.locator('#accounts .account').first().waitFor();
  assert.equal(await page.evaluate(() => window._accountInputs[0].verify), false, 'Opening the utility must not start network verification');
  await page.locator('#check-accounts').click();
  assert.equal(await page.locator('#check-accounts').isDisabled(), true, 'Clicking detection must immediately show a busy state and block repeated requests');
  assert.match(await page.locator('#accounts-feedback').innerText(), /正在检测/);
  assert.equal(await page.locator('#accounts .account').count(), 2, 'Checking must keep platform cards and their actions in place');
  await page.evaluate(() => document.getElementById('check-accounts').click());
  assert.equal(await page.evaluate(() => window._accountCalls), 2);
  assert.equal(await page.evaluate(() => window._accountInputs[1].verify), true, 'The check button must request live verification');
  assert.equal(await page.locator('#collect').isDisabled(), false, 'Account checks must not block collecting');
  await finish(saved); // Unchanged results must still acknowledge this click.
  await page.waitForFunction(() => !document.getElementById('check-accounts').disabled);
  assert.match(await page.locator('#accounts-feedback').innerText(), /检测完成/);
  assert.match(await page.locator('#accounts .account').first().innerText(), /收集时检查/);
  assert.equal(await page.locator('#accounts .valid').count(), 0, 'Local cookie presence must never show a green login state');
  await page.getByRole('button', { name: '使用说明', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window._loginCalls), [], 'Video-channel help must not silently open Yuanbao');
  assert.match(await page.locator('#wechat-help').innerText(), /元宝.*并非视频号登录页/);
  await page.locator('#wechat-yuanbao').click();
  assert.deepEqual(await page.evaluate(() => window._loginCalls), ['wechat']);
  assert.match(await page.locator('#accounts-help').innerText(), /清理.*任务.*不.*登录/);
  await page.locator('#check-accounts').click();
  await page.evaluate(() => window._accountFinish({ ok: false, error: '收集浏览器连接失败，请重试。' }));
  await page.waitForFunction(() => !document.getElementById('check-accounts').disabled);
  assert.match(await page.locator('#accounts-feedback').innerText(), /检测未完成.*连接失败/);
  assert.equal(await page.locator('#accounts-feedback').isVisible(), true);
  assert.equal(await page.locator('#accounts .account').count(), 0, 'A failed check must not leave old results looking current');
  await page.locator('#check-accounts').click();
  await finish([{ id: 'xiaohongshu', name: '小红书', state: 'unknown', message: '收集浏览器尚未启动，请先打开网站后重新检测。' }]);
  await page.waitForFunction(() => !document.getElementById('check-accounts').disabled);
  assert.match(await page.locator('#accounts .account-status').getAttribute('title'), /尚未启动/);
  assert.match(await page.locator('#accounts .account').innerText(), /连接未完成/);
  await page.locator('#tasks-summary').click();
  assert.equal(await page.getByRole('button', { name: '删除任务', exact: true }).count(), 1);
  await page.getByRole('button', { name: '删除任务', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#tasks .task').length === 1);
  assert.deepEqual(await page.evaluate(() => window._deletedTasks), ['failed-fixture']);
  assert.equal(await page.getByRole('button', { name: '删除任务', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  const output = path.join(project, '.notion-switch', 'collection-ui-qa'); fs.mkdirSync(output, { recursive: true });
  await page.locator('#check-accounts').click(); await finish([{ id: 'xiaohongshu', name: '小红书', state: 'valid', message: '网站已确认当前账号登录' }, { id: 'wechat', name: '微信视频号', state: 'link' }]);
  await page.waitForFunction(() => !document.getElementById('check-accounts').disabled);
  assert.equal(await page.locator('#accounts .valid').count(), 1);
  await page.locator('#accounts-feedback').scrollIntoViewIfNeeded();
  await page.locator('#accounts-section').screenshot({ path: path.join(output, 'accounts-feedback.png') });
  const probe = await browser.newPage(); let html = '', login = true;
  await probe.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  html = '<header><button data-testid="SideNav_AccountSwitcher_Button">Account</button></header>';
  await probe.goto('https://x.com/'); assert.equal((await probe.evaluate(inspectAccount, 'x')).state, 'valid');
  html = '<article><img alt="author avatar"><a href="/someone">Other user</a></article>';
  await probe.reload(); assert.equal((await probe.evaluate(inspectAccount, 'x')).state, 'unknown');
  html = '<title>安全验证</title><header><button data-testid="SideNav_AccountSwitcher_Button">Account</button></header>';
  await probe.reload(); assert.equal((await probe.evaluate(inspectAccount, 'x')).state, 'unknown');
  await probe.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Fixture platform page</main>' }));
  await probe.route('https://api.bilibili.com/x/web-interface/nav', route => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' }, body: JSON.stringify({ code: login ? 0 : -101, data: { isLogin: login } }) }));
  await probe.goto('https://www.bilibili.com/'); assert.equal((await probe.evaluate(inspectAccount, 'bilibili')).state, 'valid');
  login = false; assert.equal((await probe.evaluate(inspectAccount, 'bilibili')).state, 'missing');
  await probe.close();
  console.log('Account checks passed: explicit live verification, collecting while checking, stable cards, status accuracy, Yuanbao explanation, account-only DOM evidence, security challenges, and valid/expired server replies.');
} finally { await browser.close(); }
