// Runs inside a page. Keep this function self-contained: it is serialized over
// CDP, and page content is data rather than instructions for the application.
function extractPage() {
  const visible = el => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && !el.hidden; };
  const noise = 'nav,footer,aside,script,style,noscript,button,form,[role="navigation"],[role="banner"],[aria-hidden="true"],.advertisement,.ads,.recommend-list,#comments,#secondary,.reply-list,.recommend-panel';
  const host = location.hostname;
  const isX = /(^|\.)(x|twitter)\.com$/.test(host);
  const platform = /(^|\.)douyin\.com$/.test(host) ? 'douyin' : /(^|\.)bilibili\.com$/.test(host) ? 'bilibili' : /(^|\.)(?:youtube\.com|youtu\.be)$/.test(host) ? 'youtube' : /(^|\.)tiktok\.com$/.test(host) ? 'tiktok' : '';
  if (platform === 'douyin' && /^\/note\/\d+\/?$/.test(location.pathname)) {
    const root = document.querySelector('[data-e2e="note-detail"]'), nodes = [], warnings = [];
    const challenge = /验证码|安全验证/.test(document.title) || [...document.querySelectorAll('iframe')].some(frame => {
      const rect = frame.getBoundingClientRect();
      return visible(frame) && getComputedStyle(frame).opacity !== '0' && rect.width > 30 && rect.height > 30 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && /captcha|verifycenter/.test(frame.src);
    });
    if (root) {
      const description = root.querySelector('[data-e2e="video-desc"],[data-e2e="note-desc"],[data-e2e="video-description"],[style*="--lineClamp"]');
      const text = description?.innerText?.trim() || document.querySelector('meta[property="og:description"]')?.content?.trim();
      if (text) nodes.push({ kind: 'paragraph', text });
      // The actual detail container also includes recommendations. Restrict
      // media to the first carousel, including its lazy and offscreen slides.
      const carousel = root.querySelector('.dySwiperSlide,.swiper-slide')?.parentElement;
      const seen = new Set();
      for (const image of carousel?.querySelectorAll('img') || []) {
        if (image.closest('aside,[data-e2e="recommend-list"],[data-e2e="feed-active-video"],[data-e2e="user-avatar"]') || /avatar|emoji|icon/i.test(String(image.className))) continue;
        const raw = image.getAttribute('data-original') || image.getAttribute('data-src') || image.currentSrc || image.src;
        let url; try { url = new URL(raw, location.href); } catch { continue; }
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) continue;
        const key = url.origin + url.pathname;
        if (seen.has(key)) continue; seen.add(key);
        nodes.push({ kind: 'image', url: url.href, direct: true, platform: 'douyin', caption: image.alt || '' });
      }
      const expected = Number(root.innerText.match(/(?:^|\n)\s*\d+\s*\/\s*(\d+)\s*(?:\n|$)/)?.[1]);
      if (!seen.size || expected > seen.size) warnings.push('当前抖音图文的图片尚未加载完整，请在收集浏览器中检查后重新读取。');
    } else warnings.push('尚未取得当前抖音图文详情，未将推荐或登录页面作为原文。');
    if (challenge) warnings.push('抖音要求人工验证，请在收集浏览器中完成验证后重新读取。');
    return { title: nodes.find(node => node.kind === 'paragraph')?.text || root?.querySelector('h1')?.innerText || document.querySelector('meta[property="og:title"]')?.content || document.title,
      url: location.href, nodes, sourceRevision: 'douyin-note-v1', requiresLogin: challenge, incomplete: !!warnings.length, warnings };
  }
  const xArticle = isX ? [...document.querySelectorAll('[data-testid="twitterArticleRichTextView"]')].find(visible) : null;
  const xArticleView = xArticle?.closest('[data-testid="twitterArticleReadView"],article') ||
    (isX ? document.querySelector('[data-testid="twitterArticleReadView"]') : null);
  const xArticleRoute = isX && /\/article\/\d+(?:\/|$)/.test(location.pathname);
  const xMediaSelector = 'a[href*="/article/"][href*="/media/"]';
  const xMediaLinks = new Set([...(xArticleView?.querySelectorAll(xMediaSelector) || [])].filter(link =>
    link.origin === location.origin && /^\/\w+\/article\/\d+\/media\/\d+\/?$/.test(link.pathname) && !link.innerText?.trim()));
  const candidates = [...document.querySelectorAll(isX ? 'article' : 'article,[role="article"],.article-content,.post-content,.entry-content,#js_content,main,[role="main"]')].filter(visible);
  const score = el => (el.innerText || '').length - [...el.querySelectorAll('nav,aside')].reduce((n, e) => n + (e.innerText || '').length, 0);
  const articles = candidates.filter(el => el.matches('article,[role="article"],.article-content,.post-content,.entry-content,#js_content'));
  let root = (articles.length ? articles : candidates).sort((a, b) => score(b) - score(a))[0] || document.body;
  if (platform === 'bilibili') root = document.querySelector('.left-container') || document.querySelector('.video-container-v1') || document.querySelector('main') || root;
  else if (platform) root = document.querySelector(platform === 'youtube' ? '#primary' : '[data-e2e="video-detail"],main') || root;
  if (isX) {
    const status = location.pathname.match(/\/status\/(\d+)/)?.[1];
    root = xArticle || (status && articles.find(el => [...el.querySelectorAll('a[href]')].some(a => a.pathname?.endsWith('/status/' + status)))) || root;
  }
  const nodes = [], warnings = [];
  let xMediaPending = false;
  function spans(el) {
    const result = [];
    function append(text, href, bold, italic) {
      if (!text) return;
      const previous = result.at(-1);
      if (previous && previous.href === href && !!previous.bold === bold && !!previous.italic === italic) previous.text += text;
      else result.push({ text, ...(href ? { href } : {}), ...(bold ? { bold } : {}), ...(italic ? { italic } : {}) });
    }
    function visit(n, href, bold = false, italic = false) {
      if (n.nodeType === 3) { append(n.textContent, href, bold, italic); return; }
      if (n.nodeType !== 1 || n.matches(noise) || !visible(n)) return;
      if (n.tagName === 'BR') { append('\n', href, bold, italic); return; }
      const next = n.tagName === 'A' && /^https?:/.test(n.href) ? n.href : href;
      if (xArticle) {
        bold ||= n.matches('b,strong') || /^(?:bold|[6-9]00)$/.test(n.style?.fontWeight);
        italic ||= n.matches('i,em') || n.style?.fontStyle === 'italic';
      }
      for (const child of n.childNodes) visit(child, next, bold, italic);
    }
    visit(el); return result;
  }
  function textNode(el, kind, extra = {}) {
    const rich = spans(el), text = rich.map(s => s.text).join('').trim();
    if (text) nodes.push({ kind, text, spans: rich, ...extra });
  }
  function imageNode(raw, caption) {
    if (!/^https?:/.test(raw)) return;
    let url; try { url = new URL(raw); } catch { return; }
    if (url.hostname === 'pbs.twimg.com') {
      url.searchParams.set('name', 'orig');
      if (url.searchParams.get('format') === 'webp') url.searchParams.set('format', 'jpg');
    }
    nodes.push({ kind: 'image', url: url.href, caption });
  }
  function media(el) {
    const tag = el.tagName;
    if (tag === 'IMG') {
      const w = el.naturalWidth || el.width, h = el.naturalHeight || el.height;
      if ((w && w < 40) || (h && h < 30) || /(?:^|[ _-])(?:avatar|emoji|icon)(?:$|[ _-])/i.test(String(el.className))) return;
      const set = [el.getAttribute('srcset'), ...[...(el.closest('picture')?.querySelectorAll('source') || [])].map(s => s.srcset)].filter(Boolean).join(',');
      const choices = set.split(',').map(s => s.trim().split(/\s+/)).filter(s => /^https?:/.test(s[0])).sort((a, b) => parseFloat(b[1]) - parseFloat(a[1]));
      const url = el.getAttribute('data-original') || choices[0]?.[0] || el.getAttribute('data-src') || el.currentSrc || el.src;
      if (isX && (/\/profile_images\/|\/profile_banners\//.test(url) || el.alt === 'X logo')) return;
      imageNode(url, el.closest('figure')?.querySelector('figcaption')?.innerText || el.alt || '');
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
    // X renders a CSS preview and an IMG for the same photo. Resolve the media
    // link as one slot so repeated photos elsewhere in the article stay intact.
    if (xMediaLinks.has(el)) {
      const start = nodes.length;
      const attachment = el.querySelector('video,audio') || el.querySelector('img');
      if (attachment) media(attachment);
      if (nodes.length === start) for (const child of el.children) walk(child);
      xMediaPending ||= !nodes.slice(start).some(node => ['image', 'video', 'audio'].includes(node.kind));
      return;
    }
    const background = getComputedStyle(el).backgroundImage.match(/^url\(["']?(https?:\/\/.*?)["']?\)$/)?.[1];
    if (background && el.getBoundingClientRect().width >= 80 && el.getBoundingClientRect().height >= 50 && !el.querySelector('img')) imageNode(background, el.getAttribute('aria-label') || '');
    if (tag === 'FIGCAPTION') return;
    if (tag === 'HR') { nodes.push({ kind: 'divider' }); return; }
    const containsMedia = el.querySelector('img,video,audio,iframe');
    if (!containsMedia && /^(P|H[1-6]|BLOCKQUOTE|LI|PRE|TD|TH)$/.test(tag)) {
      const kind = /^H/.test(tag) ? 'heading' : tag === 'BLOCKQUOTE' ? 'quote' : tag === 'LI' ? 'list' : tag === 'PRE' ? 'code' : 'paragraph';
      textNode(el, kind, kind === 'heading' ? { level: Math.min(3, Number(tag[1])) } : tag === 'LI' && el.parentElement.tagName === 'OL' ? { ordered: true } : {}); return;
    }
    const xParagraph = xArticle && el.matches('div[data-block="true"]') &&
      ![...el.querySelectorAll(xMediaSelector)].some(link => xMediaLinks.has(link));
    if (!containsMedia && (xParagraph || isX && el.matches('[data-testid="tweetText"]'))) { textNode(el, 'paragraph'); return; }
    for (const child of el.childNodes) walk(child);
  }
  const xCover = xArticle && [...xMediaLinks].find(link => !xArticle.contains(link) && visible(link));
  if (xCover) walk(xCover);
  if (xArticle || !xArticleView && !xArticleRoute) walk(root);
  const videoPage = platform === 'bilibili' ? /^\/video\/(?:BV|av)/i.test(location.pathname) :
    platform === 'douyin' || platform === 'tiktok' ? /\/video\/\d+/.test(location.pathname) :
    platform === 'youtube' ? location.pathname === '/watch' && !!new URL(location.href).searchParams.get('v') || /^\/shorts\//.test(location.pathname) || /(^|\.)youtu\.be$/.test(host) : false;
  const xVideo = isX && /\/status\/\d+/.test(location.pathname) && !xArticle && !xArticleView && !!root.querySelector('video');
  const declaredVideo = /^(?:video|video\.[a-z]+)$/i.test(document.querySelector('meta[property="og:type"]')?.content || '') && !xArticle && !xArticleView;
  let douyinTitles;
  if (videoPage || xVideo || declaredVideo) {
    const video = [...root.querySelectorAll('video')].find(visible);
    nodes.length = 0;
    if (video && platform) media(video); else nodes.push({ kind: 'video', url: location.href, ...(platform ? { platform } : {}) });
    const selector = platform === 'bilibili' ? '.desc-info-text,.basic-desc-info' : platform === 'youtube' ? '#description-inline-text,#description-inline-expander' :
      platform === 'douyin' ? '[data-e2e="video-desc"],[data-e2e="video-description"]' : platform === 'tiktok' ? '[data-e2e="browse-video-desc"],[data-e2e="video-desc"]' : '[data-testid="tweetText"]';
    const description = root.querySelector(selector);
    if (platform === 'douyin' && videoPage) {
      const meta = selector => document.querySelector(selector)?.content;
      douyinTitles = [meta('meta[property="og:title"]'), meta('meta[name="twitter:title"]'), root.querySelector('h1')?.innerText,
        description?.innerText, document.title].filter(Boolean);
    }
    if (description) textNode(description, 'paragraph');
    else {
      const caption = document.querySelector('meta[property="og:description"]')?.content || document.querySelector('meta[name="description"]')?.content || '';
      if (caption.trim()) nodes.push({ kind: 'paragraph', text: caption.trim() });
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
  const xArticlePending = Boolean(xArticle || xArticleView || xArticleRoute) && (!xArticle || !nodes.some(node => node.text));
  if (xArticlePending) warnings.push('X 文章正文尚未加载，请重新读取原文。');
  if (xMediaPending) warnings.push('X 文章的封面或配图尚未加载完整，请重新读取原文。');
  const title = xArticleView?.querySelector('[data-testid="twitter-article-title"]')?.innerText?.trim() ||
    root.querySelector('h1')?.innerText || document.querySelector('meta[property="og:title"]')?.content || document.querySelector('h1')?.innerText || document.title;
  return { title, ...(douyinTitles ? { douyinTitles } : {}), url: location.href, author: document.querySelector('meta[name="author"]')?.content || (isX ? location.pathname.match(/^\/([^/]+)\/status\//)?.[1] : '') || '',
    nodes, requiresLogin: blocked || verification, incomplete: blocked || preview || errorPage || verification || xArticlePending || xMediaPending, warnings };
}
module.exports = { extractPage };
