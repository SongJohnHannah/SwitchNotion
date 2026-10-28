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
const project = path.resolve(import.meta.dirname, '..');
const { chromium } = await import(pathToFileURL(process.env.COLLECTION_PLAYWRIGHT_PATH || path.join(os.homedir(), 'media-kit/node_modules/playwright-core/index.mjs')).href);
const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file => file && fs.existsSync(file));
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 820, height: 818 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(data => {
    window._accountCalls = 0; window._deletedTasks = [];
    window.collection = { request: async (action, input) => {
      if (action === 'accounts') { window._accountCalls++; return new Promise(resolve => { window._accountFinish = resolve; }); }
      if (action === 'state') return { ok: true, result: data };
      if (action === 'workspaces') return { ok: true, result: { workspaces: [], unavailable: [] } };
      if (action === 'delete-task') { window._deletedTasks.push(input.id); data.jobs = data.jobs.filter(j => j.id !== input.id); return { ok: true, result: { message: '已删除本机任务及相关文件。' } }; }
      return { ok: true, result: {} };
    }, onChange() {}, onShow() {} };
  }, { settings: preferences(), promptTemplates: templates, jobs: [
    { id: 'failed-fixture', title: '下载失败的任务', url: 'https://example.com/failed', status: 'failed', canDelete: true, options: preferences() },
    { id: 'active-fixture', title: '正在下载的任务', url: 'https://example.com/active', status: 'downloading', canDelete: false, options: preferences() }
  ], active: 1, binaries: {} });
  const saved = [{ id: 'xiaohongshu', name: '小红书', state: 'saved', message: '访问权限以实际读取结果为准' }];
  const finish = result => page.evaluate(result => window._accountFinish({ ok: true, result }), result);
  await page.goto(pathToFileURL(path.join(project, 'src/collection/ui/index.html')).href);
  await page.waitForFunction(() => window._accountCalls === 1);
  await finish(saved);
  await page.locator('#expand').click();
  await page.locator('#accounts .account').waitFor();
  await page.locator('#check-accounts').click();
  assert.equal(await page.locator('#check-accounts').isDisabled(), true, 'Clicking detection must immediately show a busy state and block repeated requests');
  assert.match(await page.locator('#accounts-feedback').innerText(), /正在检测/);
  await page.evaluate(() => document.getElementById('check-accounts').click());
  assert.equal(await page.evaluate(() => window._accountCalls), 2);
  await finish(saved); // Unchanged results must still acknowledge this click.
  await page.waitForFunction(() => !document.getElementById('check-accounts').disabled);
  assert.match(await page.locator('#accounts-feedback').innerText(), /检测完成/);
  assert.match(await page.locator('#accounts .account').innerText(), /未验证/);
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
  assert.match(await page.locator('#accounts-feedback').innerText(), /尚未启动/);
  assert.match(await page.locator('#accounts .account').innerText(), /未能检测/);
  await page.locator('#tasks-summary').click();
  assert.equal(await page.getByRole('button', { name: '删除任务', exact: true }).count(), 1);
  await page.getByRole('button', { name: '删除任务', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#tasks .task').length === 1);
  assert.deepEqual(await page.evaluate(() => window._deletedTasks), ['failed-fixture']);
  assert.equal(await page.getByRole('button', { name: '删除任务', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  const output = path.join(project, '.notion-switch', 'collection-ui-qa'); fs.mkdirSync(output, { recursive: true });
  await page.locator('#check-accounts').click(); await finish(saved);
  await page.waitForFunction(() => !document.getElementById('check-accounts').disabled);
  await page.locator('#accounts-feedback').scrollIntoViewIfNeeded();
  await page.locator('#accounts-section').screenshot({ path: path.join(output, 'accounts-feedback.png') });
  console.log('Account panel: immediate busy feedback, repeated-click guard, unchanged-result completion, local errors, unknown browser state and persistent-login explanation passed.');
} finally { await browser.close(); }
