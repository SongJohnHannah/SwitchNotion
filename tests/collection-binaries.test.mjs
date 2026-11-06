import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { CollectionBinaries, assets } = require('../src/collection/binaries.cjs');
function fixture(t, { installed = '2026.07.04', corrupt = false } = {}) {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-downloader-version-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(parent)); fs.rmSync(root, { recursive: true }); });
  const original = assets['win32-x64']['yt-dlp'], bytes = Buffer.from('verified-downloader-fixture');
  assets['win32-x64']['yt-dlp'] = [...original.slice(0, 3), createHash('sha256').update(bytes).digest('hex')];
  t.after(() => { assets['win32-x64']['yt-dlp'] = original; });
  const external = path.join(root, 'external-yt-dlp.exe'); fs.writeFileSync(external, 'existing-system-downloader');
  const downloads = [], binaries = new CollectionBinaries({ root, platform: 'win32', arch: 'x64', downloadImpl: async (url, file) => { downloads.push({ url, file }); fs.writeFileSync(file, corrupt ? 'unverified' : bytes); } });
  const local = path.join(binaries.directory, 'yt-dlp.exe');
  binaries.find = name => name === 'yt-dlp' ? (fs.existsSync(local) ? local : external) : path.join(root, 'external-ffmpeg.exe');
  binaries.version = async file => file === external ? installed : original[1];
  return { binaries, downloads, external, local, bytes };
}
test('preparing upgrades an older external yt-dlp into the private bin without changing the external installation', async t => {
  const f = fixture(t); await f.binaries.prepare();
  assert.equal(f.downloads.length, 1, 'existence alone must not mark an outdated YouTube downloader ready');
  assert.deepEqual(fs.readFileSync(f.local), f.bytes); assert.equal(fs.readFileSync(f.external, 'utf8'), 'existing-system-downloader');
  assert.equal(path.dirname(f.downloads[0].file), f.binaries.directory);
});
test('a current external downloader is reused without a network download', async t => {
  const f = fixture(t, { installed: '2026.10.26' }); await f.binaries.prepare(); assert.equal(f.downloads.length, 0); assert.equal(fs.existsSync(f.local), false);
});
test('media downloads use the verified standalone distribution even when an external pip executable is current', async t => {
  const f = fixture(t, { installed: '2026.10.26' }); await f.binaries.ensureDownloader();
  assert.equal(f.downloads.length, 1); assert.deepEqual(fs.readFileSync(f.local), f.bytes);
  await f.binaries.ensureDownloader(); assert.equal(f.downloads.length, 1);
});
test('an unverified downloader update is rejected and the existing installation remains intact', async t => {
  const f = fixture(t, { corrupt: true }); await assert.rejects(f.binaries.prepare(), /校验失败/);
  assert.equal(fs.readFileSync(f.external, 'utf8'), 'existing-system-downloader'); assert.equal(fs.existsSync(f.local), false);
});
