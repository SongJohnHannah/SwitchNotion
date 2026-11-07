import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../src/collection/media.cjs', import.meta.url));
const { downloadError } = require('./download-error.cjs');

test('downloader errors distinguish network, verification and access restrictions without inventing missing logins', () => {
  for (const detail of ['HTTP Error 502: Bad Gateway', 'HTTP Error 403: Forbidden', 'Requested format is not available', 'yt-dlp not found']) {
    const error = downloadError({ error: detail }); assert.match(error.message, /媒体下载失败/); assert.ok(error.message.includes(detail)); assert.doesNotMatch(error.message, /登录/);
  }
  assert.match(downloadError({ error: "Sign in to confirm you're not a bot" }).message, /完成原站验证/);
  assert.match(downloadError({ error: 'This is a private video. Sign in to view' }).message, /账号是否有权限/);
  const text = downloadError({ error: 'HTTP 403 https://example.com/video?token=private\nCookie: session=private\nAuthorization: Bearer private' }).message;
  assert.doesNotMatch(text, /token=private|session=private|Bearer private/);
});

test('media acquisition preserves the worker failure instead of replacing it with a login prompt', async t => {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'test-download-error-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(parent)); fs.rmSync(directory, { recursive: true }); });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../src/collection/media.cjs', import.meta.url), 'utf8'), {
    module, __dirname: path.resolve(import.meta.dirname, '../src/collection'), URL, fetch: () => {}, process: { platform: 'win32' },
    require: name => name === './process.cjs' ? { nodeExecutable: () => '/node', workerEnvironment: () => ({}),
      run: async () => ({ stdout: JSON.stringify({ ok: false, files: [], error: 'HTTP Error 502: Bad Gateway' }) }) } : require(name)
  });
  const media = new module.exports.CollectionMedia({ root: parent, binaries: { directory: parent }, browser: { downloadConfig: async () => ({}) } });
  await assert.rejects(media.acquire({ kind: 'video', url: 'https://www.youtube.com/watch?v=fixture' }, directory), error => /HTTP Error 502/.test(error.message) && !/登录/.test(error.message));
});
