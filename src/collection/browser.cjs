const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { extractPage } = require('./extract-page.cjs');
const { extractXiaohongshuPage } = require('./xiaohongshu.cjs');
const { assertPublicUrl, effectiveProxy } = require('./network.cjs');
const { normalizeDocument, hash } = require('./model.cjs');
const { WechatChannel, isWechatShare } = require('./wechat-channel.cjs');
const { inspectAccount } = require('./account-status.cjs');
const sites = Object.freeze([
  { id: 'douyin', name: '抖音', url: 'https://www.douyin.com/' },
  { id: 'xiaohongshu', name: '小红书', url: 'https://www.xiaohongshu.com/explore' },
  { id: 'bilibili', name: 'B站', url: 'https://www.bilibili.com/' },
  { id: 'tiktok', name: 'TikTok', url: 'https://www.tiktok.com/' },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/' },
  { id: 'x', name: 'X', url: 'https://x.com/' },
  { id: 'wechat', name: '微信视频号', url: 'https://yuanbao.tencent.com/' }
]);
let kitModule;
const mediaKit = () => kitModule ||= import(pathToFileURL(path.join(__dirname, 'media-kit/index.mjs')).href);
function cdpCommand(wsUrl, method, params = {}, { signal, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted(); const socket = new WebSocket(wsUrl);
    const finish = (error, value) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.close(); error ? reject(error) : resolve(value); };
    const abort = () => finish(signal.reason || Error('操作已停止。'));
    const timer = setTimeout(() => finish(Error('浏览器操作超时。')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener('message', event => { const m = JSON.parse(String(event.data)); if (m.id === 1) {
      let error; if (m.error) { error = Error('浏览器未完成请求。'); error.cdpCode = m.error.code; error.cdpMessage = String(m.error.message || '').slice(0, 300); }
      finish(error, m.result);
    } });
    socket.addEventListener('error', () => finish(Error('无法连接收集浏览器。')));
  });
}
class CollectionBrowser {
  constructor({ root, getSettings, binaries }) { Object.assign(this, { root, getSettings, binaries }); this.loginTabs = new Map(); this.wechat = new WechatChannel({ requestJson: (request, options) => this.wechatJson(request, options) }); }
  async wechatJson({ origin, entryUrl, endpoint, body }, { signal } = {}) {
    const allowed = { 'https://yuanbao.tencent.com': '/api/weixin/get_parse_result', 'https://channels.weixin.qq.com': '/finder-preview/api/feed/get_feed_info' };
    const entry = new URL(entryUrl);
    if (allowed[origin] !== endpoint || entry.origin !== origin || entry.username || entry.password) throw Error('微信解析请求的来源或接口无效。');
    const tab = await this.tab(entryUrl, signal), { m } = await this.ensure(signal);
    try {
      await this.waitReady(tab, signal);
      const expression = `(async()=>{const r=await fetch(${JSON.stringify(endpoint)},{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}});const text=await r.text();if(text.length>4194304)throw Error('Response too large');let data;try{data=JSON.parse(text)}catch{return{status:r.status}};const video=document.querySelector('video');return{status:r.status,data,media:video?{duration:Number.isFinite(video.duration)?video.duration:0,audio:video.webkitAudioDecodedByteCount>0}:null}})()`;
      const response = await cdpCommand(tab.wsUrl, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { signal, timeout: 90000 });
      if (response.exceptionDetails || !response.result?.value) throw Error('微信解析请求未完成，请检查收集浏览器中的登录或网络。');
      return response.result.value;
    } finally { await m.cdpCloseTab(this.endpoint, tab.tabId).catch(() => {}); }
  }
  get endpoint() { return 'http://127.0.0.1:' + this.getSettings().browserPort; }
  async backgroundTab(signal) {
    const { m } = await this.ensure(signal);
    const version = await (await m.cdpFetch(this.endpoint + '/json/version')).json();
    const result = await cdpCommand(version.webSocketDebuggerUrl, 'Target.createTarget', { url: 'about:blank', background: true }, { signal });
    const pages = await (await m.cdpFetch(this.endpoint + '/json/list')).json(), target = pages.find(page => page.id === result.targetId);
    if (!target?.webSocketDebuggerUrl) throw Error('无法准备后台收集标签页。');
    return { tabId: target.id, wsUrl: target.webSocketDebuggerUrl };
  }
  async ensure(signal) {
    signal?.throwIfAborted(); const m = await mediaKit(), settings = this.getSettings();
    process.env.MEDIAKIT_BIN_DIR = this.binaries.directory;
    const config = { browserBaseUrl: this.endpoint, chromeUserDataDir: settings.browserProfile || path.join(this.root, 'collection', 'browser'),
      chromeExecutablePath: settings.browserExecutable || undefined, proxyUrl: effectiveProxy(settings.proxy) || undefined };
    const ready = await m.ensureChromeRunning(settings.browserPort, config);
    signal?.throwIfAborted(); if (!ready) throw Error('收集浏览器未就绪，请安装 Chrome、Edge 或 Brave，或在设置中选择浏览器。');
    return { m, config };
  }
  async tab(url, signal) {
    await assertPublicUrl(url); const { m } = await this.ensure(signal);
    const tab = await this.backgroundTab(signal);
    try {
      const navigation = await cdpCommand(tab.wsUrl, 'Page.navigate', { url }, { signal, timeout: 60000 });
      if (navigation.errorText) throw Error('原网页加载失败（' + String(navigation.errorText).replace(/[^A-Za-z0-9_:.-]/g, '') + '），请检查网络或代理配置。');
      return tab;
    } catch (error) { await m.cdpCloseTab(this.endpoint, tab.tabId).catch(() => {}); throw error; }
  }
  async waitReady(tab, signal) {
    const until = Date.now() + 45000; let stable = 0, lastUrl = '';
    while (Date.now() < until) {
      signal?.throwIfAborted();
      try {
        const result = await cdpCommand(tab.wsUrl, 'Runtime.evaluate', { expression: '({url:location.href,ready:document.readyState,text:(document.body?.innerText||"" ).length,media:!!document.querySelector("video,audio,img"),challenge:/验证码|安全验证/.test(document.title)||[...document.querySelectorAll("iframe")].some(f=>/verifycenter\\/captcha/.test(f.src))})', returnByValue: true }, { signal });
        const state = result.result?.value;
        if (state?.url?.startsWith('chrome-error:')) throw Error('原网页无法加载，请检查网络、代理或网站访问限制。');
        if (state?.challenge) return;
        if (state && /^https?:/.test(state.url) && state.ready === 'complete' && (state.text > 30 || state.media)) {
          stable = state.url === lastUrl ? stable + 1 : 0; lastUrl = state.url;
          if (stable >= 2) return;
        }
      } catch (error) { if (!error.cdpCode) throw error; }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw Error('网页正文尚未加载完成，请在收集浏览器中确认页面或登录后重试。');
  }
  async login(site, signal) {
    const url = sites.find(s => s.id === site)?.url || site; await assertPublicUrl(url);
    const tab = await this.tab(url, signal); this.loginTabs.set(new URL(url).hostname, tab);
    const { windowId } = await cdpCommand(tab.wsUrl, 'Browser.getWindowForTarget', { targetId: tab.tabId }, { signal });
    await cdpCommand(tab.wsUrl, 'Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }, { signal });
    await cdpCommand(tab.wsUrl, 'Page.bringToFront', {}, { signal });
    return { message: site === 'wechat' ? '已打开腾讯元宝，用于当前视频号分享链接的解析授权，并非视频号登录页。完成后请返回重试该分享链接。' : '请在收集浏览器中登录；完成后可检测登录状态，或直接重试收集任务。' };
  }
  async cookies(url, signal) {
    const { m } = await this.ensure(signal); const tab = await this.backgroundTab(signal);
    if (!tab) return [];
    try { return (await cdpCommand(tab.wsUrl, 'Network.getCookies', { urls: [url] }, { signal })).cookies || []; }
    finally { await m.cdpCloseTab(this.endpoint, tab.tabId).catch(() => {}); }
  }
  async verifyAccount(site, signal) {
    const { m } = await this.ensure(signal), tab = await this.tab(site.url, signal);
    try {
      await this.waitReady(tab, signal);
      const result = await cdpCommand(tab.wsUrl, 'Runtime.evaluate', { expression: '(' + inspectAccount.toString() + ')(' + JSON.stringify(site.id) + ')', awaitPromise: true, returnByValue: true }, { signal, timeout: 15000 });
      const value = result.result?.value;
      if (result.exceptionDetails || !value || !['valid', 'missing', 'unknown'].includes(value.state)) throw Error('登录检查未完成。');
      return { state: value.state, message: String(value.message || '').slice(0, 200), checkedAt: new Date().toISOString() };
    } finally { await m.cdpCloseTab(this.endpoint, tab.tabId).catch(() => {}); }
  }
  async accounts(signal, { verify = false } = {}) {
    const deferred = site => ({ ...site, state: site.id === 'wechat' ? 'link' : 'deferred', message: site.id === 'wechat' ? '当前适配器按分享链接检查，腾讯元宝授权不代表视频号登录有效。' : '收集时检查内容是否可访问，也可以点击检测登录状态。' });
    const scope = () => { const settings = this.getSettings?.() || {}; return JSON.stringify([settings.browserPort, settings.browserProfile, settings.browserExecutable, settings.proxy]); }, key = scope();
    if (!verify) return this.accountChecks?.key === key && Date.now() - this.accountChecks.at < 120000 ? this.accountChecks.results : sites.map(deferred);
    this.accountChecks = undefined;
    try { await this.ensure(signal); }
    catch { return sites.map(site => site.id === 'wechat' ? deferred(site) : { ...site, state: 'unknown', message: '收集浏览器未能启动，请检查浏览器设置；仍可稍后收集。' }); }
    const results = sites.map(deferred), pending = sites.map((site, index) => ({ site, index })).filter(({ site }) => site.id !== 'wechat');
    // Bound both concurrency and latency. An unavailable platform must not block
    // the rest of the checks or the separate collection queue.
    const worker = async () => {
      while (pending.length) {
        const { site, index } = pending.shift(), timeout = AbortSignal.timeout(15000), local = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try { results[index] = { ...site, ...await this.verifyAccount(site, local) }; }
        catch { results[index] = { ...site, state: 'unknown', message: '网页检查超时或连接失败，可直接收集，按实际访问结果检查。' }; }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (scope() !== key) return sites.map(site => site.id === 'wechat' ? deferred(site) : { ...site, state: 'unknown', message: '浏览器设置已改变，请重新检测当前登录资料。' });
    this.accountChecks = { at: Date.now(), key, results }; return results;
  }
  async inspect(url, { signal, progress = () => {} } = {}) {
    await assertPublicUrl(url);
    if (isWechatShare(url)) return this.wechat.resolve(url, { signal, progress });
    if (/\.(?:png|jpe?g|webp|gif|avif|bmp|svg|mp[34]|m4[av]|wav|ogg|flac|aac|opus|aiff?|wma|webm|mov|mkv)(?:\?|$)/i.test(url)) {
      const extension = new URL(url).pathname.split('.').pop().toLowerCase();
      return normalizeDocument({ title: decodeURIComponent(new URL(url).pathname.split('/').pop()), url,
        nodes: [{ kind: ['mp4', 'm4v', 'webm', 'mov', 'mkv'].includes(extension) ? 'video' : ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'opus', 'aif', 'aiff', 'wma'].includes(extension) ? 'audio' : 'image', url, direct: true }] });
    }
    const tab = await this.tab(url, signal), { m } = await this.ensure(signal);
    try {
      progress('正在加载正文和媒体…');
      const evaluate = async expression => {
        const value = await cdpCommand(tab.wsUrl, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { signal, timeout: 90000 });
        if (value.exceptionDetails) throw Error('网页内容读取失败。'); return value.result?.value;
      };
      await this.waitReady(tab, signal);
      await evaluate(`(async()=>{for(const el of document.querySelectorAll('[data-testid="tweet-text-show-more-link"]')){el.click();await new Promise(r=>setTimeout(r,500));}})()`);
      await evaluate(`(async()=>{let last=0;for(let i=0;i<120;i++){window.scrollBy(0,innerHeight*.85);await new Promise(r=>setTimeout(r,150));const h=document.body.scrollHeight;if(scrollY+innerHeight>=h-20&&h===last)break;last=h;}window.scrollTo(0,0);await new Promise(r=>setTimeout(r,800));})()`);
      const doc = normalizeDocument(await evaluate('(/(^|\\.)xiaohongshu\\.com$/i.test(location.hostname)?(' + extractXiaohongshuPage.toString() + '):(' + extractPage.toString() + '))()'));
      await assertPublicUrl(doc.url);
      if (/(^|\.)xiaohongshu\.com$/i.test(new URL(doc.url).hostname)) {
        const id = new URL(doc.url).pathname.match(/^\/(?:explore|discovery\/item)\/([a-f\d]{24})(?:\/|$)/i)?.[1];
        if (id) for (const node of doc.nodes) if (node.platform === 'xiaohongshu') node.contentId = hash('xiaohongshu:' + id.toLowerCase() + ':' + new URL(node.url).pathname);
      }
      if (!doc.nodes.length && !doc.incomplete) throw Error('没有读取到正文，请检查登录状态并在原网页确认内容可见。');
      return doc;
    } finally { await m.cdpCloseTab(this.endpoint, tab.tabId).catch(() => {}); }
  }
  async downloadMedia(node, directory, signal) {
    const { m, config } = await this.ensure(signal);
    const kit = new m.MediaKit({ ...config, outputDir: directory });
    const result = await kit.download({ url: node.url, outputDir: directory, mediaType: node.kind, transcribe: false, format: 'best' });
    signal?.throwIfAborted();
    if (!result.ok || !result.files.some(f => f.type === node.kind)) throw Error('媒体下载未完成，请检查账号权限或网站登录状态。');
    const file = result.files.find(f => f.type === node.kind);
    const base = fs.realpathSync(directory), real = fs.realpathSync(file.path), relative = path.relative(base, real);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(real).isFile()) throw Error('下载结果不在当前任务目录。');
    return { path: real, warning: result.warning || '' };
  }
  async imageFrame(file, output, signal) {
    const { m } = await this.ensure(signal), tab = await this.backgroundTab(signal);
    if (!tab) throw Error('无法准备图片识别预览。');
    try {
      const types = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };
      const data = 'data:' + (types[path.extname(file).toLowerCase()] || 'application/octet-stream') + ';base64,' + fs.readFileSync(file).toString('base64');
      const expression = `(async()=>{const image=new Image();image.src=${JSON.stringify(data)};await image.decode();const scale=Math.min(1,1600/image.naturalWidth,1600/image.naturalHeight);const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',.9);})()`;
      const result = await cdpCommand(tab.wsUrl, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { signal, timeout: 60000 });
      const converted = result.result?.value;
      if (result.exceptionDetails || typeof converted !== 'string' || !converted.startsWith('data:image/jpeg;base64,')) throw Error('浏览器无法解码此图片，原始文件已保留。');
      fs.writeFileSync(output, Buffer.from(converted.split(',')[1], 'base64'), { mode: 0o600 });
    } finally { await m.cdpCloseTab(this.endpoint, tab.tabId).catch(() => {}); }
  }
}
module.exports = { CollectionBrowser, cdpCommand, mediaKit, sites };
