import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractUrls, preferences, normalizeDocument, selectedNodes } = require('../src/collection/model.cjs');
const { privateAddress, assertPublicUrl } = require('../src/collection/network.cjs');
test('mixed selection preserves source order and global defaults do not change with a task override', () => {
  const doc = normalizeDocument({ title: '混合原文', url: 'https://example.com/article', nodes: [
    { kind: 'paragraph', text: 'before' }, { kind: 'image', url: '/original.png' }, { kind: 'paragraph', text: 'between' },
    { kind: 'video', url: 'https://example.com/full.mp4' }, { kind: 'audio', url: 'https://example.com/audio.mp3' }] });
  const defaults = preferences(), one = preferences({ vision: false, types: ['text', 'video'] }, defaults);
  assert.equal(defaults.vision, true); assert.equal(one.vision, false);
  assert.deepEqual(selectedNodes(doc, one).map(n => n.kind), ['paragraph', 'paragraph', 'video']);
  assert.deepEqual(selectedNodes(doc, defaults, [doc.nodes[3].id, doc.nodes[0].id]).map(n => n.kind), ['paragraph', 'video']);
  assert.equal(doc.nodes[1].url, 'https://example.com/original.png');
  assert.throws(() => selectedNodes(doc, defaults, ['invented']), /预览/);
});
test('share text extracts multiple URLs and destination/options reject unknown or unsafe data', () => {
  assert.deepEqual(extractUrls('[文章](https://example.com/a) https://example.com/wiki/Article_(topic)'), ['https://example.com/a', 'https://example.com/wiki/Article_(topic)']);
  assert.deepEqual(extractUrls('分享 https://v.douyin.com/abc/，\nhttps://example.com/a https://example.com/a'), ['https://v.douyin.com/abc/', 'https://example.com/a']);
  assert.throws(() => preferences({ arbitrary: true }));
  assert.throws(() => preferences({ shortcut: 'J' }));
  assert.throws(() => preferences({ destination: { workspaceId: 'no' } }));
  assert.throws(() => extractUrls('file:///secret'));
});

test('both supported desktop platforms have pinned native downloads', () => {
  const { assets } = require('../src/collection/binaries.cjs');
  for (const platform of ['win32-x64', 'darwin-arm64']) {
    assert.ok(assets[platform]);
    for (const [, version, filename, digest] of Object.values(assets[platform])) { assert.ok(version && filename); assert.match(digest, /^[a-f\d]{64}$/); }
  }
  assert.match(assets['darwin-arm64'].ffmpeg[2], /darwin-arm64/);
  assert.equal(preferences().vision, true);
});
test('network guard rejects local, private, mixed DNS and credential-bearing targets', async () => {
  for (const ip of ['127.0.0.1', '10.2.3.4', '172.16.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1']) assert.equal(privateAddress(ip), true);
  assert.equal(privateAddress('93.184.216.34'), false);
  await assert.rejects(assertPublicUrl('https://example.com', async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]), /内网/);
  await assert.rejects(assertPublicUrl('http://localhost/a'), /本机/);
  await assert.rejects(assertPublicUrl('https://user:password@example.com/a'), /账号密码/);
});
