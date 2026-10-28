// Serialized into the collection browser. Read only the note matching this URL;
// feed cards, comments and other entries in the hydration state are not sources.
function extractXiaohongshuPage() {
  const nodes = [], warnings = [], url = location.href;
  const visible = el => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const id = location.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f\d]{24})(?:\/|$)/i)?.[1];
  const root = document.querySelector('#noteContainer,.note-container');
  const note = id && window.__INITIAL_STATE__?.note?.noteDetailMap?.[id]?.note;
  const login = [...document.querySelectorAll('.login-container,.login-modal,.login-mask')].some(visible);
  const challenge = /验证码|安全验证/.test(document.title) || [...document.querySelectorAll('iframe')].some(f => /captcha|verifycenter/.test(f.src));
  const unavailable = location.pathname === '/404' || /你访问的页面不见了/.test(document.title);
  const result = () => ({ title: note?.title || document.querySelector('#detail-title')?.innerText || document.title,
    author: note?.user?.nickname || '', url, nodes, requiresLogin: login || challenge, incomplete: warnings.length > 0, warnings });
  if (login) warnings.push('小红书要求重新登录，请在收集浏览器中完成登录后重试。');
  if (challenge) warnings.push('小红书要求人工验证，请在收集浏览器中完成验证后重试。');
  if (unavailable) warnings.push('小红书笔记暂时无法浏览，请使用包含完整分享参数的链接并确认账号可访问。');
  if (!id || !root || !note || note.noteId !== id || !['normal', 'video'].includes(note.type)) {
    warnings.push('尚未取得当前小红书笔记的完整内容，未将首页、推荐或登录提示当作原文。');
    return result();
  }
  // Signed rendition URLs must remain intact. WB_DFT is the full web image;
  // WB_PRV and the duplicated/lazy carousel DOM are not a complete image list.
  function cdnUrl(value) {
    try { const u = new URL(value, location.href); if (!/^https?:$/.test(u.protocol) || !/(^|\.)xhscdn\.com$/i.test(u.hostname) || u.username || u.password) return ''; u.protocol = 'https:'; return u.href; } catch { return ''; }
  }
  const imageUrl = image => [image?.urlDefault, ...(image?.infoList || []).filter(i => i.imageScene === 'WB_DFT').map(i => i.url), image?.url].map(cdnUrl).find(Boolean) || '';
  function videoNode(media, fallback = false) {
    const streams = Object.values(media?.stream || {}).flat().filter(s => s && cdnUrl(s.masterUrl) && /^(?:mp4|mov|webm)$/i.test(s.format || 'mp4'));
    const withAudio = streams.filter(s => Number(s.audioChannels) > 0 || Number(s.audioDuration) > 0);
    const candidates = withAudio.length ? withAudio : streams;
    candidates.sort((a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height) || Number(b.avgBitrate) - Number(a.avgBitrate));
    const stream = candidates[0];
    if (!stream && !fallback) return null;
    const video = root.querySelector('video');
    return { kind: 'video', platform: 'xiaohongshu', url: stream ? cdnUrl(stream.masterUrl) : url,
      ...(stream ? { direct: true } : {}), duration: stream ? Number(stream.duration) / 1000 : Number(media?.video?.duration) || (Number.isFinite(video?.duration) ? video.duration : undefined),
      expectedAudio: !!withAudio.length || video?.webkitAudioDecodedByteCount > 0 };
  }
  const images = Array.isArray(note.imageList) ? note.imageList : [], mediaNodes = [];
  if (note.type === 'video') {
    mediaNodes.push(videoNode(note.video?.media, true));
  } else {
    if (!images.length) warnings.push('当前图文笔记没有完整图片列表，请重新读取后再保存。');
    for (const image of images) {
      const source = imageUrl(image);
      if (source) mediaNodes.push({ kind: 'image', url: source });
      else warnings.push('笔记中有图片尚未取得完整地址，未用缩略图代替。');
      if (image.livePhoto) {
        const live = videoNode({ stream: image.stream });
        if (live) mediaNodes.push(live); else warnings.push('笔记包含尚未取得完整音视频的实况图片。');
      }
    }
  }
  const title = root.querySelector('#detail-title'), desc = root.querySelector('#detail-desc');
  const original = String(note.desc || '');
  const compact = value => value.replace(/\[话题\]#?/g, '').replace(/\s/g, '');
  const textNodes = [];
  function rich(el) {
    const spans = [];
    function visit(n, href) {
      if (n.nodeType === 3) { if (n.textContent) spans.push({ text: n.textContent, ...(href ? { href } : {}) }); return; }
      if (n.nodeType !== 1 || n.matches('script,style,button') || !visible(n)) return;
      if (n.tagName === 'BR') { spans.push({ text: '\n' }); return; }
      if (n.tagName === 'IMG') { if (n.alt) spans.push({ text: n.alt }); return; }
      const link = n.tagName === 'A' && /^https?:/.test(n.href) ? n.href : href;
      for (const child of n.childNodes) visit(child, link);
    }
    visit(el); return spans;
  }
  function walk(el) {
    if (el.nodeType === 3) { if (el.textContent.trim()) textNodes.push({ kind: 'paragraph', text: el.textContent }); return; }
    if (el.nodeType !== 1 || el.matches('script,style,button')) return;
    if (el.tagName === 'IMG' && !/emoji|avatar|icon/i.test(String(el.className))) {
      if (!visible(el)) return;
      const source = cdnUrl(el.getAttribute('data-original') || el.currentSrc || el.src);
      if (source) textNodes.push({ kind: 'image', url: source, caption: el.alt || '' }); return;
    }
    if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
      const source = cdnUrl(el.currentSrc || el.src || el.querySelector('source')?.src);
      if (source) textNodes.push({ kind: el.tagName.toLowerCase(), url: source, direct: true }); return;
    }
    if (!visible(el)) return;
    if (!el.querySelector('img:not(.emoji),video,audio,p,blockquote,ul,ol')) {
      const spans = rich(el), text = spans.map(s => s.text).join('');
      if (text.trim()) textNodes.push({ kind: el.tagName === 'BLOCKQUOTE' ? 'quote' : el.tagName === 'LI' ? 'list' : 'paragraph', text, spans }); return;
    }
    for (const child of el.childNodes) walk(child);
  }
  if (desc && compact(desc.innerText || '') === compact(original)) walk(desc);
  else for (const text of original.split(/\n\s*\n/)) if (text.trim()) textNodes.push({ kind: 'paragraph', text });
  // Anchor the complete carousel at its original DOM position. Inline images
  // in the description keep their relative positions among the paragraphs.
  const mediaAnchor = root.querySelector('.media-container,.note-slider');
  if (mediaNodes.length && !mediaAnchor) warnings.push('小红书媒体排版尚未确认，请重新读取原文。');
  const anchors = [{ el: mediaAnchor, items: mediaNodes },
    { el: title, items: note.title ? [{ kind: 'heading', level: 1, text: note.title }] : [] }, { el: desc, items: textNodes }];
  anchors.sort((a, b) => a.el && b.el ? a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1 : a.el ? -1 : b.el ? 1 : 0);
  for (const anchor of anchors) nodes.push(...anchor.items);
  if (original && !textNodes.length) warnings.push('小红书正文尚未完整读取。');
  return result();
}
module.exports = { extractXiaohongshuPage };
