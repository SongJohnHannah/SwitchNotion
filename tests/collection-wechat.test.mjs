import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WechatChannel, isWechatShare } = require('../src/collection/wechat-channel.cjs');
const { CollectionBrowser, sites } = require('../src/collection/browser.cjs');
const { CollectionMedia } = require('../src/collection/media.cjs');
const SOURCE = 'https://weixin.qq.com/sph/fixture01';
function fixture() {
  const calls = []; let tick = 0;
  const signed = 'https://finder.video.qq.com/fixture.mp4?token=abc%2Bxyz&encfilekey=A%2FB&spec=original';
  const channel = new WechatChannel({ now: () => tick, requestJson: async request => {
    calls.push(request);
    return request.origin === 'https://yuanbao.tencent.com' ? { status: 200, data: { code: 0, data: { playable_url: 'https://channels.weixin.qq.com/finder-preview/pages/feed?token=fixture&eid=fixture-id' } } } :
      { status: 200, data: { errCode: 0, data: { authorInfo: { nickname: '测试作者' }, sceneInfo: { dynamicExportId: 'fixture-id' }, feedInfo: { videoUrl: signed, description: '原始正文\n第二段', coverUrl: 'https://wx.qpic.cn/fixture.jpg' } } }, media: { duration: 48.25, audio: true } };
  } });
  return { channel, calls, signed, expire: () => { tick = 100000; } };
}
test('sharing resolver preserves signed URLs and original text without Windows-specific dependencies', async () => {
  const f = fixture(), document = await f.channel.resolve(SOURCE);
  assert.equal(document.url, SOURCE); assert.equal(document.author, '测试作者'); assert.equal(document.incomplete, false);
  assert.deepEqual(document.nodes.map(node => node.kind), ['paragraph', 'paragraph', 'image', 'video']);
  const video = document.nodes.at(-1); assert.equal(video.url, f.signed); assert.equal(video.duration, 48.25); assert.equal(video.expectedAudio, true); assert.equal(video.platform, 'wechat'); assert.match(video.contentId, /^[a-f\d]{64}$/);
  assert.deepEqual(f.calls[0].body, { type: 'video_channel_url', url: SOURCE, scene: 1 });
  assert.deepEqual(f.calls[1].body, { baseReq: { generalToken: 'fixture' }, exportId: 'fixture-id' });
  assert.equal(Object.hasOwn(f.calls[0], 'headers'), false);
});
test('cached sharing results are cloned and expire before a stale signed URL is reused', async () => {
  const f = fixture(), first = await f.channel.resolve(SOURCE); first.nodes.length = 0;
  const second = await f.channel.resolve(SOURCE); assert.equal(second.nodes.length, 4); assert.equal(f.calls.length, 2);
  f.expire(); await f.channel.resolve(SOURCE); assert.equal(f.calls.length, 4);
});
test('a real HTTP 201 detail response with errCode zero is a successful video, not a login failure', async () => {
  const f = fixture(), original = f.channel.requestJson;
  f.channel.requestJson = async request => { const response = await original(request); if (request.origin === 'https://channels.weixin.qq.com') response.status = 201; return response; };
  const document = await f.channel.resolve(SOURCE);
  assert.equal(document.nodes.at(-1).url, f.signed); assert.equal(document.incomplete, false);
});
test('login, unavailable content and malicious parser redirects cannot become a completed source', async () => {
  for (const data of [
    { status: 401, data: {} },
    { status: 200, data: { code: 1 } },
    { status: 200, data: { code: 0, data: { playable_url: 'https://example.com/?token=private&eid=id' } } }
  ]) {
    const channel = new WechatChannel({ requestJson: async () => data });
    await assert.rejects(channel.resolve(SOURCE), /会话|解析|未知页面/);
  }
  const f = fixture(); f.channel.requestJson = async () => ({ status: 200, data: { errCode: 0, data: { feedInfo: { coverUrl: 'https://wx.qpic.cn/qr.jpg' } } } });
  await assert.rejects(f.channel.resolve('https://channels.weixin.qq.com/finder-preview/pages/feed?eid=id&token=fixture'), /没有返回可下载/);
});
test('browser transport only accepts the two fixed Tencent endpoints, and sources cannot spoof a WeChat host', async () => {
  for (const url of ['http://weixin.qq.com/sph/test', 'https://weixin.qq.com.evil.example/sph/test', 'https://user:pass@weixin.qq.com/sph/test', 'https://weixin.qq.com/other']) assert.equal(isWechatShare(url), false);
  const browser = new CollectionBrowser({});
  await assert.rejects(browser.wechatJson({ origin: 'https://example.com', entryUrl: 'https://example.com', endpoint: '/api/weixin/get_parse_result', body: {} }), /来源或接口/);
  assert.equal(sites.find(site => site.id === 'wechat').url, 'https://yuanbao.tencent.com/');
});
test('refreshing media refuses a different content identity before downloading anything', async () => {
  const media = new CollectionMedia({ browser: { wechat: { resolve: async () => ({ nodes: [{ kind: 'video', url: 'https://finder.video.qq.com/file.mp4', contentId: 'b'.repeat(64) }] }) } } });
  await assert.rejects(media.acquire({ kind: 'video', url: 'https://finder.video.qq.com/old.mp4', sourceUrl: SOURCE, platform: 'wechat', contentId: 'a'.repeat(64) }, '/unused'), /已改变/);
});
