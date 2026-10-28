// Runs inside a page. Keep this function self-contained: it is serialized over
// CDP, and page content is data rather than instructions for the application.
function extractPage() {
  const visible = el => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && !el.hidden; };
  const noise = 'nav,footer,aside,script,style,noscript,button,form,[role="navigation"],[role="banner"],[aria-hidden="true"],.advertisement,.ads,.recommend-list,#comments,#secondary,.reply-list,.recommend-panel';
  const host = location.hostname;
  const isX = /(^|\.)(x|twitter)\.com$/.test(host);
  const platform = /douyin\.com$/.test(host) ? 'douyin' : /bilibili\.com$/.test(host) ? 'bilibili' : /youtu(?:be\.com|\.be)$/.test(host) ? 'youtube' : /tiktok\.com$/.test(host) ? 'tiktok' : '';
  const candidates = [...document.querySelectorAll(isX ? '[data-testid="twitterArticleRichTextView"],article' : 'article,[role="article"],.article-content,.post-content,.entry-content,#js_content,main,[role="main"]')].filter(visible);
  const score = el => (el.innerText || '').length - [...el.querySelectorAll('nav,aside')].reduce((n, e) => n + (e.innerText || '').length, 0);
  const articles = candidates.filter(el => el.matches('article,[role="article"],.article-content,.post-content,.entry-content,#js_content'));
  let root = (articles.length ? articles : candidates).sort((a, b) => score(b) - score(a))[0] || document.body;
  if (platform) root = document.querySelector(platform === 'youtube' ? '#primary' : platform === 'bilibili' ? '.left-container,.video-container-v1,main' : '[data-e2e="video-detail"],main') || root;
  if (isX) {
    const article = document.querySelector('[data-testid="twitterArticleRichTextView"]');
    const status = location.pathname.match(/\/status\/(\d+)/)?.[1];
    root = article || (status && [...document.querySelectorAll('article')].find(el => [...el.querySelectorAll('a[href]')].some(a => new URL(a.href).pathname.endsWith('/status/' + status)))) || root;
  }
  const nodes = [], warnings = [];
  function spans(el) {
    const result = [];
    function visit(n, href) {
      if (n.nodeType === 3) { if (n.textContent) result.push({ text: n.textContent, ...(href ? { href } : {}) }); return; }
      if (n.nodeType !== 1 || n.matches(noise) || !visible(n)) return;
      if (n.tagName === 'BR') { result.push({ text: '\n' }); return; }
      const next = n.tagName === 'A' && /^https?:/.test(n.href) ? n.href : href;
      for (const child of n.childNodes) visit(child, next);
    }
    visit(el); return result;
  }
  function textNode(el, kind, extra = {}) {
    const rich = spans(el), text = rich.map(s => s.text).join('').trim();
    if (text) nodes.push({ kind, text, spans: rich, ...extra });
  }
  function media(el) {
    const tag = el.tagName;
    if (tag === 'IMG') {
      const w = el.naturalWidth || el.width, h = el.naturalHeight || el.height;
      if ((w && w < 40) || (h && h < 30) || /(?:^|[ _-])(?:avatar|emoji|icon)(?:$|[ _-])/i.test(String(el.className))) return;
      const set = [el.getAttribute('srcset'), ...[...(el.closest('picture')?.querySelectorAll('source') || [])].map(s => s.srcset)].filter(Boolean).join(',');
      const choices = set.split(',').map(s => s.trim().split(/\s+/)).filter(s => /^https?:/.test(s[0])).sort((a, b) => parseFloat(b[1]) - parseFloat(a[1]));
      let url = el.getAttribute('data-original') || choices[0]?.[0] || el.getAttribute('data-src') || el.currentSrc || el.src;
      if (isX && (/\/profile_images\/|\/profile_banners\//.test(url) || el.alt === 'X logo')) return;
      if (/pbs\.twimg\.com/.test(url)) { const u = new URL(url); u.searchParams.set('name', 'orig'); if (u.searchParams.get('format') === 'webp') u.searchParams.set('format', 'jpg'); url = u.href; }
      if (/^https?:/.test(url)) nodes.push({ kind: 'image', url, caption: el.closest('figure')?.querySelector('figcaption')?.innerText || el.alt || '' });
      return;
    }
    if (tag === 'VIDEO' || tag === 'AUDIO') {
      const raw = el.currentSrc || el.src || el.querySelector('source')?.src;
      const kind = tag.toLowerCase();
      const url = !platform && raw && /^https?:/.test(raw) ? raw : location.href;
      const expectedAudio = el.webkitAudioDecodedByteCount > 0 || [...performance.getEntriesByType('resource')].some(item => /media-audio-|mime_type=audio/i.test(item.name));
      nodes.push({ kind, url, direct: !platform && !!raw && /^https?:/.test(raw) && !/\.(?:m3u8|mpd)(?:\?|$)/i.test(raw), expectedAudio, poster: el.poster || '', duration: Number.isFinite(el.duration) ? el.duration : undefined, ...(platform ? { platform } : {}) }); return;
    }
    if (tag === 'IFRAME') {
      const u = el.src;
      if (/youtube(?:-nocookie)?\.com\/embed\/|player\.bilibili\.com|player\.vimeo\.com/.test(u)) nodes.push({ kind: 'video', url: u, caption: el.title || '' });
    }
  }
  function walk(el) {
    if (el.nodeType === 3) { const text = el.textContent.trim(); if (text) nodes.push({ kind: 'paragraph', text }); return; }
    if (el.nodeType !== 1 || el.matches(noise) || isX && el.matches('header,[contenteditable="true"]')) return;
    const tag = el.tagName;
    if (['IMG', 'VIDEO', 'AUDIO', 'IFRAME'].includes(tag)) { if (tag !== 'IMG' || visible(el)) media(el); return; }
    if (!visible(el)) return;
    const background = getComputedStyle(el).backgroundImage.match(/^url\(["']?(https?:\/\/.*?)["']?\)$/)?.[1];
    if (background && el.getBoundingClientRect().width >= 80 && el.getBoundingClientRect().height >= 50 && !el.querySelector('img')) nodes.push({ kind: 'image', url: background, caption: el.getAttribute('aria-label') || '' });
    if (tag === 'FIGCAPTION') return;
    if (tag === 'HR') { nodes.push({ kind: 'divider' }); return; }
    const containsMedia = el.querySelector('img,video,audio,iframe');
    if (!containsMedia && /^(P|H[1-6]|BLOCKQUOTE|LI|PRE|TD|TH)$/.test(tag)) {
      const kind = /^H/.test(tag) ? 'heading' : tag === 'BLOCKQUOTE' ? 'quote' : tag === 'LI' ? 'list' : tag === 'PRE' ? 'code' : 'paragraph';
      textNode(el, kind, kind === 'heading' ? { level: Math.min(3, Number(tag[1])) } : {}); return;
    }
    if (!containsMedia && isX && el.matches('[data-testid="tweetText"]')) { textNode(el, 'paragraph'); return; }
    for (const child of el.childNodes) walk(child);
  }
  walk(root);
  const videoPage = /\/video\/\d+|\/watch\?|youtu\.be\/|\/video\/BV|\/video\/av|\/shorts\//.test(location.href);
  if (platform && videoPage && !nodes.some(n => n.kind === 'video')) nodes.unshift({ kind: 'video', url: location.href, platform });
  if (platform === 'douyin' && /\/video\/\d+/.test(location.pathname)) {
    const video = [...root.querySelectorAll('video')].find(visible);
    nodes.length = 0;
    if (video) media(video); else nodes.push({ kind: 'video', url: location.href, platform });
    const description = root.querySelector('[data-e2e="video-desc"],[data-e2e="video-description"]');
    if (description) walk(description);
    if (!nodes.some(node => node.text)) {
      const caption = root.querySelector('h1')?.innerText || document.querySelector('meta[property="og:title"]')?.content || document.querySelector('h1')?.innerText || document.querySelector('meta[name="description"]')?.content || '';
      if (caption) nodes.push({ kind: 'paragraph', text: caption });
    }
  }
  const body = document.body.innerText || '';
  const blocked = /posts are protected|log in to (?:see|view)|sign in to (?:see|view)|请登录后(?:查看|阅读)|登录后阅读全文|登录后可见|此内容仅限|订阅后阅读全文/i.test(body);
  const preview = /继续阅读剩余|展开阅读全文|仅展示部分内容|试看结束|试看片段|preview only|subscribe to continue|sign in to continue reading/i.test(body);
  const errorPage = /something went wrong|this (?:post|page|video) (?:is not|isn't|is) available|this post is unavailable|page not found|内容不存在|视频不见了|页面不存在|出错了|checking your browser|just a moment/i.test(body) && body.length < 3000 || !!document.querySelector('#challenge-form,#cf-challenge-running');
  const verification = /验证码|安全验证/.test(document.title) || [...document.querySelectorAll('iframe')].some(frame => /verifycenter\/captcha|captcha\/v\d/.test(frame.src));
  if (blocked) warnings.push('页面提示需要登录或账号没有完整内容访问权限。');
  if (preview) warnings.push('页面可能只展示了预览内容，请登录或展开原文后重试。');
  if (errorPage) warnings.push('原网页返回了错误、验证或不可用提示，尚未取得原始内容。');
  if (verification) warnings.push('原站要求人工验证，请在收集浏览器中完成验证码后重新读取。');
  return { title: root.querySelector('h1')?.innerText || document.querySelector('meta[property="og:title"]')?.content || document.querySelector('h1')?.innerText || document.title,
    url: location.href, author: document.querySelector('meta[name="author"]')?.content || (isX ? location.pathname.match(/^\/([^/]+)\/status\//)?.[1] : '') || '', nodes, requiresLogin: blocked || verification, incomplete: blocked || preview || errorPage || verification, warnings };
}
module.exports = { extractPage };
