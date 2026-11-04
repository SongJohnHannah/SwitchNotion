import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isLikelyVideoInput } = require('../src/collection/local-media.cjs');

test('video detection covers local files and common video platforms only', () => {
  for (const input of ['D:\\media\\a.mp4', '/Users/me/a.mov', 'https://b23.tv/abc', 'https://www.bilibili.com/video/BV1xx',
    'https://youtu.be/abc', 'https://www.youtube.com/shorts/abc', 'https://v.douyin.com/abc/', 'https://www.xiaohongshu.com/explore/abc',
    'https://example.com/clip.webm', 'https://channels.weixin.qq.com/x', 'https://x.com/user/status/123']) assert.equal(isLikelyVideoInput(input), true, input);
  for (const input of ['https://example.com/article', 'D:\\audio\\a.mp3', 'https://mp.weixin.qq.com/s/abc',
    'https://www.bilibili.com/read/cv1', '', 'https://example.com/']) assert.equal(isLikelyVideoInput(input), false, input);
});
