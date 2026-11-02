import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scrollPage } = require('../src/collection/browser.cjs');

async function checkScroll(url) {
  let scrolls = 0;
  const location = new URL(url);
  const context = { location, innerHeight: 1000, scrollY: 0, document: { body: { scrollHeight: 1000 } },
    window: { scrollBy: () => scrolls++, scrollTo() {} }, setTimeout: callback => callback() };
  await vm.runInNewContext('(' + scrollPage.toString() + ')()', context);
  return scrolls;
}

test('Bilibili video pages do not scroll indefinitely through recommendations', async () => {
  assert.equal(await checkScroll('https://www.bilibili.com/video/BV1xx411c7mD'), 0);
  assert.equal(await checkScroll('https://www.bilibili.com/video/av123'), 0);
});

test('article and unrelated pages retain their normal scrolling behavior', async () => {
  assert.ok(await checkScroll('https://www.bilibili.com/read/cv123') > 0);
  assert.ok(await checkScroll('https://notbilibili.com/video/BV1xx411c7mD') > 0);
  assert.ok(await checkScroll('https://example.com/article') > 0);
});
