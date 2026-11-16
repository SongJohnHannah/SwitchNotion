import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Stub network/process boundaries, while executing the shipped routing code.
function load(file, names, bindings) {
  const source = fs.readFileSync(new URL('../src/collection/media-kit/' + file, import.meta.url), 'utf8')
    .split('// Re-export everything')[0].replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
  return vm.runInNewContext(source + '\n;({' + names + '})', { fs, path, process: { env: {}, execPath: '/runtime/node', versions: { node: '22.0.0' } }, URL, Date, ...bindings });
}
function toolkit(overrides = {}) {
  const calls = [];
  const { MediaKit } = load('index.mjs', 'MediaKit', {
    fs: { promises: { mkdir: async () => {} } },
    validateNetworkTarget: () => null, validateResolvedHost: async () => null,
    ensureChromeRunning: async () => { calls.push('browser'); return true; },
    ytdlpDownload: async () => { calls.push('ytdlp'); return { ok: true, files: [{ type: 'video', path: '/video.mp4' }] }; },
    cdpScrape: async () => { calls.push('scrape'); return { ok: true, text: '…更多', files: [{ type: 'image', path: '/thumbnail.jpg' }] }; },
    isChineseVideoDomain: () => false, isCdpFirstDomain: () => false, logWarn() {}, ...overrides
  });
  return { kit: new MediaKit({ browserBaseUrl: 'http://127.0.0.1:19333' }), calls };
}
test('public video downloads reach yt-dlp before browser scraping or login access', async () => {
  const { kit, calls } = toolkit();
  const result = await kit.download({ url: 'https://www.youtube.com/watch?v=fixture', mediaType: 'video' });
  assert.equal(result.files.some(file => file.type === 'video'), true, 'thumbnail or page text cannot fulfill a video download');
  assert.equal(calls.join(','), 'ytdlp', 'a successful public download needs no browser session');
});
test('other public video platforms also complete without browser access', async () => {
  for (const domains of [{ isChineseVideoDomain: () => true }, { isCdpFirstDomain: () => true }]) {
    const { kit, calls } = toolkit(domains);
    assert.equal((await kit.download({ url: 'https://video.example/watch', mediaType: 'video' })).ok, true);
    assert.equal(calls.join(','), 'ytdlp');
  }
});
test('browser fallback with only text or thumbnails does not count as video success and keeps the downloader error', async () => {
  const { kit } = toolkit({ ytdlpDownload: async () => ({ ok: false, files: [], error: 'HTTP Error 502: Bad Gateway' }) });
  const result = await kit.download({ url: 'https://video.example/watch', mediaType: 'video' });
  assert.equal(result.ok, false);
  assert.match(result.error, /502/);
  assert.doesNotMatch(result.error, /登录/);
});
test('an unavailable browser cannot hide the original downloader error', async () => {
  const { kit } = toolkit({ ytdlpDownload: async () => ({ ok: false, files: [], error: 'HTTP Error 502' }), ensureChromeRunning: async () => { throw Error('browser unavailable'); } });
  assert.match((await kit.download({ url: 'https://video.example/watch', mediaType: 'video' })).error, /502/);
});
function downloader({ fail = false, retryThrows = false, reloads = 0 } = {}) {
  const calls = [], removed = [], argumentsSeen = [];
  const { ytdlpDownload } = load('ytdlp-tool.mjs', 'ytdlpDownload', {
    fs: { existsSync: () => true, unlinkSync: file => removed.push(file) },
    promisify: () => async (_bin, args) => {
      calls.push(args.includes('--cookies') ? 'authenticated' : 'anonymous');
      argumentsSeen.push(args);
      if (calls.filter(call => call === 'anonymous').length <= reloads) throw Object.assign(Error('download failed'), { stderr: 'ERROR: [youtube] S7CrlFLAmEA: The page needs to be reloaded.' });
      if (fail || (retryThrows && calls.length === 1)) throw Object.assign(Error('download failed'), { stderr: 'ERROR: Sign in to confirm your age' });
      if (retryThrows) throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT' });
      return { stdout: '/video.mp4', stderr: '' };
    }, execFile() {}, resolveBin: () => '/yt-dlp', safeFilename: value => value,
    getCookiesFile: async () => { calls.push('cookies'); return '/temporary-cookies.txt'; },
    compressIfNeeded: async () => {}, validateNetworkTarget: () => null, validateResolvedHost: async () => null, logWarn() {}
  });
  return { run: () => ytdlpDownload({ url: 'https://www.youtube.com/watch?v=fixture', title: 'source' }, { browserBaseUrl: 'http://127.0.0.1:19333' }), calls, removed, argumentsSeen };
}
test('yt-dlp downloads public content anonymously before accessing saved cookies', async () => {
  const f = downloader(); assert.equal((await f.run()).ok, true); assert.equal(f.calls.join(','), 'anonymous');
});

test('YouTube downloads enable the bundled Node runtime and isolate external yt-dlp configuration', async () => {
  const f = downloader(); await f.run(); const args = f.argumentsSeen[0];
  assert.ok(args.includes('--ignore-config'));
  assert.equal(args[args.indexOf('--js-runtimes') + 1], 'node:/runtime/node');
});

test('a YouTube reload response gets one fresh anonymous extraction before any login fallback', async () => {
  const f = downloader({ reloads: 1 }); assert.equal((await f.run()).ok, true);
  assert.equal(f.calls.join(','), 'anonymous,anonymous');
  assert.equal(f.argumentsSeen[1][f.argumentsSeen[1].indexOf('--extractor-args') + 1], 'youtube:player_client=default,web_embedded');
});
test('repeated YouTube reload responses stop after the bounded public fallback and do not ask for cookies', async () => {
  const f = downloader({ reloads: 10 }), result = await f.run();
  assert.equal(result.ok, false); assert.equal(f.calls.join(','), 'anonymous,anonymous');
  assert.equal(result.attempts.length, 2); assert.match(result.error, /公开下载重试/);
});
test('an explicit access restriction retries with the saved session and always removes temporary cookies', async () => {
  const f = downloader({ fail: true }); assert.equal((await f.run()).ok, false);
  assert.equal(f.calls.join(','), 'anonymous,cookies,authenticated'); assert.equal(f.removed.length, 1);
  const timeout = downloader({ retryThrows: true }); await assert.rejects(timeout.run(), /ETIMEDOUT/); assert.equal(timeout.removed.length, 1);
});

function interceptedVideo({ late = false } = {}) {
  const file = fs.readFileSync(new URL('../src/collection/media-kit/cdp-client.mjs', import.meta.url), 'utf8');
  const source = file.slice(file.indexOf('export async function cdpExtractAndDownloadVideo'), file.indexOf('// ── File download through HTTP proxy')).replace('export async function', 'async function');
  const events = [], downloads = []; let polls = 0;
  class Socket {
    constructor() { this.listeners = new Map(); queueMicrotask(() => this.emit('open', {})); }
    addEventListener(name, handler) { this.listeners.set(name, [...this.listeners.get(name) || [], handler]); }
    emit(name, value) { for (const handler of this.listeners.get(name) || []) handler(value); }
    close() {}
    send(raw) {
      const request = JSON.parse(raw); events.push(request.method);
      let result = {};
      if (request.method === 'Runtime.evaluate') {
        if (request.params.expression.includes("var title = ''")) result = { result: { value: '目标视频' } };
        else result = { result: { value: JSON.stringify({ video: ++polls === 1 && late ? [] : ['https://douyinvod.example/target.mp4'], audio: [] }) } };
      }
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: request.id, result }) }));
    }
  }
  const capture = vm.runInNewContext(source + '\ncdpExtractAndDownloadVideo', {
    WebSocket: Socket, path, fs: { promises: { mkdir: async () => {} } },
    cdpOpenTab: async (_base, url) => { events.push('open:' + url); return { tabId: 'fixture', wsUrl: 'ws://fixture' }; },
    cdpCloseTab: async () => {}, keepBrowserAlive: async () => {}, logWarn() {}, safeFilename: value => value,
    isVideoUrl: () => false, isAudioUrl: () => false,
    downloadThroughProxy: async url => { downloads.push(url); return true; },
    setTimeout: (fn, delay) => setTimeout(fn, delay >= 25000 ? 1000 : 0), clearTimeout,
  });
  return { run: () => capture('http://127.0.0.1:19333', 'https://www.douyin.com/video/123456', '/out', 'fallback'), events, downloads, polls: () => polls };
}

test('CDP video capture listens before navigation and reads standard response results for early media requests', async () => {
  const f = interceptedVideo(), result = await f.run();
  assert.equal(result.ok, true); assert.equal(path.basename(result.filePath), '目标视频.mp4');
  assert.equal(f.events[0], 'open:about:blank');
  assert.ok(f.events.indexOf('Network.enable') < f.events.indexOf('Page.navigate'));
  assert.deepEqual(f.downloads, ['https://douyinvod.example/target.mp4']);
});

test('CDP video capture keeps waiting when a player has not exposed its media by the first poll', async () => {
  const f = interceptedVideo({ late: true }), result = await f.run();
  assert.equal(result.ok, true); assert.equal(f.polls(), 2);
});
