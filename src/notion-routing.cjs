const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { NotionWorkspace, definitions, pageId, pageTitle } = require('./notion-tools.cjs');
const { uuid } = require('./native-context.cjs');
const digest = value => createHash('sha256').update(value).digest('hex');
const registryName = 'notion-connections.local.json';
const { writeTools } = require('./notion-capabilities.cjs');
const { definitelyNotWritten, notSubmitted } = require('./notion-errors.cjs');
const listTool = { type: 'function', function: { name: 'list_workspaces', description: '列出本机已配置并经 API 校验的工作区及当前页面上下文，不返回密钥。跨工作区任务先确认这些范围。', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } };

class NotionRouter {
  constructor({ root, fetchImpl = fetch, log = () => {}, intervalMs = 350 } = {}) {
    this.root = root; this.fetchImpl = fetchImpl; this.log = log; this.intervalMs = intervalMs;
    this.clients = new Map(); this.identities = new Map(); this.lastWorkspaces = [];
  }
  profiles() {
    const file = path.join(this.root, registryName);
    if (!fs.existsSync(file)) return [null];
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw Error('Notion 统一工作区配置不是有效 JSON，请检查括号、逗号和引号。'); }
    if (!data || ![1, 2].includes(data.version) || !Array.isArray(data.connections) || data.connections.length > 16) throw Error('Notion 工作区连接配置无效（最多 16 个工作区）。');
    const ids = new Set();
    for (const profile of data.connections) {
      const id = uuid(profile?.workspaceId);
      if (!profile || typeof profile !== 'object' || Array.isArray(profile) || (profile.workspaceId !== undefined && !id) || (id && ids.has(id)) || (data.version === 1 ? !id || typeof profile.apiKeyFile !== 'string' : typeof profile.apiKey !== 'string' || profile.apiKey.length > 1024 || /[\r\n]/.test(profile.apiKey))) throw Error('Notion 工作区连接配置重复或缺少字段。');
      if (id) ids.add(id);
    }
    return data.connections;
  }
  client(profile) {
    const key = profile ? JSON.stringify(profile) : 'legacy';
    if (!this.clients.has(key)) this.clients.set(key, new NotionWorkspace({ root: this.root, fetchImpl: this.fetchImpl, log: this.log, intervalMs: this.intervalMs, profile }));
    return this.clients.get(key);
  }
  async identify(client, cfg, signal) {
    const key = digest(cfg.key);
    let identity = this.identities.get(key);
    if (!identity || identity.expiresAt < Date.now()) {
      const me = await client.request(cfg, 'GET', 'users/me', null, signal);
      const id = uuid(me.bot?.workspace_id);
      if (me.type !== 'bot' || !id) throw Error('Notion 当前连接未返回可验证的工作区身份，请使用内部连接。');
      identity = { id, name: String(me.bot.workspace_name || 'Notion workspace').slice(0, 80), expiresAt: Date.now() + 600000 };
      this.identities.set(key, identity);
    }
    if (cfg.workspaceId && uuid(cfg.workspaceId) !== identity.id) throw Error('Notion 连接密钥所属工作区与配置不一致，已拒绝路由。');
    return identity;
  }
  async prepare(signal) {
    const workspaces = [], unavailable = [];
    for (const profile of this.profiles()) {
      const client = this.client(profile);
      try {
        const cfg = client.config();
        if (!cfg.key || !cfg.enabled) { unavailable.push({ workspace_id: profile?.workspaceId || null, error: 'Notion 连接未启用或未填写本地密钥。' }); continue; }
        const identity = await this.identify(client, cfg, signal);
        if (workspaces.some(w => w.id === identity.id)) throw Error('Notion 同一工作区配置了重复连接。');
        workspaces.push({ ...identity, name: profile?.name?.trim() || identity.name, client, cfg: { ...cfg, workspaceId: identity.id } });
      } catch (error) {
        if (signal?.aborted) throw error;
        unavailable.push({ workspace_id: profile?.workspaceId || null, error: /^(Notion |请先)/.test(error.message) ? error.message : 'Notion 本地连接配置无效。' });
      }
    }
    this.lastWorkspaces = workspaces.map(w => ({ workspace_id: w.id, name: w.name, read_only: w.cfg.readOnly }));
    return { workspaces, unavailable };
  }
  status() {
    try {
      const profiles = this.profiles(), states = profiles.map(p => this.client(p).status());
      const clients = [...this.clients.values()];
      return { configured: states.some(s => s.configured), enabled: states.some(s => s.enabled), readOnly: states.every(s => s.readOnly), scope: 'workspace-connections', apiVersion: '2026-03-11', connectionCount: profiles.length, workspaces: this.lastWorkspaces, contentTools: definitions.filter(d => states.some(s => s.enabled && s.configured && (!s.readOnly || !writeTools.has(d.function.name)))).map(d => d.function.name), requests: clients.reduce((n, c) => n + c.requests, 0), verifiedWrites: clients.reduce((n, c) => n + c.verifiedWrites, 0) };
    } catch { return { configured: false, configurationError: true }; }
  }
  async open({ operationScope = 'local', signal, nativeContext = {} } = {}) {
    const { workspaces, unavailable } = await this.prepare(signal);
    const byId = new Map(workspaces.map(w => [w.id, w]));
    const sessions = new Map(workspaces.map(w => [w.id, w.client.open({ operationScope: operationScope + ':' + w.id, signal, config: w.cfg })]));
    const currentWorkspaceId = uuid(nativeContext.workspace_id), currentPageId = uuid(nativeContext.page_id);
    const context = { current_workspace_id: currentWorkspaceId, current_page: currentPageId && currentWorkspaceId ? { page_id: currentPageId, workspace_id: currentWorkspaceId, source: 'native-request' } : null, workspaces: this.lastWorkspaces, unavailable };
    const routes = new Map(); let writeUncertain = false;
    const remember = (id, workspaceId) => { const set = routes.get(id) || new Set(); set.add(workspaceId); routes.set(id, set); };
    const select = (args, id) => {
      let workspaceId;
      if (args.workspace_id && args.workspace_id !== 'current') workspaceId = uuid(args.workspace_id);
      else if (currentWorkspaceId) workspaceId = currentWorkspaceId;
      else if (id && routes.get(id)?.size === 1) workspaceId = [...routes.get(id)][0];
      else if (workspaces.length === 1) workspaceId = workspaces[0].id;
      if (!workspaceId || !byId.has(workspaceId)) throw Error('Notion 当前或指定工作区尚未配置有效连接，请先添加该工作区的本地密钥并授权页面。');
      return byId.get(workspaceId);
    };
    const annotate = (result, w) => ({ ...result, workspace_id: w.id, workspace_name: w.name });
    const execute = async (name, args = {}) => {
      signal?.throwIfAborted();
      if (name === 'list_workspaces') {
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw Error('Notion list_workspaces 不接受额外参数。');
        return context;
      }
      const def = definitions.find(d => d.function.name === name);
      if (!def || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => k !== 'workspace_id' && !Object.hasOwn(def.function.parameters.properties, k)) || def.function.parameters.required.some(k => !Object.hasOwn(args, k))) throw Error('Notion 工具参数不完整或包含未知字段。');
      if (args.workspace_id !== undefined && (typeof args.workspace_id !== 'string' || !['current', 'all'].includes(args.workspace_id) && !uuid(args.workspace_id))) throw Error('Notion 工作区 ID 无效。');
      if (name === 'search_pages' || name === 'search_databases') {
        const all = args.workspace_id === 'all';
        const targets = all ? workspaces : [select(args)];
        if (!targets.length) throw Error('Notion 尚未配置任何可访问工作区。');
        const fingerprint = digest(JSON.stringify([targets.map(w => [w.id, w.cfg.pageIds || []]), name, args.query, args.scope]));
        let index = 0, cursor, incomplete = false;
        if (args.start_cursor) {
          try {
            if (!args.start_cursor.startsWith('nsw1:') || args.start_cursor.length > 2000) throw Error();
            const token = JSON.parse(Buffer.from(args.start_cursor.slice(5), 'base64url').toString('utf8'));
            if (token.fingerprint !== fingerprint || !Number.isInteger(token.index) || token.index < 0 || token.index >= targets.length || token.cursor !== undefined && typeof token.cursor !== 'string' || token.incomplete !== undefined && typeof token.incomplete !== 'boolean') throw Error();
            index = token.index; cursor = token.cursor; incomplete = token.incomplete === true;
          } catch { throw Error('Notion 跨工作区搜索游标无效或搜索范围已变化，请从首批重新搜索。'); }
        }
        const w = targets[index], { workspace_id, start_cursor, ...childArgs } = args;
        let result;
        try { result = await sessions.get(w.id).execute(name, { ...childArgs, ...(cursor ? { start_cursor: cursor } : {}) }); }
        catch (error) {
          if (signal?.aborted || !all || !/^Notion API /.test(error.message)) throw error;
          result = { results: [], scanned: 0, skipped: [{ workspace_id: w.id, error: error.message }], incomplete_pages: [], has_more: false, next_cursor: null, complete: false, scope: args.scope };
        }
        result.skipped ||= []; result.incomplete_pages ||= [];
        incomplete ||= !!result.skipped.length || !!result.incomplete_pages.length || !result.has_more && !result.complete;
        for (const row of result.results) for (const key of ['page_id', 'database_id', 'data_source_id']) if (row[key]) remember(row[key], w.id);
        const more = result.has_more || index + 1 < targets.length;
        const next = more ? 'nsw1:' + Buffer.from(JSON.stringify({ fingerprint, index: result.has_more ? index : index + 1, incomplete, ...(result.has_more ? { cursor: result.next_cursor } : {}) })).toString('base64url') : null;
        return { ...annotate(result, w), results: result.results.map(row => annotate(row, w)), has_more: more, next_cursor: next, complete: !more && result.complete && !incomplete && !unavailable.length, earlier_or_current_batch_incomplete: incomplete, unavailable_workspaces: unavailable, workspace_count: targets.length, note: '本批只扫描标明的工作区；has_more=true 时需继续 next_cursor。未授权或未配置的工作区不在搜索范围。' };
      }
      if (args.workspace_id === 'all') throw Error('Notion 读取和写入必须指定一个工作区，不能使用 all。');
      const resourceKeys = ['page_id', 'parent_page_id', 'database_id', 'data_source_id', 'block_id'].filter(key => args[key] !== undefined);
      const current = resourceKeys.some(key => args[key] === 'current');
      if (current && (!currentPageId || !currentWorkspaceId)) throw Error('Notion 原生请求没有提供当前页面，请打开页面后从右下角 AI 入口重试。');
      const primaryKey = resourceKeys[0], id = primaryKey ? args[primaryKey] === 'current' ? currentPageId : pageId(args[primaryKey]) : undefined;
      const w = select(args, id);
      if (current && w.id !== currentWorkspaceId) throw Error('Notion 当前页面不属于指定工作区，已拒绝跨区误写。');
      if (writeTools.has(name) && writeUncertain) throw Error('此前某个工作区的写入结果未确定，本轮已停止所有后续写入。');
      const { workspace_id, ...childArgs } = args;
      for (const key of resourceKeys) childArgs[key] = args[key] === 'current' ? currentPageId : pageId(args[key]);
      try {
        const result = await sessions.get(w.id).execute(name, childArgs);
        if (name === 'read_page' && args.page_id === 'current') {
          try {
            const metadata = await w.client.request(w.cfg, 'GET', `pages/${id}`, null, signal);
            result.title = pageTitle(metadata) || null;
          } catch (error) { if (signal?.aborted) throw error; result.title = null; }
          result.title_source = result.title ? 'notion-page-metadata' : 'unavailable';
        }
        for (const key of ['page_id', 'database_id', 'data_source_id', 'block_id']) if (result[key]) remember(result[key], w.id);
        if (id) remember(id, w.id);
        if (writeTools.has(name) && result.verified !== true) writeUncertain = true;
        return annotate(result, w);
      } catch (error) { if (writeTools.has(name) && !definitelyNotWritten(error)) writeUncertain = true; throw error; }
    };
    const tools = definitions.filter(d => workspaces.length && (!writeTools.has(d.function.name) || workspaces.some(w => !w.cfg.readOnly))).map(d => {
      const copy = structuredClone(d);
      copy.function.description += ' workspace_id 默认当前原生工作区；明确跨工作区搜索时可用 all，其他操作须用目标所属工作区。资源 ID 使用 current 指本轮原生当前页，创建时 parent_page_id=current 表示在当前页下创建。';
      copy.function.parameters.properties.workspace_id = { type: 'string', description: '工作区 UUID；省略或 current 为当前工作区。仅 search_pages/search_databases 支持 all，表示所有已配置工作区。' };
      return copy;
    });
    return { definitions: [listTool, ...tools], context, execute: async (name, args) => {
      try { return await execute(name, args); }
      catch (error) { if (writeTools.has(name)) notSubmitted(error); throw error; }
    } };
  }
}
function saveConnections(root, connections) {
  const file = path.join(root, registryName);
  const content = JSON.stringify({ version: 2, connections }, null, 2) + '\n';
  fs.writeFileSync(file, content, { mode: 0o600, flush: true });
  if (fs.readFileSync(file, 'utf8') !== content) throw Error('Notion 统一配置写入核验失败。');
}
async function consolidateConnections({ root, fetchImpl = fetch, intervalMs = 350 }) {
  const router = new NotionRouter({ root, fetchImpl, intervalMs });
  const profiles = router.profiles(), connections = [], importedFiles = [];
  for (const profile of profiles) {
    const client = router.client(profile), cfg = client.config();
    if (!cfg.key) throw Error('Notion 已有连接缺少密钥，暂未迁移配置。');
    const identity = await router.identify(client, cfg, AbortSignal.timeout(30000));
    if (connections.some(p => p.workspaceId === identity.id)) throw Error('Notion 同一工作区配置了重复连接。');
    connections.push({ workspaceId: identity.id, name: identity.name, apiKey: cfg.key, enabled: cfg.enabled, readOnly: cfg.readOnly, pageIds: cfg.pageIds || [], searchBatchSize: cfg.searchBatchSize });
    const source = profile || (fs.existsSync(path.join(root, 'notion.local.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'notion.local.json'), 'utf8')) : {});
    if (typeof source.apiKey !== 'string') {
      const sourceFile = path.resolve(root, source.apiKeyFile || 'notion-api-key.txt');
      if (!sourceFile.startsWith(path.resolve(root) + path.sep)) throw Error('Notion 密钥文件必须位于隔离配置目录。');
      if (fs.existsSync(sourceFile) && fs.readFileSync(sourceFile, 'utf8').trim() === cfg.key) importedFiles.push(sourceFile);
    }
  }
  saveConnections(root, connections);
  // Clear only the exact key files successfully imported and read back above.
  for (const file of importedFiles) fs.writeFileSync(file, '', { mode: 0o600, flush: true });
  return { migrated: true, connectionCount: connections.length, workspaces: connections.map(p => ({ workspace_id: p.workspaceId, name: p.name })), clearedLegacyKeyFiles: importedFiles.length };
}
async function registerConnection({ root, apiKeyFile, apiKey, fetchImpl = fetch, intervalMs = 350, settings = {} }) {
  if (apiKey === undefined) {
    if (typeof apiKeyFile !== 'string') throw Error('Notion 请填写连接密钥。');
    const absolute = path.resolve(root, apiKeyFile);
    if (!absolute.startsWith(path.resolve(root) + path.sep)) throw Error('Notion 密钥文件必须位于隔离配置目录。');
    apiKey = fs.readFileSync(absolute, 'utf8').trim();
  }
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 1024 || /[\r\n]/.test(apiKey)) throw Error('Notion 连接密钥为空或格式无效。');
  const profile = { enabled: true, readOnly: false, pageIds: [], searchBatchSize: 10, ...settings, apiKey: apiKey.trim() };
  delete profile.apiKeyFile;
  const router = new NotionRouter({ root, fetchImpl, intervalMs });
  const client = router.client(profile), cfg = client.config();
  if (!cfg.key) throw Error('Notion 本地密钥文件为空，请先填写后保存。');
  const identity = await router.identify(client, cfg, AbortSignal.timeout(30000));
  const file = path.join(root, registryName);
  if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).version === 1) await consolidateConnections({ root, fetchImpl, intervalMs });
  const connections = fs.existsSync(file) ? router.profiles() : [];
  const existing = connections.find(p => uuid(p.workspaceId) === identity.id);
  if (existing) return { connected: true, alreadyConnected: true, workspaceId: identity.id, name: identity.name };
  if (connections.length >= 16) throw Error('Notion 当前最多支持 16 个工作区。');
  connections.push({ ...profile, workspaceId: identity.id, name: identity.name });
  saveConnections(root, connections);
  return { connected: true, alreadyConnected: false, workspaceId: identity.id, name: identity.name };
}
module.exports = { NotionRouter, registryName, registerConnection, consolidateConnections, saveConnections };
