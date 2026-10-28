const { createHash } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const origin = 'https://calendar-api.notion.so';
const endpoints = new Set(['getNotionSessionUsers', 'getUser', 'getCalendars', 'getEvent', 'createEvent', 'updateEvents']);
class CalendarConnection {
  constructor({ createWindow, ready = async () => {}, fetchImpl = globalThis.fetch }) { Object.assign(this, { createWindow, ready, fetchImpl }); this.sessions = new Map(); this.windows = new Set(); this.connecting = new Map(); }
  async api(entry, endpoint, body, signal) {
    if (!endpoints.has(endpoint)) throw Error('Notion 日历接口无效。');
    const url = new URL('/v2/' + endpoint, origin); url.searchParams.set('client', 'web');
    if (entry.version) url.searchParams.set('ver', entry.version);
    url.searchParams.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
    const response = await this.fetchImpl(url.href, { method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { authorization: 'Bearer ' + entry.token, 'content-type': 'application/json', 'X-Notion-Authenticated': 'true' }, body: JSON.stringify(body || {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) this.sessions.delete(entry.userId);
      throw Object.assign(Error('Notion 日历接口返回 HTTP ' + response.status + '，请重新连接或检查日历权限。'), { notSubmitted: [400, 401, 403, 404, 409, 412, 413, 429].includes(response.status), status: response.status });
    }
    const reader = response.body.getReader(), parts = []; let bytes = 0;
    try { for (;;) { const value = await reader.read(); if (value.done) break; bytes += value.value.length; if (bytes > 4 * 1024 * 1024) throw Error('Notion 日历响应过大。'); parts.push(Buffer.from(value.value)); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }
  async ensure({ userId, signal }) {
    userId = uuid(userId); if (!userId) throw Error('Notion 日历缺少当前账号。'); signal?.throwIfAborted();
    const existing = this.sessions.get(userId); if (existing) return existing;
    if (this.connecting.has(userId)) throw Error('Notion 日历连接窗口已经打开，请先在该窗口完成登录。');
    const promise = this.connect({ userId, signal }); this.connecting.set(userId, promise);
    try { return await promise; } finally { if (this.connecting.get(userId) === promise) this.connecting.delete(userId); }
  }
  async connect({ userId, signal }) {
    await this.ready(); signal?.throwIfAborted();
    const partition = 'persist:notion-switch-calendar-' + createHash('sha256').update(userId).digest('hex').slice(0, 24);
    const window = this.createWindow({ width: 1100, height: 780, title: '连接 Notion Calendar · 请使用同一 Notion 账号', show: true, autoHideMenuBar: true,
      webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
    this.windows.add(window); const session = window.webContents.session, children = new Set(), tested = new Set();
    const promise = new Promise((resolve, reject) => {
      let ended = false, pollTimer;
      const finish = (error, entry) => {
        if (ended) return; ended = true; clearTimeout(timer); clearTimeout(pollTimer); signal?.removeEventListener('abort', stop);
        session.webRequest.onBeforeSendHeaders(null); this.windows.delete(window);
        for (const child of children) if (!child.isDestroyed()) child.close();
        if (!window.isDestroyed()) window.close();
        if (error) reject(error); else { this.sessions.set(userId, entry); resolve(entry); }
      };
      const stop = () => finish(Error('Notion 日历连接已取消。'));
      const timer = setTimeout(() => finish(Error('Notion 日历连接超时，请重新连接。')), 300000); timer.unref?.(); signal?.addEventListener('abort', stop, { once: true });
      window.on('closed', stop);
      window.webContents.setWindowOpenHandler(({ url }) => {
        let target; try { target = new URL(url); } catch { return { action: 'deny' }; }
        const allowed = target.protocol === 'https:' && (/(^|\.)notion\.(?:so|com)$/.test(target.hostname) || ['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com'].includes(target.hostname));
        return allowed ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { session, nodeIntegration: false, contextIsolation: true, sandbox: true } } } : { action: 'deny' };
      });
      window.webContents.on('did-create-window', child => { children.add(child); child.on('closed', () => children.delete(child)); });
      const checkConnected = async entry => {
        if (ended) return;
        const user = await this.api(entry, 'getUser', {}, signal);
        if (uuid(user.notionUserId) !== userId || !Array.isArray(user.accounts) || ended) return;
        if (user.accounts.some(account => ['google', 'icloud', 'outlook'].includes(account.providerName) && account.status !== 'disconnected' && !['unauthorized', 'missingScopes'].includes(account.authorizationStatus))) { finish(null, entry); return; }
        window.setTitle?.('连接 Notion Calendar · 请在此窗口连接 Google、iCloud 或 Outlook 日历');
        clearTimeout(pollTimer); pollTimer = setTimeout(() => { void checkConnected(entry).catch(() => {}); }, 2000); pollTimer.unref?.();
      };
      session.webRequest.onBeforeSendHeaders({ urls: [origin + '/*'] }, (details, callback) => {
        callback({ cancel: false });
        const header = Object.entries(details.requestHeaders || {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
        const token = typeof header === 'string' && header.match(/^Bearer ([A-Za-z\d._~+\/-]{20,8192}={0,2})$/)?.[1];
        if (!token || tested.has(token) || tested.size >= 4 || ended) return; tested.add(token);
        const version = new URL(details.url).searchParams.get('ver'), entry = { token, userId, ...(version && /^[A-Za-z\d@.+_-]{1,80}$/.test(version) ? { version } : {}) };
        void this.api(entry, 'getNotionSessionUsers', {}, signal).then(result => {
          if (!Array.isArray(result.users) || !result.users.some(user => uuid(user.id) === userId)) return;
          return checkConnected(entry);
        }).catch(() => {});
      });
      void window.loadURL('https://calendar.notion.so/').catch(() => finish(Error('Notion 日历登录页面未能打开。')));
    });
    return promise;
  }
  async request(scope, endpoint, data) { const entry = await this.ensure(scope); scope.signal?.throwIfAborted(); return this.api(entry, endpoint, data, scope.signal); }
  forget(userId) { this.sessions.delete(uuid(userId)); }
  close() { for (const window of [...this.windows]) if (!window.isDestroyed()) window.close(); this.sessions.clear(); }
}
module.exports = { CalendarConnection };
