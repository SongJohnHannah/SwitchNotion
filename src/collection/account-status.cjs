// Runs inside a fresh platform page. Return only an account verdict; never return
// cookies, tokens, account names or the page's hydration data to the renderer.
async function inspectAccount(site) {
  const domains = { douyin: 'douyin.com', xiaohongshu: 'xiaohongshu.com', bilibili: 'bilibili.com', tiktok: 'tiktok.com', youtube: 'youtube.com', x: 'x.com' };
  const domain = domains[site], host = location.hostname;
  const verdict = (state, message, retry = state === 'unknown') => ({ state, message, retry });
  if (!domain || !(host === domain || host.endsWith('.' + domain))) return verdict('unknown', '网页跳转到了其他网站，未能确认登录。');
  const visible = node => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const visibleMatch = selector => [...document.querySelectorAll(selector)].some(visible);
  if (/验证码|安全验证|安全校验|captcha|security check|verify you are human/i.test(document.title) || visibleMatch('iframe[src*="captcha"], iframe[src*="verifycenter"], [data-testid="ocfArkoseFrame"]') || /\/account\/access/.test(location.pathname)) return verdict('unknown', '网站要求安全验证，请在收集浏览器中处理后重试。', false);
  if (/\/(?:login|signin|i\/flow\/login)(?:\/|$)/.test(location.pathname)) return verdict('missing', '网站显示登录页，请登录后重新检测。');

  if (site === 'douyin') {
    const source = document.getElementById('RENDER_DATA')?.textContent;
    if (source && source.length <= 4 * 1024 * 1024) {
      let data;
      try { data = JSON.parse(source); } catch { try { data = JSON.parse(decodeURIComponent(source)); } catch {} }
      const user = data?.app?.user;
      if (user?.isLogin === true && typeof user.info?.uid === 'string' && user.info.uid && user.info.uid !== '0') return verdict('valid', '抖音页面的当前账号数据已确认登录。');
      if (user?.isLogin === false) return verdict('missing', '抖音页面显示当前会话未登录。');
    }
  }
  if (site === 'youtube') {
    const loggedIn = typeof window.ytcfg?.get === 'function' ? window.ytcfg.get('LOGGED_IN') : window.ytcfg?.data_?.LOGGED_IN;
    if (loggedIn === true) return verdict('valid', 'YouTube 页面返回的当前账号配置已确认登录。');
    if (loggedIn === false) return verdict('missing', 'YouTube 页面返回的当前会话尚未登录。');
  }

  if (site === 'bilibili') {
    try {
      const response = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (!response.ok) return verdict('unknown', '登录接口暂时不可用，收集时会继续检查。');
      const data = await response.json();
      if (data.code === 0 && data.data?.isLogin === true) return verdict('valid', '网站登录接口已确认当前会话有效。');
      if (data.code === -101 && data.data?.isLogin === false) return verdict('missing', '网站已确认当前会话未登录或已失效。');
      return verdict('unknown', '网站未返回明确的登录状态，收集时会继续检查。');
    } catch { return verdict('unknown', '登录接口请求未完成，请检查网络或稍后重试。'); }
  }

  // A fresh page's own account control is evidence; arbitrary author avatars,
  // recommendation cards and the presence of cookies are not.
  if (site === 'xiaohongshu') {
    const source = window.__INITIAL_STATE__?.user?.userInfo, user = source?._value ?? source?.value ?? source;
    if (user?.guest === false && typeof user.userId === 'string' && user.userId) return verdict('valid', '网站的当前账号状态已确认登录。');
    if (user?.guest === true) return verdict('missing', '网站当前为访客状态，请登录后重新检测。');
  }
  const accountSelectors = {
    douyin: 'header a[href="/user/self"], [data-e2e="navigation"] a[href="/user/self"]',
    xiaohongshu: '.side-bar a[href^="/user/profile/"], .sidebar a[href^="/user/profile/"]',
    tiktok: '[data-e2e="profile-icon"] a[href^="/@"], a[data-e2e="nav-profile"][href^="/@"]',
    youtube: 'ytd-masthead button#avatar-btn img, ytm-mobile-topbar-renderer button[aria-label="Account"] img',
    x: '[data-testid="SideNav_AccountSwitcher_Button"]'
  };
  if (accountSelectors[site] && visibleMatch(accountSelectors[site])) return verdict('valid', '已在最新网页中确认当前账号入口；具体内容权限在收集时检查。');
  const loginSelectors = {
    douyin: 'header [data-e2e="login-button"], [data-e2e="navigation"] [data-e2e="login-button"]',
    xiaohongshu: '.side-bar .login-btn, .sidebar .login-btn',
    tiktok: '[data-e2e="top-login-button"], [data-e2e="nav-login-button"]',
    youtube: 'ytd-masthead a[href*="accounts.google.com/ServiceLogin"], ytd-masthead ytd-button-renderer a[href*="accounts.google.com"]',
    x: 'a[data-testid="loginButton"], a[href="/i/flow/login"]'
  };
  if (loginSelectors[site] && visibleMatch(loginSelectors[site])) return verdict('missing', '网站显示登录入口，尚未确认有效账号。');
  if (site === 'tiktok' && document.readyState === 'complete' && !(document.body?.innerText || '').trim() && !document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent?.trim()) return verdict('unknown', 'TikTok 页面没有加载出账号信息，请在收集浏览器中打开后重试。');
  return verdict('unknown', '未找到明确的当前账号状态，可直接收集，按实际访问结果检查。');
}
module.exports = { inspectAccount };
