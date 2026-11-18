import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cdpCommand, scrollPage } = require('../src/collection/browser.cjs');

test('a retained CDP command keeps focus emulation attached until extraction releases it', async () => {
  const opened = [];
  class Socket extends EventTarget {
    constructor() {
      super();
      opened.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(value) {
      const { id, method } = JSON.parse(value);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result: { method } }) })));
    }
    close() { this.closed = true; }
  }
  const command = vm.runInNewContext('(' + cdpCommand.toString() + ')', { WebSocket: Socket, setTimeout, clearTimeout });
  const focus = await command('ws://fixture', 'Emulation.setFocusEmulationEnabled', { enabled: true }, { keepOpen: true });
  assert.equal(opened[0].closed, undefined);
  assert.equal((await command('ws://fixture', 'Page.navigate')).method, 'Page.navigate');
  assert.equal(opened[1].closed, true);
  assert.equal(opened[0].closed, undefined);
  focus.close();
  assert.equal(opened[0].closed, true);
});

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
