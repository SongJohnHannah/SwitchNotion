const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { McpClient, validateServer } = require('./mcp-client.cjs');
const { scopeKey } = require('./workspace-memory.cjs');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const definition = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
class AiExtensions {
  constructor({ root, memory, browser, pageFiles, generatedFiles, approve = async () => false, clientFactory = (server, options) => new McpClient(server, options) }) {
    Object.assign(this, { root, memory, browser, pageFiles, generatedFiles, approve, clientFactory }); this.file = path.join(root, 'ai-connections.local.json');
  }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, scopes: {} };
    try { if (fs.statSync(this.file).size > 2 * 1024 * 1024) throw Error(); const data = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (data.version !== 1 || !data.scopes || Array.isArray(data.scopes)) throw Error(); return data; }
    catch { throw Error('Notion MCP 本机配置无法读取，请保留文件并检查。'); }
  }
  write(data) {
    const value = JSON.stringify(data); if (Buffer.byteLength(value) > 2 * 1024 * 1024) throw Error('Notion MCP 配置过大。');
    fs.mkdirSync(this.root, { recursive: true }); const file = this.file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(file, value + '\n', { flag: 'wx', mode: 0o600, flush: true }); fs.renameSync(file, this.file); } finally { if (fs.existsSync(file)) fs.unlinkSync(file); }
  }
  servers(key, data = this.read()) { this.memory.entry(key); return data.scopes[key]?.servers || []; }
  state(key) { const data = this.read(); return { approval: data.scopes[key]?.approval === 'each' ? 'each' : 'task', browserEnabled: data.scopes[key]?.browser === true, servers: this.servers(key, data).map(({ token, ...server }) => ({ ...server, keyConfigured: !!token })) }; }
  async request(action, input) {
    try {
      const fields = { 'mcp.state': ['key'], 'mcp.save': ['key', 'id', 'name', 'transport', 'enabled', 'url', 'token', 'forgetToken', 'command', 'args'], 'mcp.remove': ['key', 'id'], 'mcp.test': ['key', 'id'], 'browser.configure': ['key', 'enabled'], 'approval.configure': ['key', 'mode'] };
      if (!Object.hasOwn(fields, action) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !fields[action].includes(k)) || JSON.stringify(input).length > 40000) throw Error('Notion MCP 配置参数无效。');
      const data = this.read(), servers = this.servers(input.key, data), before = servers.find(item => item.id === input.id);
      if (action === 'mcp.save') {
        if (input.id && !before) throw Error('Notion MCP 服务已被移除，请刷新。');
        const server = validateServer({ ...input, token: input.forgetToken ? '' : input.token || (before?.transport === input.transport && before?.url === input.url ? before.token : '') });
        if (!before && servers.length >= 12) throw Error('Notion MCP 每个工作区最多配置 12 个服务。');
        if (before) servers.splice(servers.indexOf(before), 1, server); else servers.push(server);
        data.scopes[input.key] = { ...data.scopes[input.key], servers }; this.write(data);
      } else if (action === 'mcp.remove') {
        if (!before) throw Error('Notion MCP 服务已被移除。');
        data.scopes[input.key] = { ...data.scopes[input.key], servers: servers.filter(item => item.id !== input.id) }; this.write(data);
      } else if (action === 'browser.configure') {
        if (typeof input.enabled !== 'boolean') throw Error('Notion MCP 浏览器开关无效。');
        data.scopes[input.key] = { ...data.scopes[input.key], browser: input.enabled }; this.write(data);
      } else if (action === 'approval.configure') {
        if (!['task', 'each'].includes(input.mode)) throw Error('Notion MCP 审批方式无效。');
        data.scopes[input.key] = { ...data.scopes[input.key], approval: input.mode }; this.write(data);
      } else if (action === 'mcp.test') {
        if (!before) throw Error('Notion MCP 请先保存服务。');
        const client = this.clientFactory(before, { cwd: this.root });
        try { await client.start(); const tools = await client.tools(); return { ok: true, result: { message: '连接成功，发现 ' + tools.length + ' 个工具。', tools: tools.map(item => ({ name: item.name, description: String(item.description || '').slice(0, 500) })) } }; }
        finally { client.close(); }
      }
      return { ok: true, result: this.state(input.key) };
    } catch (error) { return { ok: false, error: /^Notion (?:MCP|工作区记忆)/.test(error.message) ? error.message : 'Notion MCP 连接失败，请检查服务地址、命令和授权。' }; }
  }
  async open({ userId, spaceId, signal, task, operationScope }) {
    const key = scopeKey({ userId, spaceId }), servers = this.servers(key).filter(item => item.enabled), fingerprint = digest(this.read().scopes[key] || {}), catalogues = new Map();
    const browser = this.read().scopes[key]?.browser && this.browser?.open({ userId, spaceId, signal, check: () => check() });
    const files = this.pageFiles?.open({ userId, spaceId, signal });
    const output = this.generatedFiles?.open({ userId, spaceId, signal });
    const check = () => { signal?.throwIfAborted(); if (digest(this.read().scopes[key] || {}) !== fingerprint) throw Error('Notion MCP 服务设置已改变，请重新发送问题。'); };
    const definitions = servers.length ? [
      definition('mcp_list_tools', '查看当前工作区明确配置的 MCP 服务工具目录。服务：' + servers.map(item => item.id + ' ' + item.name).join('；'), { server_id: { type: 'string', enum: servers.map(item => item.id) } }, ['server_id']),
      definition('mcp_call_tool', '调用此前目录中存在的 MCP 工具；每次执行都需用户在原生确认框批准。只发送当前任务必要参数。失败或结果未知不重复提交。', { server_id: { type: 'string', enum: servers.map(item => item.id) }, name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, ['server_id', 'name', 'arguments'])
    ] : [];
    definitions.push(...(browser?.definitions || []));
    definitions.push(...(files?.definitions || []));
    definitions.push(...(output?.definitions || []));
    const approvedSpaces = new Set(); let approvalDenied = false;
    const mode = this.state(key).approval;
    return { definitions, check, beforeTool: async (name, args, label) => {
      check(); const target = !args.workspace_id || args.workspace_id === 'current' ? spaceId : args.workspace_id;
      if (mode === 'task' && approvedSpaces.has(target)) return;
      if (approvalDenied) throw Object.assign(Error('Notion 审批本轮修改已被拒绝，未执行后续写入。'), { writeOutcome: 'not_submitted' });
      const preview = JSON.stringify(args, null, 2);
      if (preview.length > 16000) throw Object.assign(Error('Notion 审批操作内容过长，无法完整显示，请将修改拆分。'), { writeOutcome: 'not_submitted' });
      const allowed = await this.approve({ title: '批准 Notion 修改', message: label || name, detail: '本轮任务：' + task.slice(0, 12000) + '\n\n本次修改：\n' + preview + (mode === 'task' ? '\n\n允许后，本轮任务在这个工作区内的后续 Notion 修改继续执行。' : ''), signal });
      check(); if (!allowed) { approvalDenied = true; throw Object.assign(Error('Notion 审批用户拒绝了本轮修改，未提交操作。'), { writeOutcome: 'not_submitted' }); }
      approvedSpaces.add(target);
    }, execute: async (name, args) => {
      if (browser?.definitions.some(item => item.function.name === name)) { check(); return browser.execute(name, args); }
      if (files?.definitions.some(item => item.function.name === name)) { check(); return files.execute(name, args); }
      if (output?.definitions.some(item => item.function.name === name)) { check(); return output.execute(name, args); }
      check(); const def = definitions.find(item => item.function.name === name)?.function;
      if (!def || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !Object.hasOwn(def.parameters.properties, k)) || def.parameters.required.some(k => !Object.hasOwn(args, k)) || JSON.stringify(args).length > 64000) throw Error('Notion MCP 工具参数无效。');
      const server = servers.find(item => item.id === args.server_id); if (!server) throw Error('Notion MCP 服务不属于当前工作区。');
      if (name === 'mcp_call_tool') {
        const tool = catalogues.get(server.id)?.find(item => item.name === args.name);
        if (!tool || !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) throw Error('Notion MCP 请先读取该服务的工具目录。');
        const schema = tool.inputSchema;
        if (schema.required?.some(key => !Object.hasOwn(args.arguments, key)) || schema.additionalProperties === false && Object.keys(args.arguments).some(key => !Object.hasOwn(schema.properties || {}, key))) throw Error('Notion MCP 参数缺失或包含未知字段。');
        const preview = JSON.stringify(args.arguments, null, 2); if (preview.length > 12000) throw Error('Notion MCP 参数过长，无法完整确认，请拆分请求。');
        if (!await this.approve({ title: '批准 MCP 工具操作', message: server.name + ' · ' + tool.name, detail: '当前任务：' + task.slice(0, 1000) + '\n\n服务：' + (server.url || server.command) + '\n参数：\n' + preview, signal })) throw Error('Notion MCP 用户取消了这次操作。');
        check();
      }
      const client = this.clientFactory(server, { signal, cwd: this.root });
      try {
        await client.start(); check();
        if (name === 'mcp_list_tools') {
          const tools = await client.tools(); check(); catalogues.set(server.id, tools);
          return { source: 'mcp-tool-catalogue', server: server.name, tools: tools.map(({ name, description, inputSchema }) => ({ name, description: String(description || '').slice(0, 2000), inputSchema })) };
        }
        const fresh = (await client.tools()).find(item => item.name === args.name), selected = catalogues.get(server.id)?.find(item => item.name === args.name);
        if (!fresh || digest(fresh) !== digest(selected)) throw Error('Notion MCP 工具定义已改变，请重新读取目录并确认，未执行调用。');
        const id = digest([key, operationScope, server.id, args.name, args.arguments]), dir = path.join(this.root, 'mcp-operations'), file = path.join(dir, id + '.json');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (fs.existsSync(file)) {
          const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (saved.status === 'completed') return { ...saved.result, duplicate: true };
          throw Error('Notion MCP 此操作曾经提交但结果未知，请核对外部服务，未重复执行。');
        }
        fs.writeFileSync(file, JSON.stringify({ status: 'pending', serverId: server.id, name: args.name, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600, flush: true });
        const value = await client.request('tools/call', { name: args.name, arguments: args.arguments });
        const serialized = JSON.stringify(value);
        if (serialized.length > 60000) throw Error('Notion MCP 结果超过 60,000 字符，操作可能已经完成，请在外部服务核对。');
        const result = { source: 'mcp', server: server.name, result: value, verification: 'server_response_only' };
        fs.writeFileSync(file, JSON.stringify({ status: 'completed', result }), { mode: 0o600, flush: true });
        return result;
      } finally { client.close(); }
    } };
  }
}
module.exports = { AiExtensions };
