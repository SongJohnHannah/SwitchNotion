import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractPage } = require('../src/collection/extract-page.cjs');
const { normalizeDocument, preferences } = require('../src/collection/model.cjs');
const { templates } = require('../src/collection/prompts.cjs');
const project = path.resolve(import.meta.dirname, '..'), output = path.join(project, '.notion-switch', 'collection-ui-qa');
const playwright = process.env.COLLECTION_PLAYWRIGHT_PATH || path.join(os.homedir(), 'media-kit/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(playwright).href);
const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file => file && fs.existsSync(file));
if (!executablePath) throw Error('Set CHROME_PATH to a local Chrome or Edge executable.');
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 780, height: 850 }, deviceScaleFactor: 1 });
  const long = '保留完整原文。'.repeat(2500);
  await page.route('https://collection-fixture.example/**', async route => {
    if (route.request().url().endsWith('.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="blue"/></svg>' });
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><head><title>混合原文测试</title></head><body><nav>不应收集的导航</nav><article><h1>原文标题</h1><p>第一段<a href="https://example.com/reference">参考链接</a></p><figure><img src="https://collection-fixture.example/original.svg" alt="原图"><figcaption>对应的图片说明</figcaption></figure><p>图片与视频之间</p><video src="https://collection-fixture.example/video.mp4"></video><p>视频后的文字</p><audio src="https://collection-fixture.example/audio.mp3"></audio><p>${long}</p></article><aside>不应收集的推荐</aside></body></html>` });
  });
  await page.goto('https://collection-fixture.example/article');
  const doc = normalizeDocument(await page.evaluate(extractPage));
  assert.deepEqual(doc.nodes.map(n => n.kind), ['heading', 'paragraph', 'image', 'paragraph', 'video', 'paragraph', 'audio', 'paragraph']);
  assert.equal(doc.nodes.at(-1).text, long); assert.equal(doc.nodes[2].caption, '对应的图片说明');
  assert.equal(doc.nodes[1].spans.find(s => s.href).href, 'https://example.com/reference');
  const workspaceId = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222';
  const destination = { workspaceId, id, kind: 'database', dataSourceId: '33333333-3333-4333-8333-333333333333', workspaceName: 'openClaw', label: '资料收集' };
  const fixture = { settings: preferences({ destination }), promptTemplates: templates, active: 1, binaries: { downloader: true, ffmpeg: true }, jobs: [
    { id: 'pending-fixture', title: 'B站 · 产品设计入门', url: 'https://www.bilibili.com/video/BVfixture', status: 'processing', message: '正在生成逐字稿：3 / 5 分钟', createdAt: new Date().toISOString(), options: preferences({ destination }) },
  ] };
  await page.addInitScript(data => {
    window._collectionCalls = []; window._collectionFixture = data;
    window.collection = { request: async (action, input = {}) => {
      window._collectionCalls.push({ action, input });
      let result = {};
      if (action === 'state') result = window._collectionFixture;
      if (action === 'workspaces') result = { workspaces: [{ id: data.settings.destination.workspaceId, name: 'openClaw' }], unavailable: [] };
      if (action === 'destinations') result = { results: [data.settings.destination, { ...data.settings.destination, id: '44444444-4444-4444-8444-444444444444', label: '视频笔记', kind: 'page' }], cursors: {}, hasMore: false };
      if (action === 'accounts') result = [{ id: 'douyin', name: '抖音', state: 'saved' }, { id: 'bilibili', name: 'B站', state: 'saved' }, { id: 'youtube', name: 'YouTube', state: 'missing' }];
      if (action === 'create') {
        const page = { id: data.settings.destination.id };
        result = data.duplicate ? { jobs: [{ id: 'completed-fixture', status: 'completed', existing: true, page }] } : { jobs: [{ id: 'created-fixture' }] };
        if (data.duplicate) data.latestCompletion = { id: 'completed-fixture', page };
      }
      if (action === 'configure') Object.assign(data.settings, input.settings);
      return { ok: true, result };
    }, onShow: callback => { window._showCollection = callback; }, onChange: callback => { window._changeCollection = callback; } };
  }, fixture);
  await page.setViewportSize({ width: 720, height: 368 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(project, 'src/collection/ui/index.html')).href);
  await page.getByText('openClaw / 资料收集 ⌄', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'compact.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, 'compact window must not scroll at its default size');
  await page.locator('#prompt-open').click(); await page.setViewportSize({ width: 820, height: 818 });
  await page.locator('#prompt-dialog').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(output, 'prompts.png') });
  await page.locator('#prompt-editor').fill('# 文章模板\n只提取原文支持的操作步骤');
  await page.locator('#tab-video').click(); assert.ok((await page.locator('#prompt-editor').inputValue()).includes('音视频提取'));
  await page.screenshot({ path: path.join(output, 'video-prompts.png') });
  await page.locator('#prompt-editor').fill('# 音视频模板\n提取口述步骤，不编造画面');
  await page.locator('#tab-article').click(); assert.ok((await page.locator('#prompt-editor').inputValue()).includes('操作步骤'));
  await page.locator('#prompt-save').click(); await page.locator('#prompt-dialog').waitFor({ state: 'hidden' });
  assert.ok((await page.evaluate(() => window._collectionFixture.settings.extraction.video)).includes('不编造画面'));
  await page.locator('#expand').click(); await page.setViewportSize({ width: 820, height: 818 });
  await page.locator('.destination-item').first().waitFor();
  await page.screenshot({ path: path.join(output, 'expanded.png'), fullPage: true });
  await page.locator('#vision').uncheck(); await page.locator('#links').fill('https://example.com/article\nC:\\媒体资料\\本地视频.mp4'); await page.locator('#collect').click();
  const calls = await page.evaluate(() => window._collectionCalls);
  assert.equal(calls.find(c => c.action === 'create').input.options.vision, false);
  assert.ok(calls.find(c => c.action === 'create').input.input.includes('本地视频.mp4'));
  assert.ok(calls.find(c => c.action === 'create').input.options.extraction.article.includes('操作步骤'));
  assert.equal((await page.evaluate(() => window._collectionFixture.settings.vision)), true);
  assert.deepEqual(errors, []);
  await page.evaluate(() => { window._collectionFixture.duplicate = true; });
  await page.locator('#links').fill('https://example.com/article'); await page.locator('#preview').click();
  await page.getByText('此来源已保存，无需重复收集；点击下方打开 Notion。', { exact: true }).waitFor();
  await page.locator('#last-result').waitFor({ state: 'visible' });
  await page.evaluate(() => { window._collectionFixture.jobs = []; window._changeCollection(); });
  await page.locator('#tasks-section').waitFor({ state: 'hidden' });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ extractor: { nodes: doc.nodes.length, fullTextCharacters: doc.nodes.at(-1).text.length, orderVerified: true }, renderer: { errors, perTaskVisionOverride: true, editableTemplates: true, mixedLocalInput: true, emptyHistoryHidden: true }, screenshots: ['compact.png', 'prompts.png', 'expanded.png'] }, null, 2));
  console.log('Collection browser extraction and UI checks passed. Screenshots: ' + output);
} finally { await browser.close(); }
