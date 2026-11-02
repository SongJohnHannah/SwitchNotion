import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractPage } = require('../src/collection/extract-page.cjs');
const { chromium } = await import(pathToFileURL(process.env.COLLECTION_PLAYWRIGHT_PATH || path.join(os.homedir(), 'media-kit/node_modules/playwright-core/index.mjs')).href);
const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file => file && fs.existsSync(file));
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  await page.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<div class="video-container-v1"><div class="left-container"><h1>Source title</h1><p class="desc-info-text">Source description</p><video></video></div><div class="right-container"><div class="recommend-list-v1"><p>Unrelated recommendation</p><img src="https://example.com/recommendation.jpg"></div></div></div>' }));
  await page.goto('https://www.bilibili.com/video/BVfixture');
  const doc = await page.evaluate(extractPage);
  assert.ok(doc.nodes.some(n => n.text === 'Source description'));
  assert.ok(doc.nodes.some(n => n.kind === 'video'));
  assert.ok(!doc.nodes.some(n => n.text === 'Unrelated recommendation' || n.url?.includes('recommendation.jpg')), 'Recommendations outside the video content must not be saved');
  console.log('Bilibili video extraction excludes unrelated recommendations.');
} finally { await browser.close(); }
