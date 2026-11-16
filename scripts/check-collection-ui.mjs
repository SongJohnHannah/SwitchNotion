import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractPage } = require('../src/collection/extract-page.cjs');
const { normalizeDocument, preferences } = require('../src/collection/model.cjs');
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
  await page.route('https://www.douyin.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    '<html><head><title>图文分享</title><meta property="og:type" content="video"></head><body><main><section data-e2e="note-detail"><h1>图文教程</h1><p data-e2e="video-desc">目标图文正文</p><p>1/2</p><div><div class="dySwiperSlide"><img width="800" height="600" src="https://collection-fixture.example/note-1.jpg"><img width="800" height="600" src="https://collection-fixture.example/note-1.jpg?duplicate=1"></div><div class="dySwiperSlide"><img width="800" height="600" src="https://collection-fixture.example/note-2.jpg"></div></div><section data-e2e="recommend-list"><p>不应收集的推荐</p><video src="https://collection-fixture.example/recommended.mp4"></video><img width="800" height="600" src="https://collection-fixture.example/recommend.jpg"></section></section></main></body></html>' }));
  await page.goto('https://www.douyin.com/note/1234567890123456789');
  const note = normalizeDocument(await page.evaluate(extractPage));
  assert.equal(note.nodes.some(node => node.kind === 'video'), false, 'a Douyin note and its recommended player must not become a video download');
  assert.deepEqual(note.nodes.filter(node => node.kind === 'image').map(node => node.url), ['https://collection-fixture.example/note-1.jpg', 'https://collection-fixture.example/note-2.jpg']);
  assert.ok(note.nodes.some(node => node.text === '目标图文正文')); assert.ok(note.nodes.every(node => !node.text?.includes('不应收集的推荐')));
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.id = 'captcha-fixture'; frame.src = 'about:blank#verifycenter/captcha'; frame.style.display = 'none'; document.body.append(frame); });
  assert.equal((await page.evaluate(extractPage)).requiresLogin, false, 'hidden verification workers must not block a complete note');
  await page.evaluate(() => { const frame = document.getElementById('captcha-fixture'); frame.style.display = 'block'; frame.style.position = 'fixed'; frame.style.top = '0'; frame.style.width = '300px'; frame.style.height = '200px'; });
  assert.equal((await page.evaluate(extractPage)).requiresLogin, true, 'an actual visible verification challenge must remain incomplete');
  const workspaceId = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222';
  const destination = { workspaceId, id, kind: 'database', dataSourceId: '33333333-3333-4333-8333-333333333333', workspaceName: 'openClaw', label: '资料收集' };
  const fixture = { settings: preferences({ destination, favorites: [destination, { ...destination, id: '44444444-4444-4444-8444-444444444444', label: '视频笔记', kind: 'page' }] }), active: 1, binaries: { downloader: true, ffmpeg: true }, jobs: [
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
      if (action === 'accounts') result = [{ id: 'douyin', name: '抖音', state: 'valid' }, { id: 'xiaohongshu', name: '小红书', state: 'valid' }, { id: 'bilibili', name: 'B站', state: 'missing' }, { id: 'youtube', name: 'YouTube', state: 'deferred' }, { id: 'tiktok', name: 'TikTok', state: 'unknown', message: '网络暂时不可用，可在收集时继续检查。' }, { id: 'x', name: 'X', state: 'deferred' }, { id: 'wechat', name: '微信视频号', state: 'link' }];
      if (action === 'video-hint') result = /\.(?:mp4|mov|mkv|webm|avi|flv)\b|bilibili\.com\/video|b23\.tv|youtube\.com|youtu\.be|douyin|xiaohongshu\.com\/explore/i.test(String(input.input || ''));
      if (action === 'create') {
        const page = { id: data.settings.destination.id };
        result = data.duplicate ? { jobs: [{ id: 'completed-fixture', status: 'completed', existing: true, page }] } : { jobs: [{ id: 'created-fixture' }] };
        if (data.duplicate) data.latestCompletion = { id: 'completed-fixture', page };
      }
      if (action === 'configure') Object.assign(data.settings, input.settings);
      if (action === 'pause-all' || action === 'resume-all') {
        if (window._delayQueueAction) await new Promise(resolve => { window._releaseQueueAction = resolve; });
        const states = action === 'pause-all' ? ['queued', 'reading', 'downloading', 'waiting_processing', 'processing', 'uploading', 'saving'] :
          ['failed', 'partial', 'paused', 'cancelled', 'interrupted', 'needs_login'];
        const jobs = data.jobs.filter(job => states.includes(job.status));
        for (const job of jobs) { job.status = action === 'pause-all' ? 'paused' : 'queued'; job.message = action === 'pause-all' ? '已暂停，进度保留。' : '等待按顺序处理…'; }
        data.active = data.jobs.filter(job => ['queued', 'waiting_processing'].includes(job.status)).length;
        result = { [action === 'pause-all' ? 'paused' : 'resumed']: jobs.length, message: action === 'pause-all' ? '已暂停全部任务。' : '已继续全部未完成任务。' };
      }
      if (action === 'local-collection') result = { path: 'C:\\资料\\已收集视频' };
      if (action === 'redistill') result = { id: 'redistilled-fixture', message: '已加入重新蒸馏队列。' };
      return { ok: true, result };
    }, getPathForFile: file => window._droppedFilePaths?.[file.name] || '', onShow: callback => { window._showCollection = callback; }, onChange: callback => { window._changeCollection = callback; } };
  }, fixture);
  await page.setViewportSize({ width: 580, height: 368 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(project, 'src/collection/ui/index.html')).href);
  await page.getByText('openClaw / 资料收集 ⌄', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'compact.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, 'compact window must not scroll at its default size');
  await page.evaluate(() => {
    window._initialQueueJobs = structuredClone(window._collectionFixture.jobs);
    window._collectionFixture.jobs.push({ ...structuredClone(window._collectionFixture.jobs[0]), id: 'failed-fixture', status: 'failed', message: '内容提取未完成', warnings: [] });
    window._delayQueueAction = true; window._changeCollection();
  });
  await page.waitForFunction(() => !document.getElementById('resume-all').disabled);
  await page.locator('#pause-all').click(); await page.waitForFunction(() => typeof window._releaseQueueAction === 'function');
  assert.equal(await page.locator('#pause-all').isDisabled(), true); assert.equal(await page.locator('#resume-all').isDisabled(), true);
  await page.evaluate(() => document.getElementById('pause-all').click());
  assert.equal((await page.evaluate(() => window._collectionCalls)).filter(call => call.action === 'pause-all').length, 1, 'double-click must not dispatch a second bulk operation');
  await page.evaluate(() => { window._delayQueueAction = false; window._releaseQueueAction(); });
  await page.waitForFunction(() => !document.getElementById('resume-all').disabled);
  assert.equal(await page.locator('#pause-all').isDisabled(), true);
  await page.locator('#resume-all').click(); await page.waitForFunction(() => !document.getElementById('pause-all').disabled);
  assert.equal(await page.locator('#resume-all').isDisabled(), true);
  const bulkCalls = (await page.evaluate(() => window._collectionCalls)).filter(call => ['pause-all', 'resume-all'].includes(call.action));
  assert.deepEqual(bulkCalls.map(call => [call.action, call.input]), [['pause-all', {}], ['resume-all', {}]]);
  assert.equal(await page.evaluate(() => window._collectionFixture.jobs.every(job => job.status === 'queued')), true, 'bulk continue must include paused and failed tasks');
  await page.screenshot({ path: path.join(output, 'queue-controls.png') });
  await page.evaluate(() => { window._collectionFixture.jobs = window._initialQueueJobs; window._collectionFixture.active = 1; window._changeCollection(); });
  const dropped = ['C:\\媒体资料\\拖入 视频.mp4', '/Users/me/Downloads/拖入 音频.m4a'];
  await page.locator('#links').fill('https://example.com/existing');
  const dragFiles = async (paths, type = 'drop', target = 'links') => page.evaluate(({ paths, type, target }) => {
    const transfer = new DataTransfer(); window._droppedFilePaths = {};
    paths.forEach((path, index) => { const name = 'dropped-' + index; transfer.items.add(new File(['fixture'], name)); window._droppedFilePaths[name] = path; });
    const event = new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true });
    (document.getElementById(target) || document.body).dispatchEvent(event); return event.defaultPrevented;
  }, { paths, type, target });
  assert.equal(await dragFiles(dropped, 'dragover'), true);
  assert.equal(await page.locator('#links').evaluate(node => node.classList.contains('file-dragover')), true);
  await page.screenshot({ path: path.join(output, 'file-dragover.png') });
  await page.locator('#links').evaluate(node => node.setSelectionRange(0, 0));
  assert.equal(await dragFiles(dropped), true);
  const appended = 'https://example.com/existing\n' + dropped.join('\n');
  assert.equal(await page.locator('#links').inputValue(), appended, 'Windows and Mac paths append after existing text, regardless of cursor position');
  assert.equal(await page.locator('#links').evaluate(node => node.classList.contains('file-dragover')), false);
  await page.screenshot({ path: path.join(output, 'file-paths.png') });
  await dragFiles([...dropped, dropped[0]]);
  assert.equal(await page.locator('#links').inputValue(), appended, 'Repeated file drops must not duplicate paths');
  await dragFiles(['']);
  assert.equal(await page.locator('#links').inputValue(), appended, 'An unavailable native path must preserve existing inputs');
  assert.ok((await page.locator('#message').textContent()).includes('无法读取'));
  await dragFiles(['/Users/me/bad\nname.mp4']);
  assert.equal(await page.locator('#links').inputValue(), appended, 'A filename containing a newline must not create multiple sources');
  assert.equal(await dragFiles(dropped, 'drop', 'outside'), true);
  assert.equal(await page.locator('#links').inputValue(), appended, 'File drops outside the source input must not navigate or add paths');
  assert.equal(await page.evaluate(() => {
    const dataTransfer = new DataTransfer(); dataTransfer.setData('text/plain', 'https://example.com/link');
    const event = new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true });
    document.getElementById('links').dispatchEvent(event); return event.defaultPrevented;
  }), false, 'Ordinary text/link dragging keeps the native input behavior');
  assert.equal((await page.evaluate(() => window._collectionCalls)).some(call => call.action === 'create'), false, 'Dropping a file must not start collection');
  await page.locator('#links').fill('');
  await page.locator('#collect').click(); await page.setViewportSize({ width: 620, height: 768 });
  await page.locator('#prompt-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('input[name="extraction-mode"]').count(), 3);
  assert.equal(await page.locator('#extraction-content').isChecked(), true);
  assert.equal(await page.locator('#prompt-dialog').evaluate(dialog => {
    document.getElementById('links').focus();
    return dialog.matches(':modal') && dialog.contains(document.activeElement);
  }), true, 'the extraction dialog must block focus outside the modal');
  await page.screenshot({ path: path.join(output, 'prompts.png') });
  await page.locator('#prompt-cancel').click(); await page.locator('#prompt-dialog').waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window._collectionCalls)).some(call => call.action === 'create'), false);
  await page.locator('#expand').click(); await page.setViewportSize({ width: 620, height: 768 });
  await page.locator('.destination-item').first().waitFor();
  await page.locator('#settings-tab-destination').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#settings-tab-options').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End'); assert.equal(await page.locator('#settings-tab-advanced').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home'); assert.equal(await page.locator('#settings-tab-destination').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.destination-item').first().getAttribute('aria-pressed'), 'true');
  await page.locator('.destination-item').nth(1).click();
  assert.equal(await page.locator('.destination-item').nth(1).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.destination-item').first().getAttribute('aria-pressed'), 'false');
  await page.locator('.favorite-chip').first().click();
  assert.equal(await page.locator('.destination-item').first().getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: path.join(output, 'expanded.png'), fullPage: true });
  for (const name of ['options', 'accounts', 'advanced']) {
    await page.locator('#settings-tab-' + name).click();
    assert.equal(await page.locator('[data-panel]:visible').count(), 1);
    await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
  }
  await page.locator('#settings-tab-options').click();
  assert.equal(await page.locator('#transcription-instances').count(), 0);
  assert.equal(await page.locator('#ocr-workers').inputValue(), String(fixture.settings.ocrWorkers));
  await page.locator('#ocr-workers').selectOption('4');
  await page.locator('#save-defaults').click();
  await page.waitForFunction(() => window._collectionCalls.some(call => call.action === 'configure' && !Object.hasOwn(call.input.settings, 'transcriptionInstances') && call.input.settings.ocrWorkers === 4));
  assert.equal(await page.locator('#dense-ocr').isChecked(), true, 'Dense OCR is enabled in processing options by default');
  await page.locator('label').filter({ has: page.locator('#vision') }).click();
  assert.equal(await page.locator('#vision').isChecked(), false, 'The entire option card must be clickable');
  await page.locator('#links').fill('https://example.com/article\nC:\\媒体资料\\本地视频.mp4'); await page.locator('#collect').click();
  await page.locator('#extraction-extra summary').click();
  await page.locator('#prompt-editor').fill('重点总结主播的口播风格');
  await page.locator('#prompt-save').click();
  const calls = await page.evaluate(() => window._collectionCalls);
  assert.equal(calls.find(c => c.action === 'create').input.options.vision, false);
  assert.equal(calls.find(c => c.action === 'create').input.options.denseOcr, true);
  assert.ok(calls.find(c => c.action === 'create').input.input.includes('本地视频.mp4'));
  assert.equal(calls.find(c => c.action === 'create').input.options.extraction.preference, '重点总结主播的口播风格');
  assert.equal((await page.evaluate(() => window._collectionFixture.settings.vision)), true);
  assert.deepEqual(errors, []);
  await page.locator('#dense-ocr').uncheck(); await page.locator('#save-defaults').click();
  await page.waitForFunction(() => window._collectionFixture.settings.denseOcr === false);
  await page.evaluate(() => { window._collectionFixture.duplicate = true; });
  await page.locator('#links').fill('https://example.com/article'); await page.locator('#collect').click();
  await page.locator('#extraction-style').check(); await page.locator('#extraction-extra summary').click();
  await page.locator('#extraction-preview').check(); await page.locator('#prompt-save').click();
  await page.getByText('此来源已保存，无需重复收集；点击下方打开 Notion。', { exact: true }).waitFor();
  await page.locator('#last-result').waitFor({ state: 'visible' });
  const styleCall = (await page.evaluate(() => window._collectionCalls)).filter(c => c.action === 'create').at(-1);
  assert.equal(styleCall.input.options.extraction.mode, 'style');
  assert.equal(styleCall.input.options.vision, true);
  assert.equal(styleCall.input.options.denseOcr, false);
  assert.equal(styleCall.input.preview, true);
  await page.locator('#links').fill('https://www.bilibili.com/video/BVfixture');
  await page.locator('#collect').click();
  await page.locator('#extraction-both').check();
  await page.locator('#extraction-style-help').waitFor({ state: 'visible' });
  await page.locator('#prompt-save').click();
  await page.waitForFunction(() => window._collectionCalls.some(call => call.action === 'create' && call.input.options.extraction.mode === 'both'));
  const bothCall = (await page.evaluate(() => window._collectionCalls)).find(call => call.action === 'create' && call.input.options.extraction.mode === 'both');
  assert.equal(bothCall.input.options.vision, true);
  await page.evaluate(() => {
    window._collectionFixture.latestCompletion = { id: 'split-fixture', pages: [
      { key: 'content', name: '内容理解' }, { key: 'style', name: '画面与视频制作拆解' }
    ] };
    window._changeCollection();
  });
  await page.locator('#last-report-links button').nth(1).click();
  await page.waitForFunction(() => window._collectionCalls.some(call => call.action === 'open-page' && call.input.id === 'split-fixture' && call.input.report === 'style'));
  assert.equal(await page.locator('#last-result').isHidden(), true);
  const createsBeforeRedistill = (await page.evaluate(() => window._collectionCalls)).filter(call => call.action === 'create').length;
  await page.locator('#redistill-local').click(); await page.locator('#redistill-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#redistill-source').textContent(), 'C:\\资料\\已收集视频');
  await page.locator('#redistill-preference').fill('字幕动效怎样迁移到我的视频');
  await page.screenshot({ path: path.join(output, 'redistill.png') });
  await page.locator('#redistill-start').click(); await page.locator('#redistill-dialog').waitFor({ state: 'hidden' });
  const redistill = (await page.evaluate(() => window._collectionCalls)).find(call => call.action === 'redistill');
  assert.equal(redistill.input.directory, 'C:\\资料\\已收集视频'); assert.equal(redistill.input.preference, '字幕动效怎样迁移到我的视频');
  assert.equal(redistill.input.id, undefined); assert.equal(redistill.input.visionEngine, 'deepseek');
  await page.evaluate(() => { Object.assign(window._collectionFixture.latestCompletion, { canRedistill: true, title: '已保留的视频' }); window._changeCollection(); });
  await page.locator('#last-redistill').click(); await page.locator('#redistill-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#redistill-source').textContent(), '已保留的视频');
  await page.locator('#redistill-cancel').click();
  await page.evaluate(() => {
    window._collectionFixture.jobs = [{ id: 'retained-video', title: '任务里的视频', url: 'https://example.com/video', status: 'completed', canRedistill: true,
      message: '已保存', options: { ...window._collectionFixture.settings, keepLocal: true }, warnings: [] }];
    document.getElementById('tasks-section').open = true; window._changeCollection();
  });
  await page.locator('.task-actions').getByText('按视频制作再蒸馏', { exact: true }).click();
  await page.locator('#redistill-start').click(); await page.locator('#redistill-dialog').waitFor({ state: 'hidden' });
  const fromTask = (await page.evaluate(() => window._collectionCalls)).filter(call => call.action === 'redistill').at(-1);
  assert.equal(fromTask.input.id, 'retained-video'); assert.equal(fromTask.input.directory, undefined);
  assert.equal((await page.evaluate(() => window._collectionCalls)).filter(call => call.action === 'create').length, createsBeforeRedistill, 'redistillation must not submit a new collection/download');
  assert.deepEqual(errors, []);
  await page.evaluate(() => {
    window._collectionFixture.jobs = [{ id: 'downloaded-waiting', title: '已经下载、等待整理的视频', url: 'https://example.com/waiting', status: 'waiting_processing',
      message: '素材下载完成，等待按顺序整理…', options: window._collectionFixture.settings, warnings: [] }];
    window._changeCollection();
  });
  await page.locator('.task .badge').getByText('等待整理', { exact: true }).waitFor();
  await page.locator('#status-filter').selectOption('active');
  assert.equal(await page.locator('.task').count(), 1);
  assert.equal(await page.locator('.task-actions').getByText('停止', { exact: true }).count(), 1);
  assert.equal(await page.locator('.task-actions').getByText('删除任务', { exact: true }).count(), 0);
  await page.screenshot({ path: path.join(output, 'waiting-processing.png') });
  await page.locator('#status-filter').selectOption('all');
  await page.evaluate(() => { window._collectionFixture.jobs = []; window._changeCollection(); });
  await page.locator('#tasks-section').waitFor({ state: 'hidden' });
  await page.locator('#queue-controls').waitFor({ state: 'hidden' });
  for (const width of [480, 580, 620, 820]) {
    await page.setViewportSize({ width, height: 818 });
    for (const name of ['destination', 'options', 'accounts', 'advanced']) {
      await page.locator('#settings-tab-' + name).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name + ' must fit the window at ' + width + 'px');
    }
  }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ extractor: { nodes: doc.nodes.length, fullTextCharacters: doc.nodes.at(-1).text.length, orderVerified: true }, renderer: { errors, droppedWindowsAndMacPaths: true, duplicateDropsIgnored: true, unavailablePathsPreserveInput: true, fileDropsDoNotSubmitOrNavigate: true, perTaskVisionOverride: true, editableTemplates: true, mixedLocalInput: true, emptyHistoryHidden: true, destinationAndFavoriteSelection: true, keyboardTabs: true, fullCardCheckboxes: true, localFolderAndTaskRedistillation: true, redistillationDoesNotRecollect: true, downloadedWaitingState: true, responsiveWidths: [480, 580, 620, 820] }, screenshots: ['compact.png', 'file-dragover.png', 'file-paths.png', 'prompts.png', 'expanded.png', 'options.png', 'accounts.png', 'advanced.png', 'redistill.png', 'waiting-processing.png'] }, null, 2));
  console.log('Collection browser extraction and UI checks passed. Screenshots: ' + output);
} finally { await browser.close(); }
