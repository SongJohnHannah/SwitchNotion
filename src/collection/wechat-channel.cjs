// Sharing-link flow adapted from nobiyou/wx_channel v5.6.9 (MIT),
// internal/services/sph_service.go. See wechat-NOTICE.md.
// Transport is injected: no Windows driver, certificate installation or Go/CGO.
const { normalizeDocument, hash, publicUrl } = require('./model.cjs');
function isWechatShare(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'weixin.qq.com' && /^\/sph\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) ||
       url.hostname === 'channels.weixin.qq.com' && /^\/finder-preview\/pages\/(?:sph|feed)$/.test(url.pathname));
  } catch { return false; }
}
function failure(message, login = false) {
  const error = Error(message); if (login) error.code = 'WECHAT_LOGIN_REQUIRED'; return error;
}
function httpsUrl(value) {
  const url = new URL(publicUrl(value));
  if (url.protocol !== 'https:') throw failure('微信返回的媒体地址不是有效 HTTPS 链接。');
  // Preserve the signed URL, including its original query order/encoding.
  return url.href;
}
const successful = status => Number.isInteger(status) && status >= 200 && status < 300;
class WechatChannel {
  constructor({ requestJson, now = Date.now }) { this.requestJson = requestJson; this.now = now; this.cache = new Map(); }
  async resolve(source, { signal, progress = () => {}, refresh = false } = {}) {
    if (!isWechatShare(source)) throw failure('请使用有效的微信视频号分享链接。');
    source = publicUrl(source); signal?.throwIfAborted();
    const prior = this.cache.get(source);
    if (!refresh && prior && this.now() - prior.at < 90000) return structuredClone(prior.document);
    progress('正在解析微信视频号分享链接…');
    let playable = new URL(source), exportId = playable.searchParams.get('eid'), token = playable.searchParams.get('token');
    let parsed = {};
    if (!exportId || !token) {
      const response = await this.requestJson({ origin: 'https://yuanbao.tencent.com', entryUrl: 'https://yuanbao.tencent.com/',
        endpoint: '/api/weixin/get_parse_result', body: { type: 'video_channel_url', url: source, scene: 1 } }, { signal });
      if ([401, 403].includes(response.status) || [401, 403].includes(Number(response.data?.code))) throw failure('此分享链接解析需要腾讯元宝授权。请查看“平台账号 → 微信视频号 → 使用说明”，按需登录腾讯元宝后重试；元宝并非视频号登录页。', true);
      if (!successful(response.status) || response.data?.code !== 0 || !response.data.data?.playable_url) throw failure('微信分享链接尚未解析成功，请确认分享仍有效并重试。');
      parsed = response.data.data; playable = new URL(httpsUrl(parsed.playable_url));
      if (playable.hostname !== 'channels.weixin.qq.com' || !/^\/finder-preview\/pages\/(?:feed|sph)$/.test(playable.pathname)) throw failure('微信解析返回了未知页面，未继续访问。');
      exportId = playable.searchParams.get('eid') || parsed.wx_export_id; token = playable.searchParams.get('token');
    }
    if (!exportId || !token || exportId.length > 8192 || token.length > 8192) throw failure('微信分享链接没有返回完整的视频访问参数。');
    const response = await this.requestJson({ origin: 'https://channels.weixin.qq.com', entryUrl: playable.href,
      endpoint: '/finder-preview/api/feed/get_feed_info', body: { baseReq: { generalToken: token }, exportId } }, { signal });
    if ([401, 403].includes(response.status)) throw failure('此视频号链接的网页访问已失效或无权访问。请在微信中确认可见并重新复制分享链接；仅微信内可看的内容不保证能收集。', true);
    const data = response.data, info = data?.data?.feedInfo, author = data?.data?.authorInfo;
    if (!successful(response.status) || data?.errCode !== 0 || !info) throw failure('微信没有返回可访问的视频详情，请检查链接和账号权限。');
    const videoUrl = info.originVideoUrl || info.fullUrl || info.videoUrl || info.h264VideoInfo?.videoUrl || info.h265VideoInfo?.videoUrl;
    if (!videoUrl) throw failure('此微信分享没有返回可下载的视频文件，未将预览或二维码页当作原视频。');
    const description = String(info.description || parsed.desc || '').trim();
    const nodes = description.split(/\n+/).filter(Boolean).map(text => ({ kind: 'paragraph', text }));
    const cover = info.coverUrl || parsed.cover_url;
    if (cover) nodes.push({ kind: 'image', url: httpsUrl(cover), caption: '视频封面' });
    const contentId = hash(String(data.data.sceneInfo?.dynamicExportId || exportId));
    nodes.push({ kind: 'video', url: httpsUrl(videoUrl), platform: 'wechat', direct: true, contentId,
      ...(Number.isFinite(response.media?.duration) && response.media.duration > 0 ? { duration: response.media.duration } : {}),
      ...(response.media?.audio === true ? { expectedAudio: true } : {}) });
    const document = normalizeDocument({ url: source, title: description.split('\n')[0] || (author?.nickname || parsed.author || '微信视频号') + '的视频',
      author: author?.nickname || parsed.author || '', nodes });
    this.cache.set(source, { at: this.now(), document });
    while (this.cache.size > 30) this.cache.delete(this.cache.keys().next().value);
    return structuredClone(document);
  }
}
module.exports = { WechatChannel, isWechatShare };
