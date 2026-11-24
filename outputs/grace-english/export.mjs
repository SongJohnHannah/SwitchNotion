import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = path.dirname(fileURLToPath(import.meta.url));
const imageDir = path.join(dir, 'images');
await fs.mkdir(imageDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(pathToFileURL(path.join(dir, 'index.html')).href + '?export=1', { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const slides = await page.locator('.paper').evaluateAll(elements => elements.map(element => ({file:element.dataset.file, title:element.dataset.title})));
  const checks = [];
  for (let index = 0; index < slides.length; index++) {
    await page.evaluate(index => window.graceDeck.showPage(index), index);
    const slide = page.locator('.paper.active');
    const outOfBounds = await slide.evaluate(element => {
      const boundary = element.getBoundingClientRect();
      return [...element.querySelectorAll('h1,h2,p,.brand,.footer,.stamp,.grammar-chips,.diagnosis-option,.definition-equation,.comment-prompt')]
        .map(child => ({text:child.textContent.trim().slice(0, 44), rect:child.getBoundingClientRect()}))
        .filter(({rect}) => rect.left < boundary.left - 1 || rect.right > boundary.right + 1 || rect.bottom > boundary.bottom - 1 || rect.top < boundary.top - 1)
        .map(({text}) => text);
    });
    if (outOfBounds.length) throw new Error(`Out-of-bounds content on page ${index + 1}: ${outOfBounds.join(', ')}`);
    await slide.screenshot({ path: path.join(imageDir, slides[index].file), animations: 'disabled' });
    checks.push({ page:index + 1, title:slides[index].title, outOfBounds });
  }
  await page.evaluate(() => window.graceDeck.showPage(3));
  await page.locator('[data-diagnosis="1"]').click();
  if (!((await page.locator('#diagnosis-result').innerText()).includes('评分要求'))) throw new Error('Diagnosis B did not update.');
  await page.locator('[data-diagnosis="2"]').click();
  if (!((await page.locator('#diagnosis-result').innerText()).includes('固定检查顺序'))) throw new Error('Diagnosis C did not update.');
  await page.evaluate(() => window.graceDeck.showPage(4));
  await page.locator('[data-preset="60"]').click();
  if (await page.locator('#ability-percent').innerText() !== '60') throw new Error('Allocation percentage did not update.');
  if (!((await page.locator('#allocation-minutes').innerText()).includes('36 分钟'))) throw new Error('Allocation minutes did not update.');
  await page.locator('#allocation-range').fill('70');
  if (await page.locator('#exam-percent').innerText() !== '30') throw new Error('Allocation slider did not update.');
  await page.evaluate(() => window.graceDeck.showPage(7));
  const checkbox = page.locator('.check-item').nth(2);
  await checkbox.click();
  if (await checkbox.getAttribute('aria-pressed') !== 'true') throw new Error('Checklist did not update.');
  await page.keyboard.press('ArrowLeft');
  if (await page.evaluate(() => window.graceDeck.currentPage) !== 7) throw new Error('Keyboard navigation did not update.');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height:900 });
    await page.goto(pathToFileURL(path.join(dir, 'index.html')).href, {waitUntil:'load'});
    const fit = await page.evaluate(() => ({width:innerWidth,documentWidth:document.documentElement.scrollWidth,poster:document.querySelector('.viewport').getBoundingClientRect().width}));
    if (fit.documentWidth > width + 1 || fit.poster > width) throw new Error(`Horizontal overflow at ${width}px.`);
    if (width === 390) await page.screenshot({path:path.join(dir,'mobile-preview.png'),fullPage:true});
    checks.push({ viewport:width, fit });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.writeFile(path.join(dir, 'validation.json'), JSON.stringify({ imageSize:[1080,1920], pages:slides.length, interactions:'passed', runtimeErrors:errors, checks }, null, 2));
  console.log(JSON.stringify({ pages:slides.length, imageSize:'1080 × 1920', interactions:'passed', checks }, null, 2));
} finally {
  await browser.close();
}
