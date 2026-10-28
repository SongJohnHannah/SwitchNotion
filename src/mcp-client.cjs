const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const VERSION = '2025-06-18', LIMIT = 2 * 1024 * 1024;
const fail = message => { throw Error('Notion MCP ' + message); };
function endpoint(value) {
  let url; try { url = new URL(value); } catch { fail('服务地址无效。'); }
  if (url.username || url.password || url.hash || value.length > 2048 || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail('服务地址必须使用 HTTPS，本机服务可以使用 HTTP。');
  return url.href;
}
function validateServer(input) {
  if (!input || !['http', 'stdio'].includes(input.transport) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || typeof input.enabled !== 'boolean') fail('服务名称、传输类型或开关无效。');
  const server = { id: input.id || randomUUID(), name: input.name.trim(), transport: input.transport, enabled: input.enabled };
  if (!/^[a-f\d-]{36}$/.test(server.id)) fail('服务标识无效。');
  if (server.transport === 'http') {
    server.url = endpoint(input.url);
    if (input.token !== undefined && (typeof input.token !== 'string' || input.token.length > 4096 || /[\r\n]/.test(input.token))) fail('服务密钥无效。');
    server.token = input.token || '';
  } else {
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 2048 || /[\r\n\x00]/.test(input.command) || !Array.isArray(input.args) || input.args.length > 64 || input.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\x00]/.test(arg))) fail('本机命令或参数无效。');
    server.command = input.command; server.args = input.args;
  }
  return server;
}
async function bounded(response, signal, id) {
  const type = response.headers.get('content-type') || '';
  if (!response.body) fail('服务返回空响应。');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, buffer = '';
  try {
    for (;;) {
      signal.throwIfAborted(); const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength; if (size > LIMIT) fail('响应过大，已停止读取。');
      buffer += decoder.decode(chunk.value, { stream: true });
      if (/text\/event-stream/i.test(type)) {
        buffer = buffer.replaceAll('\r\n', '\n');
        for (let end; (end = buffer.indexOf('\n\n')) >= 0;) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let value; try { value = JSON.parse(data); } catch { fail('事件格式无效。'); }
          if (value.id === id && !value.method) return value;
          if (value.method && value.id !== undefined) fail('服务要求客户端交互，此请求尚未支持。');
        }
      }
    }
    if (/text\/event-stream/i.test(type)) fail('事件流中没有对应请求的结果。');
    if (!/application\/json/i.test(type)) fail('响应类型不受支持。');
    try { return JSON.parse(buffer + decoder.decode()); } catch { fail('JSON 响应格式无效。'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
class McpClient {
  constructor(server, { fetchImpl = fetch, spawnImpl = spawn, signal, timeoutMs = 30000, cwd } = {}) {
    Object.assign(this, { server: validateServer(server), fetchImpl, spawnImpl, parentSignal: signal, timeoutMs, cwd });
    this.pending = new Map(); this.next = 0; this.sessionId = null; this.version = VERSION; this.closed = false;
  }
  async start() {
    if (this.server.transport === 'stdio') {
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL)$/i.test(name)));
      let command = this.server.command, args = this.server.args;
      if (process.platform === 'win32' && /^npx(?:\.cmd)?$/i.test(path.basename(command))) {
        const directories = path.isAbsolute(command) ? [path.dirname(command)] : (process.env.PATH || '').split(path.delimiter), candidate = directories.map(dir => ({ script: path.join(dir, 'node_modules/npm/bin/npx-cli.js'), node: path.join(dir, 'node.exe') })).find(item => fs.existsSync(item.script) && fs.existsSync(item.node));
        if (!candidate) fail('未找到 npx 所属的 Node.js，请填写 node.exe 路径及服务器脚本参数。');
        command = candidate.node; args = [candidate.script, ...args];
      }
      this.child = this.spawnImpl(command, args, { env, cwd: this.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = '', errors = 0; this.child.stdout.setEncoding('utf8');
      const rejectAll = () => { for (const item of this.pending.values()) item.reject(Error('Notion MCP 本机服务已退出。')); this.pending.clear(); };
      this.child.on('error', rejectAll); this.child.on('exit', rejectAll);
      this.child.stderr.on('data', chunk => { errors += chunk.length; if (errors > LIMIT) this.close(); });
      this.child.stdout.on('data', chunk => {
        buffer += chunk; if (Buffer.byteLength(buffer) > LIMIT) { this.close(); return; }
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
          let value; try { value = JSON.parse(line); } catch { this.close(); return; }
          if (value.method && value.id !== undefined) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Client interaction is not supported' } }) + '\n'); continue; }
          this.pending.get(value.id)?.resolve(value);
        }
      });
    }
    const result = await this.request('initialize', { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'NotionSwitch', version: '0.2.0' } });
    if (!['2024-11-05', VERSION, '2025-11-25'].includes(result?.protocolVersion) || !result?.capabilities?.tools) fail('服务未提供兼容的工具能力。');
    this.version = result.protocolVersion;
    await this.request('notifications/initialized', {}, true);
    return this;
  }
  async request(method, params, notification = false) {
    if (this.closed) fail('连接已经关闭。');
    const signal = AbortSignal.any([...(this.parentSignal ? [this.parentSignal] : []), AbortSignal.timeout(this.timeoutMs)]);
    signal.throwIfAborted(); const id = notification ? undefined : ++this.next, message = { jsonrpc: '2.0', ...(notification ? {} : { id }), method, params };
    let value;
    if (this.server.transport === 'stdio') {
      if (!this.child || this.child.exitCode !== null) fail('本机服务未启动。');
      if (notification) { this.child.stdin.write(JSON.stringify(message) + '\n'); return {}; }
      value = await new Promise((resolve, reject) => {
        const abort = () => { try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Cancelled by client' } }) + '\n'); } catch {} reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        const finish = fn => value => { this.pending.delete(id); signal.removeEventListener('abort', abort); fn(value); };
        this.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
        if (signal.aborted) { this.pending.get(id).reject(signal.reason); return; }
        this.child.stdin.write(JSON.stringify(message) + '\n', error => { if (error) this.pending.get(id)?.reject(Error('Notion MCP 请求写入失败。')); });
      });
    } else {
      const response = await this.fetchImpl(this.server.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(method === 'initialize' ? {} : { 'MCP-Protocol-Version': this.version }), ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}), ...(this.server.token ? { authorization: 'Bearer ' + this.server.token } : {}) }, body: JSON.stringify(message), signal, redirect: 'error', credentials: 'omit' });
      if (!response.ok) { await response.body?.cancel(); fail('服务返回 HTTP ' + response.status + '，未自动重试操作。'); }
      const session = response.headers.get('mcp-session-id');
      if (method === 'initialize' && session) { if (session.length > 1024 || /[\x00-\x20\x7f]/.test(session)) fail('会话标识无效。'); this.sessionId = session; }
      if (notification && [202, 204].includes(response.status)) { await response.body?.cancel(); return {}; }
      value = await bounded(response, signal, id);
    }
    if (notification) return {};
    if (value?.jsonrpc !== '2.0' || value.id !== id || value.method || value.error || !Object.hasOwn(value, 'result')) fail(value?.error ? '服务拒绝了请求，未自动重试。' : '请求与响应标识不匹配。');
    return value.result;
  }
  async tools() {
    const tools = [], cursors = new Set(); let cursor;
    for (let page = 0; page < 10; page++) {
      const value = await this.request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(value.tools)) fail('工具目录格式无效。');
      for (const tool of value.tools) {
        if (typeof tool.name !== 'string' || tool.name.length > 128 || !tool.inputSchema || tool.inputSchema.type !== 'object' || JSON.stringify(tool).length > 64000 || tools.some(item => item.name === tool.name)) fail('工具名称重复或格式无效。');
        tools.push(tool); if (tools.length > 128) fail('工具目录超过 128 项，请减少服务范围。');
      }
      if (!value.nextCursor) return tools;
      if (typeof value.nextCursor !== 'string' || value.nextCursor.length > 4096 || cursors.has(value.nextCursor)) fail('工具目录分页游标无效。');
      cursor = value.nextCursor; cursors.add(cursor);
    }
    fail('工具目录未读完，已停止。');
  }
  close() {
    if (this.closed) return; this.closed = true;
    for (const item of this.pending.values()) item.reject(Error('Notion MCP 连接已关闭。')); this.pending.clear();
    this.child?.stdin.destroy(); this.child?.kill();
    if (this.sessionId && this.server.transport === 'http') void this.fetchImpl(this.server.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.sessionId, 'MCP-Protocol-Version': this.version, ...(this.server.token ? { authorization: 'Bearer ' + this.server.token } : {}) }, signal: AbortSignal.timeout(3000), redirect: 'error', credentials: 'omit' }).then(response => response.body?.cancel()).catch(() => {});
  }
}
module.exports = { McpClient, validateServer, endpoint };
