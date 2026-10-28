const http = require('node:http');
const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { endpoint } = require('./mcp-client.cjs');
const fail = message => { throw Error('Notion MCP OAuth ' + message); };
const canonical = value => { const url = new URL(endpoint(value)); return url.pathname === '/' && !url.search ? url.origin : url.href; };
const parameter = (header, name) => {
  const match = String(header || '').match(new RegExp('(?:^|[,\\s])' + name + '="((?:[^"\\\\]|\\\\.)*)"', 'i'));
  return match ? match[1].replace(/\\(.)/g, '$1') : undefined;
};
function secure(value, resource) {
  const url = new URL(endpoint(value)), base = new URL(resource);
  if (url.protocol !== 'https:' && !(base.protocol === 'http:' && url.origin === base.origin)) fail('授权地址必须使用 HTTPS；本机调试只允许同源 HTTP。');
  return url.href;
}
async function readJson(response) {
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body) {
    await response.body?.cancel(); fail('授权服务响应无效（HTTP ' + response.status + '）。');
  }
  const reader = response.body.getReader(); let size = 0, parts = [];
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 65536) fail('授权服务响应过大。'); parts.push(chunk.value); }
    const value = JSON.parse(Buffer.concat(parts).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) fail('授权资料格式无效。'); return value;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function tokens(value, previous = {}) {
  if (value.token_type?.toLowerCase() !== 'bearer' || typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(value.access_token)) fail('返回的访问令牌无效。');
  if (value.refresh_token !== undefined && (typeof value.refresh_token !== 'string' || !value.refresh_token || value.refresh_token.length > 8192 || /[\x00-\x20\x7f]/.test(value.refresh_token))) fail('返回的刷新令牌无效。');
  if (value.expires_in !== undefined && (!Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 365 * 86400)) fail('访问令牌有效期无效。');
  return { accessToken: value.access_token, refreshToken: value.refresh_token || previous.refreshToken || '', expiresAt: value.expires_in === undefined ? 0 : Date.now() + value.expires_in * 1000 };
}
class McpOAuth {
  constructor({ openBrowser, fetchImpl = fetch, timeoutMs = 180000 }) { Object.assign(this, { openBrowser, fetchImpl, timeoutMs }); this.active = new Map(); }
  async json(url, signal, body) {
    return readJson(await this.fetchImpl(url, { method: body ? 'POST' : 'GET', headers: { accept: 'application/json', ...(body ? { 'content-type': body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json' } : {}) }, ...(body ? { body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body) } : {}), signal, redirect: 'error', credentials: 'omit' }));
  }
  async discover(server, signal) {
    const resource = canonical(server.url), base = new URL(server.url);
    const response = await this.fetchImpl(server.url, { method: 'GET', headers: { accept: 'application/json, text/event-stream' }, signal, redirect: 'error', credentials: 'omit' });
    const challenge = response.status === 401 ? response.headers.get('www-authenticate') : ''; await response.body?.cancel();
    const metadataUrl = parameter(challenge, 'resource_metadata');
    const candidates = metadataUrl ? [secure(metadataUrl, resource)] : [...new Set([base.origin + '/.well-known/oauth-protected-resource' + (base.pathname === '/' ? '' : base.pathname), base.origin + '/.well-known/oauth-protected-resource'])];
    let metadata;
    for (const url of candidates) { try { metadata = await this.json(url, signal); break; } catch (cause) { signal.throwIfAborted(); if (metadataUrl) throw cause; } }
    if (!metadata || canonical(metadata.resource) !== resource || !Array.isArray(metadata.authorization_servers) || !metadata.authorization_servers.length || metadata.authorization_servers.length > 8) fail('服务缺少匹配的受保护资源元数据。');
    const issuer = canonical(secure(metadata.authorization_servers[0], resource)), issuerUrl = new URL(issuer);
    if (issuerUrl.search) fail('授权颁发者地址无效。');
    const locations = [...new Set([issuerUrl.origin + '/.well-known/oauth-authorization-server' + (issuerUrl.pathname === '/' ? '' : issuerUrl.pathname), issuer.replace(/\/$/, '') + '/.well-known/openid-configuration'])];
    let authorization;
    for (const url of locations) { try { authorization = await this.json(url, signal); break; } catch { signal.throwIfAborted(); } }
    if (!authorization || canonical(authorization.issuer) !== issuer || !authorization.code_challenge_methods_supported?.includes('S256') || !authorization.response_types_supported?.includes('code') || authorization.token_endpoint_auth_methods_supported && !authorization.token_endpoint_auth_methods_supported.includes('none')) fail('服务未提供兼容的公开客户端 PKCE 授权。');
    const authorizationEndpoint = secure(authorization.authorization_endpoint, resource), tokenEndpoint = secure(authorization.token_endpoint, resource);
    if (new URL(tokenEndpoint).origin !== issuerUrl.origin || authorization.registration_endpoint && new URL(secure(authorization.registration_endpoint, resource)).origin !== issuerUrl.origin) fail('令牌与注册地址必须由同一授权颁发者提供。');
    return { resource, issuer, authorizationEndpoint, tokenEndpoint, registrationEndpoint: authorization.registration_endpoint && secure(authorization.registration_endpoint, resource), scope: parameter(challenge, 'scope') || '' };
  }
  async login(id, server, { clientId = '', scope = '' } = {}) {
    if (server.transport === 'stdio' || !this.openBrowser) fail('当前服务不支持浏览器登录。');
    if (this.active.has(id)) fail('此服务正在登录，请在浏览器完成或取消。');
    if (typeof clientId !== 'string' || clientId.length > 2048 || /[\x00-\x20\x7f]/.test(clientId) || typeof scope !== 'string' || scope.length > 2000 || /[\x00-\x1f\x7f]/.test(scope)) fail('客户端 ID 或权限范围无效。');
    const controller = new AbortController(), { signal } = controller, timer = setTimeout(() => controller.abort(Error('Notion MCP OAuth 登录超时。')), this.timeoutMs);
    this.active.set(id, controller); let receiver;
    try {
      const info = await this.discover(server, signal), state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      receiver = await this.receive(state, info.issuer, signal);
      if (!clientId) {
        if (!info.registrationEndpoint) fail('此服务不支持自动注册，请填写服务提供的公开 OAuth Client ID 后重试。');
        const registration = await this.json(info.registrationEndpoint, signal, { client_name: 'NotionSwitch', redirect_uris: [receiver.redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
        clientId = registration.client_id;
        if (typeof clientId !== 'string' || !clientId || clientId.length > 2048 || /[\x00-\x20\x7f]/.test(clientId) || registration.client_secret || registration.token_endpoint_auth_method && registration.token_endpoint_auth_method !== 'none' || !registration.redirect_uris?.includes(receiver.redirectUri)) fail('服务未注册兼容的公开客户端。');
      }
      scope = scope.trim() || info.scope;
      if (scope.length > 2000 || /[\x00-\x1f\x7f]/.test(scope)) fail('服务返回的权限范围无效。');
      const url = new URL(info.authorizationEndpoint);
      for (const [name, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: receiver.redirectUri, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: info.resource, ...(scope ? { scope } : {}) })) url.searchParams.set(name, value);
      await this.openBrowser(url.href); const code = await receiver.code; signal.throwIfAborted();
      const value = await this.json(info.tokenEndpoint, signal, new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: receiver.redirectUri, code, code_verifier: verifier, resource: info.resource }));
      return { grantId: randomUUID(), resource: info.resource, issuer: info.issuer, tokenEndpoint: info.tokenEndpoint, clientId, scope, ...tokens(value) };
    } finally { clearTimeout(timer); receiver?.close(); this.active.delete(id); }
  }
  async receive(state, issuer, signal) {
    let resolveCode, rejectCode;
    const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    // Observe rejection even while registration or opening the browser is pending.
    void code.catch(() => {});
    const route = '/mcp/callback/' + randomUUID(); let redirectUri;
    const server = http.createServer((request, response) => {
      const reject = () => { response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); response.end('Invalid OAuth callback'); };
      let url; try { url = new URL(request.url, redirectUri); } catch { reject(); return; }
      if (request.method !== 'GET' || request.headers.host !== new URL(redirectUri).host || url.origin !== new URL(redirectUri).origin || url.pathname !== route || ['state', 'code', 'error', 'iss'].some(name => url.searchParams.getAll(name).length > 1)) { reject(); return; }
      const actual = url.searchParams.get('state') || '';
      if (Buffer.byteLength(actual) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(actual), Buffer.from(state)) || url.searchParams.has('iss') && url.searchParams.get('iss') !== issuer) { reject(); return; }
      const value = url.searchParams.get('code');
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' });
      if (url.searchParams.has('error') || !value || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) { response.end('授权未完成，可以关闭此页面。'); rejectCode(Error('Notion MCP OAuth 授权被拒绝或返回无效。')); }
      else { response.end('授权已接收，请返回 NotionSwitch。可以关闭此页面。'); resolveCode(value); }
    });
    server.requestTimeout = 5000; server.headersTimeout = 5000;
    const abort = () => { rejectCode(signal.reason); server.close(); server.closeAllConnections(); };
    signal.addEventListener('abort', abort, { once: true });
    const close = () => { signal.removeEventListener('abort', abort); server.close(); server.closeAllConnections(); };
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      redirectUri = 'http://127.0.0.1:' + server.address().port + route;
      signal.throwIfAborted(); return { code, redirectUri, close };
    } catch (cause) { close(); throw cause; }
  }
  async refresh(oauth, resource) {
    if (oauth.resource !== canonical(resource) || !oauth.refreshToken) fail('登录已过期，请重新登录。');
    const value = await this.json(secure(oauth.tokenEndpoint, resource), AbortSignal.timeout(30000), new URLSearchParams({ grant_type: 'refresh_token', client_id: oauth.clientId, refresh_token: oauth.refreshToken, resource: oauth.resource }));
    return { ...oauth, ...tokens(value, oauth) };
  }
  cancel(id) { this.active.get(id)?.abort(Error('Notion MCP OAuth 登录已取消。')); }
  close() { for (const id of this.active.keys()) this.cancel(id); }
}
module.exports = { McpOAuth };
