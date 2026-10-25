const { NativeMeetingStore } = require('./meeting-summary-store.cjs');
const { uuid } = require('./native-context.cjs');
const allowed = new Set(['getRecordValues', 'saveTransactionsFanout']);
class MeetingNativeBridge {
  constructor() { this.contexts = []; }
  observe(request, session) {
    if (!session) return;
    const url = new URL(request.url), userId = uuid(request.headers.get('x-notion-active-user-header'));
    if (!userId || url.protocol !== 'https:' || url.port || !/^(?:(?:app|www)\.)?notion\.(?:com|so)$/.test(url.hostname) || !url.pathname.startsWith('/api/')) return;
    const routing = {};
    for (const name of ['x-notion-cell', 'x-notion-cell-hint', 'x-notion-cell-hint-source', 'x-notion-space-short-id']) {
      const value = request.headers.get(name); if (value && value.length < 200) routing[name] = value;
    }
    const context = { session, origin: url.origin, userId, spaceId: uuid(request.headers.get('x-notion-space-id')), routing };
    this.contexts = this.contexts.filter(c => c.session !== session || c.userId !== userId || c.origin !== url.origin || c.spaceId !== context.spaceId);
    this.contexts.push(context); if (this.contexts.length > 16) this.contexts.shift();
  }
  store(context, spaceId) {
    return new NativeMeetingStore({ spaceId, userId: context.userId, api: async (endpoint, data, { signal, spaceId: selectedSpace } = {}) => {
      if (!allowed.has(endpoint)) throw Error('会议接口操作无效。');
      const matching = selectedSpace === context.spaceId || !selectedSpace;
      const headers = { ...(matching ? context.routing : {}), 'content-type': 'application/json', 'x-notion-active-user-header': context.userId };
      if (selectedSpace && !headers['x-notion-space-short-id']) headers['x-notion-space-id'] = selectedSpace;
      const response = await context.session.fetch(new URL('/api/v3/' + endpoint, context.origin).href, {
        method: 'POST', headers, body: JSON.stringify(data), credentials: 'include', signal,
        redirect: 'error', bypassCustomProtocolHandlers: true
      });
      if (!response.ok) {
        await response.body?.cancel();
        const error = Error(`会议内容接口返回 HTTP ${response.status}，未确认摘要写入。`);
        error.notSubmitted = endpoint === 'saveTransactionsFanout' && [400, 401, 403, 404, 413, 429].includes(response.status);
        throw error;
      }
      const reader = response.body.getReader(); let bytes = 0; const parts = [];
      try { for (;;) { const value = await reader.read(); if (value.done) break; bytes += value.value.length;
        if (bytes > 8 * 1024 * 1024) throw Error('会议记录响应过大，已停止。'); parts.push(Buffer.from(value.value)); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } });
  }
  forRequest(request, session, spaceId) {
    this.observe(request, session);
    const userId = uuid(request.headers.get('x-notion-active-user-header'));
    const contexts = [...this.contexts].reverse().filter(c => c.userId === userId && c.session === session && c.origin === new URL(request.url).origin);
    const context = contexts.find(c => c.spaceId === spaceId) || contexts[0];
    if (!context) throw Error('会议原生登录会话尚未就绪，请重新打开 Notion 页面。');
    return this.store(context, spaceId);
  }
  async forPage(pageId, signal) {
    for (const context of [...this.contexts].reverse()) {
      const store = this.store(context, context.spaceId);
      try { await store.root(pageId, signal); return store; } catch (error) { if (signal?.aborted) throw error; }
    }
    throw Error('当前 Notion 登录会话无法读取此页面，请先在项目原型中打开该页面。');
  }
}
module.exports = { MeetingNativeBridge };
