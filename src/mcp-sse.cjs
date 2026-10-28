const LIMIT = 2 * 1024 * 1024;
const error = message => Error('Notion MCP ' + message);

// Legacy HTTP+SSE has one receiving stream and a separate POST endpoint.
// Never reconnect or replay messages: a tool may already have changed data.
class SseTransport {
  constructor({ url, token, fetchImpl, signal, timeoutMs, validateEndpoint }) {
    Object.assign(this, { url, token, fetchImpl, timeoutMs, validateEndpoint });
    this.controller = new AbortController(); this.pending = new Map();
    this.parentSignal = signal; this.abort = () => this.close(signal.reason);
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  headers() { return this.token ? { authorization: 'Bearer ' + this.token } : {}; }
  async open() {
    this.controller.signal.throwIfAborted();
    const timer = setTimeout(() => this.close(error('SSE 连接超时。')), this.timeoutMs);
    let ready, reject;
    const endpoint = new Promise((resolve, fail) => { ready = resolve; reject = fail; });
    this.ready = ready; this.rejectReady = reject;
    this.readerTask = this.read().catch(cause => this.close(cause));
    try { await endpoint; } finally { clearTimeout(timer); }
  }
  async read() {
    const response = await this.fetchImpl(this.url, { method: 'GET', headers: { accept: 'text/event-stream', ...this.headers() }, signal: this.controller.signal, redirect: 'error', credentials: 'omit' });
    if (!response.ok || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body) {
      await response.body?.cancel(); throw error('SSE 服务未返回有效事件流（HTTP ' + response.status + '）。');
    }
    const reader = this.reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '', size = 0, event = '', data = [];
    const line = text => {
      size += Buffer.byteLength(text) + 1; if (size > LIMIT) throw error('SSE 单条事件过大。');
      if (!text) {
        const body = data.join('\n');
        if (data.length) this.event(event || 'message', body);
        size = 0; event = ''; data = []; return;
      }
      if (text.startsWith(':')) return;
      const colon = text.indexOf(':'), field = colon < 0 ? text : text.slice(0, colon);
      let value = colon < 0 ? '' : text.slice(colon + 1); if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value; else if (field === 'data') data.push(value);
    };
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const end = buffer.search(/[\r\n]/); if (end < 0 || buffer[end] === '\r' && end === buffer.length - 1) break;
          const width = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
          line(buffer.slice(0, end)); buffer = buffer.slice(end + width);
        }
        if (Buffer.byteLength(buffer) + size > LIMIT) throw error('SSE 单条事件过大。');
      }
      throw error('SSE 连接已断开，未自动重试操作。');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); this.reader = null; }
  }
  event(type, data) {
    if (type === 'endpoint') {
      if (this.postUrl) throw error('SSE 服务重复提供发送地址。');
      const target = this.validateEndpoint(new URL(data, this.url).href);
      if (new URL(target).origin !== new URL(this.url).origin) throw error('SSE 发送地址必须与配置的服务同源。');
      this.postUrl = target; this.ready(); return;
    }
    if (type !== 'message') return;
    if (!this.postUrl) throw error('SSE 服务尚未提供发送地址。');
    let value; try { value = JSON.parse(data); } catch { throw error('SSE 消息格式无效。'); }
    if (!value || value.jsonrpc !== '2.0' || Array.isArray(value)) throw error('SSE 消息格式无效。');
    if (value.method && value.id !== undefined) {
      void this.post({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Client interaction is not supported' } }, AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.timeoutMs)])).catch(cause => this.close(cause));
      return;
    }
    if (!value.method) this.pending.get(value.id)?.resolve(value);
  }
  async post(message, signal) {
    const response = await this.fetchImpl(this.postUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...this.headers() }, body: JSON.stringify(message), signal, redirect: 'error', credentials: 'omit' });
    await response.body?.cancel();
    if (!response.ok) throw error('SSE 服务返回 HTTP ' + response.status + '，未自动重试操作。');
  }
  async request(message, signal) {
    this.controller.signal.throwIfAborted(); signal.throwIfAborted();
    if (!this.postUrl) throw error('SSE 连接尚未就绪。');
    signal = AbortSignal.any([signal, this.controller.signal]);
    if (message.id === undefined) { await this.post(message, signal); return {}; }
    let rejectResponse;
    const response = new Promise((resolve, reject) => {
      rejectResponse = reject; this.pending.set(message.id, { resolve, reject });
    });
    const abort = () => rejectResponse(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) rejectResponse(signal.reason);
      const [, value] = await Promise.all([signal.aborted ? Promise.reject(signal.reason) : this.post(message, signal), response]);
      return value;
    } finally { this.pending.delete(message.id); signal.removeEventListener('abort', abort); }
  }
  close(cause = error('SSE 连接已关闭。')) {
    if (this.controller.signal.aborted) return;
    this.controller.abort(cause); this.rejectReady?.(cause);
    this.parentSignal?.removeEventListener('abort', this.abort);
    for (const pending of this.pending.values()) pending.reject(cause);
    this.pending.clear();
    void this.reader?.cancel().catch(() => {});
  }
}
module.exports = { SseTransport };
