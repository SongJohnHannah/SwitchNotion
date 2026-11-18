import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url), { extractPage } = require('../src/collection/extract-page.cjs');
const { CollectionService } = require('../src/collection/service.cjs');
const { normalizeDocument, preferences } = require('../src/collection/model.cjs');
const { renderDocument } = require('../src/collection/notion.cjs');
const { chromium } = await import(pathToFileURL(process.env.COLLECTION_PLAYWRIGHT_PATH || path.join(os.homedir(), 'media-kit/node_modules/playwright-core/index.mjs')).href);
const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file => file && fs.existsSync(file));
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  let html = '', videoDocument;
  await page.route('**/*', route => route.request().isNavigationRequest() ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort());
  for (const [name, url, root, caption] of [
    ['Bilibili', 'https://www.bilibili.com/video/BVfixture', 'left-container', 'desc-info-text'],
    ['Douyin', 'https://www.douyin.com/video/123', 'video-detail', 'description'],
    ['YouTube', 'https://www.youtube.com/watch?v=fixture', 'primary', 'description-inline-text'],
    ['TikTok', 'https://www.tiktok.com/@fixture/video/123', 'video-detail', 'description']
  ]) {
    html = `<meta property="og:title" content="Video title"><div class="video-container-v1"><div id="${root}" class="${root}" data-e2e="video-detail"><h1>Video title</h1><div class="${caption}" id="${caption}" data-e2e="video-desc">Real video description</div><video></video><img width="400" height="100" src="https://example.com/ad-banner.jpg"><p>Unrelated promotional text</p></div></div>`;
    await page.goto(url); const doc = await page.evaluate(extractPage);
    if (name === 'Bilibili') videoDocument = doc;
    assert.equal(doc.nodes.filter(n => n.kind === 'video').length, 1, name + ': preserve the video');
    assert.equal(doc.nodes.filter(n => n.kind === 'image').length, 0, name + ': advertising images must not be included');
    assert.ok(!doc.nodes.some(n => n.text?.includes('Unrelated promotional text')), name + ': advertising text must not be included');
    assert.ok(doc.nodes.some(n => n.text?.includes('Real video description')), name + ': preserve video description');
  }
  html = '<meta property="og:type" content="video.other"><meta property="og:description" content="Video description"><main><video src="https://example.com/ad.mp4"></video><img width="600" height="400" src="https://example.com/ad.jpg"></main>';
  await page.goto('https://example.com/watch/123'); const genericVideo = await page.evaluate(extractPage);
  assert.deepEqual(genericVideo.nodes.map(n => n.kind), ['video', 'paragraph']);
  assert.equal(genericVideo.nodes[0].url, 'https://example.com/watch/123', 'Download the requested page instead of an arbitrary embedded video');
  html = '<article><a href="https://x.com/example/status/123">post</a><div data-testid="tweetText">Source post text</div><video></video><img width="600" height="400" src="https://example.com/ad.jpg"></article>';
  await page.goto('https://x.com/example/status/123'); const post = await page.evaluate(extractPage);
  assert.deepEqual(post.nodes.map(n => n.kind), ['video', 'paragraph']);
  assert.equal(post.nodes[0].url, 'https://x.com/example/status/123');
  html = `<title>(3) Example on X: “X article title” / X</title>
    <article data-testid="twitterArticleReadView">
      <a href="/example/article/123/media/1"><img width="600" height="240" src="https://pbs.twimg.com/media/cover?format=jpg&name=large"></a>
      <div data-testid="twitter-article-title">X article title</div>
      <div>Reply and like counts</div>
      <div data-testid="twitterArticleRichTextView">
        <div data-block="true"><div><span>One </span><a href="https://example.com/article/123/media/456"><span style="font-weight: bold;">linked phrase</span></a><span style="font-style: italic;"> in a paragraph.</span></div></div>
        <h2>First section</h2>
        <ol><li>First step</li><li>Second step</li></ol>
        <ul><li>One bullet</li></ul>
        <blockquote>A quote</blockquote>
        <div data-block="true"><a href="/example/article/123/media/2">
          <div style="width: 600px; height: 400px; background-image: url('https://pbs.twimg.com/media/inline?format=jpg&name=900x900');"></div>
          <img width="600" height="400" src="https://pbs.twimg.com/media/inline?format=jpg&name=900x900">
        </a></div>
        <div data-block="true"><span>Last paragraph</span></div>
      </div>
    </article>
    <article><h2>Unrelated reply</h2><img width="600" height="400" src="https://pbs.twimg.com/media/unrelated"></article>`;
  await page.goto('https://x.com/example/status/123');
  const xArticle = normalizeDocument(await page.evaluate(extractPage));
  assert.equal(xArticle.title, 'X article title');
  assert.equal(xArticle.incomplete, false);
  assert.deepEqual(xArticle.nodes.map(n => n.kind), ['image', 'paragraph', 'heading', 'list', 'list', 'list', 'quote', 'image', 'paragraph']);
  assert.deepEqual(xArticle.nodes.filter(n => n.kind === 'image').map(n => n.url), [
    'https://pbs.twimg.com/media/cover?format=jpg&name=orig',
    'https://pbs.twimg.com/media/inline?format=jpg&name=orig'
  ]);
  const xBlocks = renderDocument(xArticle, xArticle.nodes, {}).blocks;
  const xParagraph = xBlocks.find(block => block.paragraph?.rich_text[0].text.content === 'One ').paragraph.rich_text;
  assert.deepEqual(xParagraph[1].text, { content: 'linked phrase', link: { url: 'https://example.com/article/123/media/456' } });
  assert.equal(xParagraph[1].annotations.bold, true);
  assert.equal(xParagraph[2].annotations.italic, true);
  assert.equal(xBlocks.filter(block => block.type === 'numbered_list_item').length, 2);
  assert.equal(xBlocks.filter(block => block.type === 'bulleted_list_item').length, 1);
  html = html.replace(/<img width="600" height="240"[^>]+>/, '');
  await page.goto('https://x.com/example/status/123');
  const xArticleWithPlaceholder = await page.evaluate(extractPage);
  assert.equal(xArticleWithPlaceholder.incomplete, true, 'An unloaded cover must not pass as a complete article');
  assert.equal(xArticleWithPlaceholder.requiresLogin, false);
  html = '<article><h1>Article title</h1><p>First paragraph</p><img width="600" height="400" src="https://example.com/article-image.jpg"><p>Last paragraph</p></article><aside><img width="600" height="400" src="https://example.com/ad.jpg"></aside>';
  await page.goto('https://example.com/article'); const article = await page.evaluate(extractPage);
  assert.deepEqual(article.nodes.map(n => n.kind), ['heading', 'paragraph', 'image', 'paragraph']);
  assert.match(article.nodes.find(n => n.kind === 'image').url, /article-image/);
  // Exercise the actual collection queue and renderer; only network downloads
  // and the external Notion API are replaced with controlled local fixtures.
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'video-scope-check-'));
  let service;
  try {
    let current, plan; const downloaded = [];
    const browser = { inspect: async () => normalizeDocument(current) };
    const media = {
      acquire: async (node, directory) => { downloaded.push(node.kind); fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'media.bin'); fs.writeFileSync(file, 'fixture'); return { path: file, kind: node.kind, duration: 1, audio: true }; },
      prepareUpload: async asset => [{ path: asset.path, kind: asset.kind }]
    };
    const notion = { verifyTarget: async () => ({ limit: 1024 * 1024 }), upload: async (_file, _job, upload, save) => { Object.assign(upload, { id: randomUUID(), uploaded: true }); save(); },
      write: async (job, nodes, save) => { plan = renderDocument(job.document, nodes, job.resources, job.analyses, job.warnings, job.extraction); job.page = { id: randomUUID(), url: 'https://www.notion.so/test' }; save(); } };
    service = new CollectionService({ root, binaries: { directory: root, status: () => ({}) }, browser, media, notion });
    service.settings = preferences({ destination: { workspaceId: randomUUID(), id: randomUUID(), kind: 'page', label: 'fixture' }, keepLocal: false, keepHistory: true, transcribe: false, vision: false, extraction: { mode: 'off' } });
    for (const [doc, expectedDownloads, expectedSaved] of [[videoDocument, ['video'], ['video']], [article, ['image'], ['image']], [xArticle, ['image', 'image'], ['image', 'image']]]) {
      current = doc; downloaded.length = 0; plan = undefined;
      const options = doc === xArticle ? { keepLocal: true, outputDirectory: path.join(root, 'export') } : {};
      const created = await service.create({ input: doc.url, options });
      for (let i = 0; service.active && i < 400; i++) await new Promise(resolve => setTimeout(resolve, 10));
      const job = service.jobs.get(created.jobs[0].id);
      assert.equal(job.status, 'completed');
      assert.deepEqual(downloaded, expectedDownloads, 'Only the selected source media may be downloaded');
      assert.deepEqual(plan.blocks.filter(block => ['image', 'video'].includes(block.type)).map(block => block.type), expectedSaved);
      if (doc === xArticle) {
        const markdown = fs.readFileSync(path.join(job.exportDirectory, '原文.md'), 'utf8');
        assert.ok(markdown.includes('[**linked phrase**](<https://example.com/article/123/media/456>) *in a paragraph.*'));
        assert.ok(markdown.includes('\n1. First step\n\n1. Second step\n\n- One bullet\n\n> A quote\n'));
      }
    }
  } finally {
    service?.close();
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(parent));
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Video pages exclude surrounding ads; article text and images retain source order.');
} finally { await browser.close(); }
