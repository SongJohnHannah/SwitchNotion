const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { NotionRouter, registryName, consolidateConnections, saveConnections } = require('./notion-routing.cjs');
const { ProviderRouter } = require('./provider.cjs');
const { models } = require('./native-models.cjs');
const idFor = profile => createHash('sha256').update(profile.workspaceId || profile.apiKey || profile.apiKeyFile).digest('hex').slice(0, 24);
const keyText = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\r\n]/.test(value.trim())) throw Error('请填写有效的 API Key。');
  return value.trim();
};
const label = value => {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.trim().length > 80 || /[\x00-\x1f]/.test(value)) throw Error('名称请控制在 80 个字以内。');
  return value.trim();
};
class SettingsService {
  constructor({ root, fetchImpl = fetch, intervalMs = 350 }) {
    this.root = root; this.fetchImpl = fetchImpl;
    this.router = new NotionRouter({ root, fetchImpl, intervalMs });
    this.provider = new ProviderRouter({ root, fetchImpl });
    this.queue = Promise.resolve(); this.health = new Map();
  }
  async profiles() {
    const file = path.join(this.root, registryName);
    if (!fs.existsSync(file)) {
      const legacy = this.router.client(null).config();
      if (!legacy.key) { saveConnections(this.root, []); return []; }
      await consolidateConnections({ root: this.root, fetchImpl: this.fetchImpl, intervalMs: this.router.intervalMs });
    }
    const profiles = this.router.profiles();
    if (profiles.some(p => p.apiKeyFile)) await consolidateConnections({ root: this.root, fetchImpl: this.fetchImpl, intervalMs: this.router.intervalMs });
    return this.router.profiles();
  }
  publicProfile(profile) {
    return { id: idFor(profile), name: profile.name || profile.workspaceName || '未命名工作区', workspaceName: profile.workspaceName || profile.name || '保存时自动识别', keyConfigured: !!profile.apiKey, status: this.health.get(idFor(profile))?.status || 'saved', message: this.health.get(idFor(profile))?.message || '已保存连接' };
  }
  async state() {
    const profiles = await this.profiles(), status = this.provider.status();
    return { workspaces: profiles.map(p => this.publicProfile(p)), deepseek: { keyConfigured: status.keyConfigured === true, model: models.some(m => m.apiId === status.model) ? status.model : 'deepseek-flash', thinking: status.thinking === true, reasoningEffort: status.reasoningEffort || 'high', multiAgent: status.multiAgent !== false, models: models.map(m => ({ id: m.apiId, name: m.label })) } };
  }
  async identity(apiKey) {
    const profile = { apiKey }, client = this.router.client(profile);
    return this.router.identify(client, client.config(), AbortSignal.timeout(30000));
  }
  async testWorkspace(input) {
    const profiles = await this.profiles();
    const profile = input.id ? profiles.find(p => idFor(p) === input.id) : null;
    if (input.id && !profile) throw Error('该工作区已被移除，请刷新后重试。');
    const apiKey = input.apiKey?.trim() ? keyText(input.apiKey) : profile?.apiKey;
    if (!apiKey) throw Error('请先填写 API Key。');
    const identity = await this.identity(apiKey);
    if (profile?.workspaceId && identity.id !== profile.workspaceId) throw Error('这个 API Key 属于另一个工作区。请用“添加工作区”保存它，当前连接没有修改。');
    const client = this.router.client({ apiKey });
    const pages = await client.request(client.config(), 'POST', 'search', { filter: { value: 'page', property: 'object' }, page_size: 1 }, AbortSignal.timeout(30000));
    const result = { workspaceName: identity.name, status: 'connected', message: pages.results?.length ? '连接正常，可以访问已授权页面' : '连接正常；请在 Notion 中把需要使用的页面授权给此连接' };
    if (profile) this.health.set(idFor(profile), result);
    return result;
  }
  async saveWorkspace(input) {
    const profiles = await this.profiles();
    const index = input.id ? profiles.findIndex(p => idFor(p) === input.id) : -1;
    if (input.id && index < 0) throw Error('该工作区已被移除，请刷新后重试。');
    const before = profiles[index], name = label(input.name);
    const apiKey = input.apiKey?.trim() ? keyText(input.apiKey) : before?.apiKey;
    if (!apiKey) throw Error('请填写 Notion API Key。');
    let identity;
    if (!before || apiKey !== before.apiKey || !before.workspaceId) identity = await this.identity(apiKey);
    else identity = { id: before.workspaceId, name: before.workspaceName || before.name };
    if (before?.workspaceId && identity.id !== before.workspaceId) throw Error('这个 API Key 属于另一个工作区。请用“添加工作区”保存它，当前连接没有修改。');
    if (profiles.some((p, i) => i !== index && p.workspaceId === identity.id)) throw Error('这个工作区已经添加过了，请在列表中点击“编辑”。');
    if (!before && profiles.length >= 16) throw Error('目前最多可以添加 16 个工作区。');
    const profile = { enabled: true, readOnly: false, pageIds: [], searchBatchSize: 10, ...before, workspaceId: identity.id, workspaceName: identity.name, name: name || identity.name, apiKey };
    delete profile.apiKeyFile;
    if (before) profiles[index] = profile; else profiles.push(profile);
    saveConnections(this.root, profiles); this.health.delete(idFor(profile));
    return { workspace: this.publicProfile(profile), message: before ? '已保存修改，下一轮 AI 对话生效' : '工作区已添加，可以回到 Notion 使用 AI' };
  }
  async removeWorkspace(input) {
    const profiles = await this.profiles(), index = profiles.findIndex(p => idFor(p) === input.id);
    if (index < 0) throw Error('该工作区已被移除，请刷新列表。');
    profiles.splice(index, 1); saveConnections(this.root, profiles); this.health.delete(input.id);
    return { message: '已从本机移除连接，Notion 中的页面未更改' };
  }
  deepseekConfig() {
    const file = path.join(this.root, 'provider.local.json');
    let config;
    try { config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; }
    catch { throw Error('DeepSeek 配置无法读取，请联系开发者修复。'); }
    return { ...config, maxTokens: 'max', baseUrl: 'https://api.deepseek.com', apiKeyFile: 'deepseek-api-key.txt' };
  }
  async testDeepseek(input) {
    const config = this.deepseekConfig(), apiKey = input.apiKey?.trim() ? keyText(input.apiKey) : this.provider.key(config);
    if (!apiKey) throw Error('请先填写 DeepSeek API Key。');
    let response;
    try { response = await this.fetchImpl('https://api.deepseek.com/models', { headers: { authorization: 'Bearer ' + apiKey }, signal: AbortSignal.timeout(30000), redirect: 'error' }); }
    catch { throw Error('DeepSeek 暂时连接不上，请检查网络后重试。'); }
    if (!response.ok) { await response.body?.cancel(); throw Error(response.status === 401 ? 'DeepSeek API Key 无效，请检查后重试。' : 'DeepSeek 连接检测失败，请稍后重试。'); }
    let data; try { data = await response.json(); } catch { throw Error('DeepSeek 返回异常，请稍后重试。'); }
    const available = models.filter(m => data.data?.some(item => item.id === m.apiId)).map(m => m.apiId);
    if (!available.length) throw Error('当前 DeepSeek 密钥下未找到原型支持的模型，请检查模型权限。');
    return { message: 'DeepSeek 连接正常', availableModels: available };
  }
  async saveDeepseek(input) {
    if (!models.some(m => m.apiId === input.model)) throw Error('请选择列表中的 DeepSeek 模型。');
    if (input.thinking !== undefined && !['enabled', 'disabled'].includes(input.thinking)) throw Error('请选择有效的思考模式。');
    if (input.reasoningEffort !== undefined && !['low', 'high', 'max'].includes(input.reasoningEffort)) throw Error('请选择有效的思考强度。');
    if (input.multiAgent !== undefined && !['enabled', 'disabled'].includes(input.multiAgent)) throw Error('请选择有效的协同模式。');
    const config = this.deepseekConfig(), apiKey = input.apiKey?.trim() ? keyText(input.apiKey) : this.provider.key(config);
    const checked = await this.testDeepseek({ apiKey });
    if (!checked.availableModels.includes(input.model)) throw Error('当前 API Key 无权使用这个模型，请选择另一个模型。');
    fs.writeFileSync(path.join(this.root, 'deepseek-api-key.txt'), apiKey, { mode: 0o600, flush: true });
    fs.writeFileSync(path.join(this.root, 'provider.local.json'), JSON.stringify({ ...config, mode: 'deepseek', model: input.model, keySource: 'local', thinking: input.thinking || config.thinking || 'disabled', reasoningEffort: input.reasoningEffort || config.reasoningEffort || 'high', multiAgent: input.multiAgent === undefined ? config.multiAgent !== false : input.multiAgent === 'enabled' }, null, 2) + '\n', { mode: 0o600, flush: true });
    return { message: 'DeepSeek 已保存，下一轮 AI 对话生效' };
  }
  request(action, input = {}) {
    const methods = { state: 'state', 'workspace.save': 'saveWorkspace', 'workspace.test': 'testWorkspace', 'workspace.remove': 'removeWorkspace', 'deepseek.save': 'saveDeepseek', 'deepseek.test': 'testDeepseek' };
    const allowed = { state: [], 'workspace.save': ['id', 'name', 'apiKey'], 'workspace.test': ['id', 'apiKey'], 'workspace.remove': ['id'], 'deepseek.save': ['apiKey', 'model', 'thinking', 'reasoningEffort', 'multiAgent'], 'deepseek.test': ['apiKey'] };
    const job = async () => {
      if (!Object.hasOwn(methods, action) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed[action].includes(k)) || Object.values(input).some(v => typeof v !== 'string' || v.length > 1024)) return { ok: false, error: '无法识别这项操作，请刷新后重试。' };
      try { return { ok: true, result: await this[methods[action]](input) }; }
      catch (error) {
        const message = String(error.message || '');
        if (/^Notion API 返回 HTTP 401\b/.test(message)) return { ok: false, error: 'Notion API Key 无效，请重新复制连接密钥。' };
        if (/^Notion API 返回 HTTP (?:403|404)\b/.test(message)) return { ok: false, error: '无法访问页面，请检查连接权限，并在 Notion 中授权页面。' };
        // Never forward raw parser, transport or upstream response errors.
        const safe = /^(请|该工作区|这个|当前|目前|DeepSeek |Notion (?:API 返回 HTTP|当前连接未返回|统一配置写入核验失败|统一工作区配置不是有效 JSON|工作区连接配置))/.test(message) && !/(?:ntn_|secret_|sk-)[a-zA-Z0-9_-]{8}/.test(message);
        return { ok: false, error: safe ? message : '操作未完成，请检查网络和 API Key 后重试。' };
      }
    };
    const next = this.queue.then(job); this.queue = next.catch(() => {}); return next;
  }
}
module.exports = { SettingsService };
