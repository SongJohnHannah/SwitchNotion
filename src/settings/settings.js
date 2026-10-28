'use strict';
const api = window.notionSwitch;
const $ = id => document.getElementById(id);
let state, editing, removing, toastTimer, busy = false, speechRecorder, speechPoll, speechDirty = false, memoryScopes = [], transcriptPending = false, ocrPending = false;
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
function result(id, text, error = false) { const node = $(id); node.textContent = text; node.classList.toggle('error', error); node.hidden = !text; }
async function operation(container, action) {
  if (busy) return;
  busy = true; const buttons = [...container.querySelectorAll('button')]; buttons.forEach(b => { b.disabled = true; });
  try { return await action(); }
  catch { toast('操作未完成，请稍后重试。'); }
  finally { busy = false; buttons.forEach(b => { b.disabled = b.dataset.unavailable === 'true'; }); }
}
async function load() {
  const response = await api.state();
  if (!response.ok) { result('load-error', response.error, true); return; }
  state = response.result;
  if (api.memoryScopes) { const memories = await api.memoryScopes(); if (memories.ok) memoryScopes = memories.result.scopes; }
  result('load-error', ''); render();
}
function render() {
  $('workspace-count').textContent = state.workspaces.length; $('nav-count').textContent = state.workspaces.length;
  const list = $('workspace-list'); list.replaceChildren();
  if (!state.workspaces.length) { const empty = element('div', 'empty'); empty.append(element('h2', '', '添加你的第一个工作区'), element('p', '', '准备好 Notion API Key，点击右上角“添加工作区”即可。')); list.append(empty); }
  for (const workspace of state.workspaces) {
    const card = element('article', 'workspace-card'), icon = element('div', 'workspace-icon', [...workspace.name][0].toUpperCase()); icon.setAttribute('aria-hidden', 'true');
    const info = element('div', 'workspace-info'), title = element('div', 'workspace-title');
    title.append(element('span', '', workspace.name), element('span', 'badge ' + workspace.status, workspace.status === 'connected' ? '连接正常' : workspace.status === 'error' ? '需检查' : '已配置'));
    info.append(title, element('div', 'workspace-subtitle', workspace.workspaceName !== workspace.name ? 'Notion 工作区：' + workspace.workspaceName + ' · API Key 已保存' : 'API Key 已保存 · 自动识别工作区'));
    if (workspace.status !== 'saved') info.append(element('div', 'workspace-message', workspace.message));
    const actions = element('div', 'card-actions');
    for (const [text, callback, cls] of [['检测', () => operation(card, async () => { const r = await api.testWorkspace({ id: workspace.id }); if (r.ok) await load(); else { workspace.status = 'error'; workspace.message = r.error; render(); } toast(r.ok ? r.result.message : r.error); }), ''], ['编辑', () => openWorkspace(workspace), ''], ['移除', () => { removing = workspace; $('remove-description').textContent = '将“' + workspace.name + '”从本机连接列表移除。'; $('remove-dialog').showModal(); }, 'remove']]) { const button = element('button', cls, text); button.setAttribute('aria-label', text + ' ' + workspace.name); button.addEventListener('click', callback); actions.append(button); }
    const memories = element('details', 'workspace-memory'), summary = element('summary', '', '记忆与技能');
    memories.append(summary);
    const scope = memoryScopes.find(row => row.profileId === workspace.id);
    if (scope) {
      const body = element('div', 'memory-body'); memories.append(body);
      memories.addEventListener('toggle', () => { if (memories.open && !body.childNodes.length) void showMemory(body, scope.key); });
    } else memories.append(element('p', 'field-help', '先在这个工作区发送一条 AI 消息，再刷新配置，即可管理工作区记忆。'));
    info.append(memories);
    card.append(icon, info, actions); list.append(card);
  }
  const model = $('deepseek-model'); model.replaceChildren(); for (const item of state.deepseek.models) { const option = element('option', '', item.name); option.value = item.id; model.append(option); } model.value = state.deepseek.model;
  $('deepseek-status').textContent = state.deepseek.keyConfigured ? '已配置' : '尚未配置'; $('deepseek-status').classList.toggle('connected', state.deepseek.keyConfigured);
  $('deepseek-key').placeholder = state.deepseek.keyConfigured ? '已保存，留空保留现有 API Key' : '粘贴 DeepSeek API Key';
  $('deepseek-key-help').textContent = state.deepseek.keyConfigured ? '已保存的密钥不会回显。需要更换时，在这里粘贴新密钥。' : '密钥仅保存在本机。';
  $('deepseek-thinking').checked = state.deepseek.thinking; $('deepseek-effort').value = state.deepseek.reasoningEffort;
  $('deepseek-effort').disabled = !state.deepseek.thinking; $('multi-agent').checked = state.deepseek.multiAgent;
  const web = state.webSources || { enabled: false, keyConfigured: false };
  $('web-sources-enabled').checked = web.enabled; $('web-sources-forget').checked = false;
  $('web-sources-key').placeholder = web.keyConfigured ? '已保存，留空保留现有搜索密钥' : '填写后启用网页搜索';
  $('web-sources-help').textContent = web.message || (web.keyConfigured ? '已保存 Brave Search 密钥，不回显；留空保留。' : '搜索密钥独立于 DeepSeek 密钥；未配置时仅支持读取本轮明确提供的公开网址。');
}
function clearKey(id) { $(id).value = ''; $(id).type = 'password'; const button = document.querySelector('[data-toggle="' + id + '"]'); if (button) button.textContent = '显示'; }
async function showMemory(container, key, saved) {
  const response = saved ? { ok: true, result: saved } : await api.memoryGet({ key });
  container.replaceChildren();
  if (!response.ok) { container.append(element('p', 'inline-result error', response.error)); return; }
  const row = response.result;
  const perform = async (method, values) => operation(container, async () => {
    const response = await api[method]({ key, revision: row.revision, ...values });
    if (response.ok) { await showMemory(container, key, response.result); toast('已保存，后续 AI 请求使用最新设置。'); }
    else toast(response.error);
  });
  container.append(element('p', 'field-help', '记忆只用于这个工作区，保存在本机；启用后必要内容会交给已配置的 DeepSeek。'));
  const enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = row.enabled;
  const toggle = element('label', 'check-label'); toggle.append(enabled, document.createTextNode('启用本工作区记忆与技能')); container.append(toggle);
  const instructions = element('textarea', 'memory-editor'); instructions.value = row.instructions; instructions.maxLength = 16000; instructions.rows = 4; instructions.setAttribute('aria-label', '本工作区个人指令'); instructions.placeholder = '本工作区的个人指令，例如：使用中文，报告先列结论。'; container.append(instructions);
  const button = (text, fn) => { const node = element('button', 'button secondary', text); node.type = 'button'; node.addEventListener('click', fn); return node; };
  container.append(button('保存开关与指令', () => perform('memoryConfigure', { enabled: enabled.checked, instructions: instructions.value })));
  container.append(element('h3', '', '工作区记忆'));
  for (const item of row.memories) {
    const entry = element('div', 'memory-entry'), editor = element('textarea', 'memory-editor'); editor.value = item.content; editor.maxLength = 4000; editor.rows = 2; editor.setAttribute('aria-label', '编辑记忆');
    entry.append(editor, button('保存', () => perform('memorySave', { id: item.id, content: editor.value })), button('删除', () => perform('memoryRemove', { id: item.id }))); container.append(entry);
  }
  const content = element('textarea', 'memory-editor'); content.maxLength = 4000; content.rows = 2; content.placeholder = '新增一条记忆；也可以在 AI 聊天中说“记住……”'; content.setAttribute('aria-label', '新增工作区记忆'); container.append(content, button('添加记忆', () => perform('memorySave', { content: content.value })));
  if (row.memories.length) {
    const confirm = element('input'); confirm.type = 'checkbox'; const label = element('label', 'check-label'); label.append(confirm, document.createTextNode('确认清空这个工作区的全部记忆')); container.append(label, button('清空记忆', () => { if (confirm.checked) void perform('memoryClear', {}); else toast('请先勾选确认清空。'); }));
  }
  const skills = element('details'), heading = element('summary', '', '技能（' + row.skills.length + '）'); skills.append(heading);
  const skillForm = item => {
    const entry = element('div', 'memory-entry');
    const name = element('input'); name.placeholder = '技能名称，例如 周报'; name.value = item?.name || ''; name.maxLength = 80; name.setAttribute('aria-label', '技能名称');
    const description = element('input'); description.placeholder = '什么时候使用这个技能'; description.value = item?.description || ''; description.maxLength = 500; description.setAttribute('aria-label', '技能适用描述');
    const body = element('textarea', 'memory-editor'); body.placeholder = '技能的具体方法、规则和输出格式'; body.value = item?.content || ''; body.rows = 4; body.maxLength = 12000; body.setAttribute('aria-label', '技能正文');
    const automatic = element('input'); automatic.type = 'checkbox'; automatic.checked = item?.automatic === true; const autoLabel = element('label', 'check-label'); autoLabel.append(automatic, document.createTextNode('按任务相关性自动使用；关闭后用 /技能名 调用'));
    const active = element('input'); active.type = 'checkbox'; active.checked = item?.enabled !== false; const activeLabel = element('label', 'check-label'); activeLabel.append(active, document.createTextNode('启用技能'));
    entry.append(name, description, body, autoLabel, activeLabel, button(item ? '保存技能' : '新增技能', () => perform('skillSave', { ...(item ? { id: item.id } : {}), name: name.value, description: description.value, content: body.value, automatic: automatic.checked, enabled: active.checked })));
    if (item) entry.append(button('删除技能', () => perform('skillRemove', { id: item.id }))); return entry;
  };
  row.skills.forEach(item => skills.append(skillForm(item))); skills.append(skillForm()); container.append(skills);
  const sync = element('div', 'memory-entry'); sync.append(button('导出工作区记忆', () => operation(sync, async () => { const r = await api.exportMemory({ key }); toast(r.ok ? r.result.message : r.error); })), button('导入工作区记忆', () => operation(sync, async () => { const r = await api.importMemory({ key }); toast(r.ok ? r.result.message : r.error); if (r.ok) await showMemory(container, key); }))); container.append(sync);
  const connections = element('details'), summary = element('summary', '', '网页操作与 MCP 连接'); connections.append(summary); container.append(connections);
  connections.addEventListener('toggle', () => { if (connections.open && connections.childNodes.length === 1) void showMcp(connections, key); });
  const agents = element('details'); agents.append(element('summary', '', '后台 Agent 与通知')); container.append(agents);
  agents.addEventListener('toggle', () => { if (agents.open && agents.childNodes.length === 1) void showBackground(agents, key); });
  const chats = element('details'); chats.append(element('summary', '', '对话共享、导出与导入')); container.append(chats);
  chats.addEventListener('toggle', () => { if (chats.open && chats.childNodes.length === 1) void showChatTransfer(chats, key); });
}
async function showChatTransfer(container, key) {
  while (container.childNodes.length > 1) container.lastChild.remove();
  const r = await api.transferList({ key }); if (!r.ok) { container.append(element('p', 'inline-result error', r.error)); return; }
  container.append(element('p', 'field-help', 'JSON 导入导出用于你自己的 Windows、Mac 之间同步文字对话；只允许同一账号、同一工作区。原始附件需要重新上传。'));
  const select = element('select'); select.setAttribute('aria-label', '选择要导出的对话');
  r.result.threads.forEach(item => { const option = element('option', '', item.title + (item.running ? '（生成中）' : '')); option.value = item.id; option.disabled = item.running; select.append(option); }); container.append(select);
  for (const [label, method] of [['导出所选对话', 'exportChat'], ['导入文字对话', 'importChat']]) {
    const button = element('button', 'button secondary', label); button.type = 'button'; button.disabled = method === 'exportChat' && !r.result.threads.some(item => !item.running);
    button.addEventListener('click', () => operation(container, async () => { const response = await api[method]({ key, ...(method === 'exportChat' ? { id: select.value } : {}) }); toast(response.ok ? response.result.message : response.error); if (response.ok) await showChatTransfer(container, key); })); container.append(button);
  }
  const share = element('div', 'memory-entry');
  share.append(element('p', 'field-help', '共享只读 HTML，可直接在 Windows、Mac 浏览器打开。不会包含原始附件或配置密钥。未设密码时，持有文件的人可以查看；发出后无法远程撤回。'));
  const passwordLabel = element('label', '', '查看密码（可选，8–128 个字符）'), password = element('input', 'memory-editor'); password.type = 'password'; password.maxLength = 128; password.autocomplete = 'new-password'; password.setAttribute('aria-label', '共享对话查看密码'); passwordLabel.append(password); share.append(passwordLabel);
  const includeSources = element('input'); includeSources.type = 'checkbox'; const sourcesLabel = element('label', 'check-label'); sourcesLabel.append(includeSources, document.createTextNode('包含当时的引用资料（可能含页面正文）')); share.append(sourcesLabel);
  const shareButton = element('button', 'button secondary', '共享所选对话为只读 HTML'); shareButton.type = 'button'; shareButton.dataset.unavailable = String(!r.result.threads.some(item => !item.running)); shareButton.disabled = shareButton.dataset.unavailable === 'true';
  shareButton.addEventListener('click', () => operation(container, async () => { const response = await api.shareChat({ key, id: select.value, password: password.value, includeSources: includeSources.checked }); password.value = ''; toast(response.ok ? response.result.message : response.error); })); share.append(shareButton); container.append(share);
}
async function showBackground(container, key) {
  while (container.childNodes.length > 1) container.lastChild.remove();
  const r = await api.backgroundState({ key }); if (!r.ok) { container.append(element('p', 'inline-result error', r.error)); return; }
  container.append(element('p', 'field-help', '任务在 NotionSwitch 运行期间按时执行；退出程序后暂停。失败或执行中退出会停用自动运行，防止重复修改。结果在这里查看，完成或失败会发系统通知。'));
  const statuses = { idle: '待执行', running: '执行中', needs_approval: '等待确认修改', interrupted: '程序退出中断', completed: '完成', stopped: '已停止', failed: '失败', needs_review: '需要核对写入结果' };
  const button = (parent, label, method, values) => { const node = element('button', 'button secondary', label); node.type = 'button'; node.addEventListener('click', () => operation(parent, async () => { const response = await api[method]({ key, ...values() }); if (response.ok) await showBackground(container, key); else toast(response.error); })); parent.append(node); };
  const refresh = element('button', 'button secondary', '刷新执行结果'); refresh.type = 'button'; refresh.addEventListener('click', () => operation(container, () => showBackground(container, key))); container.append(refresh);
  const form = job => {
    const body = element('div', 'memory-entry'), input = (placeholder, value = '') => { const node = element('input'); node.placeholder = placeholder; node.value = value; node.setAttribute('aria-label', placeholder); body.append(node); return node; };
    if (job) { body.append(element('strong', '', statuses[job.status] || job.status)); if (job.nextAt && job.enabled) body.append(element('p', 'field-help', '下次：' + new Date(job.nextAt).toLocaleString('zh-CN', { timeZone: job.timezone }) + ' · ' + job.timezone)); }
    const title = input('任务名称', job?.title), prompt = element('textarea', 'memory-editor'); prompt.placeholder = '这个工作区需要 AI 完成的具体任务'; prompt.setAttribute('aria-label', '后台任务指令'); prompt.value = job?.prompt || ''; prompt.maxLength = 12000; prompt.rows = 3; body.append(prompt);
    const schedule = element('select'); schedule.setAttribute('aria-label', '后台任务触发方式');
    for (const [value, label] of [['manual', '仅手动运行'], ['interval', '按间隔执行'], ['daily', '每天定时执行'], ['page-change', '页面内容变化后执行']]) { const option = element('option', '', label); option.value = value; schedule.append(option); } schedule.value = job?.schedule || 'manual'; body.append(schedule);
    const interval = input('间隔分钟（至少 5）', String(job?.everyMinutes || 60)); interval.type = 'number'; interval.min = '5'; interval.max = '10080';
    const time = input('每天执行时间', job?.time || '09:00'); time.type = 'time'; const zone = input('时区', job?.timezone || 'Asia/Shanghai'), page = input('目标 Notion 页面 ID（页面变化触发时必填）', job?.pageId || '');
    const enabled = input(''); enabled.type = 'checkbox'; enabled.checked = job?.enabled === true; const label = element('label', 'check-label'); label.append(enabled, document.createTextNode('启用自动触发')); body.append(label);
    const visibility = () => { interval.hidden = !['interval', 'page-change'].includes(schedule.value); time.hidden = zone.hidden = schedule.value !== 'daily'; label.hidden = schedule.value === 'manual'; }; schedule.addEventListener('change', visibility); visibility();
    button(body, job ? '保存任务' : '新增任务', 'backgroundSave', () => ({ ...(job ? { id: job.id } : {}), title: title.value, prompt: prompt.value, schedule: schedule.value, everyMinutes: Number(interval.value), time: time.value, timezone: zone.value, pageId: page.value.trim(), enabled: enabled.checked && schedule.value !== 'manual' }));
    if (job) { button(body, '立即运行', 'backgroundRun', () => ({ id: job.id })); button(body, '停止并停用', 'backgroundStop', () => ({ id: job.id })); button(body, '删除任务', 'backgroundRemove', () => ({ id: job.id })); if (job.error) body.append(element('p', 'inline-result error', job.error)); if (job.result) body.append(element('pre', 'inline-result', job.result)); }
    return body;
  };
  r.result.jobs.forEach(job => container.append(form(job))); container.append(form());
}
async function showMcp(container, key) {
  const response = await api.mcpState({ key });
  while (container.childNodes.length > 1) container.lastChild.remove();
  if (!response.ok) { container.append(element('p', 'inline-result error', response.error)); return; }
  const browser = element('input'); browser.type = 'checkbox'; browser.checked = response.result.browserEnabled; const browserLabel = element('label', 'check-label'); browserLabel.append(browser, document.createTextNode('启用本工作区 AI 网页操作（独立窗口）')); container.append(browserLabel);
  browser.addEventListener('change', () => operation(container, async () => { const response = await api.browserConfigure({ key, enabled: browser.checked }); if (!response.ok) toast(response.error); await showMcp(container, key); }));
  const approval = element('select'); approval.setAttribute('aria-label', 'Notion 页面修改审批');
  for (const [value, label] of [['task', '页面修改：每轮任务按工作区确认'], ['each', '页面修改：每项操作分别确认']]) { const option = element('option', '', label); option.value = value; approval.append(option); } approval.value = response.result.approval; container.append(approval);
  approval.addEventListener('change', () => operation(container, async () => { const response = await api.approvalConfigure({ key, mode: approval.value }); if (!response.ok) toast(response.error); await showMcp(container, key); }));
  container.append(element('p', 'field-help', '服务只用于本工作区。每次执行 MCP 工具会弹出确认框；密钥保存在本机，不发送给模型。'));
  const form = item => {
    const body = element('div', 'memory-entry'), field = (label, value = '', type = 'text') => { const node = element('input'); node.type = type; node.value = value; node.placeholder = label; node.setAttribute('aria-label', label); body.append(node); return node; };
    const name = field('服务名称', item?.name), transport = element('select'); transport.setAttribute('aria-label', 'MCP 传输类型');
    for (const [value, label] of [['http', 'Streamable HTTP'], ['sse', '旧版 HTTP + SSE'], ['stdio', '本机 stdio']]) { const option = element('option', '', label); option.value = value; transport.append(option); } transport.value = item?.transport || 'http'; body.append(transport);
    const url = field('服务 URL，例如 https://example.com/mcp', item?.url), token = field(item?.keyConfigured ? '已保存服务密钥，留空保留' : '服务 Bearer Token（可选）', '', 'password');
    const forget = field(''); forget.type = 'checkbox'; const forgetLabel = element('label', 'check-label'); forgetLabel.append(forget, document.createTextNode('清除服务凭据（含 OAuth 登录）')); body.append(forgetLabel);
    const command = field('本机命令或可执行文件路径', item?.command), args = field('参数 JSON 数组，例如 ["/路径/server.js"]', JSON.stringify(item?.args || []));
    const enabled = field(''); enabled.type = 'checkbox'; enabled.checked = item?.enabled !== false; const enabledLabel = element('label', 'check-label'); enabledLabel.append(enabled, document.createTextNode('启用此服务')); body.append(enabledLabel);
    const visibility = () => { url.hidden = token.hidden = forgetLabel.hidden = transport.value === 'stdio'; command.hidden = args.hidden = transport.value !== 'stdio'; }; transport.addEventListener('change', visibility); visibility();
    const action = (label, callback) => { const node = element('button', 'button secondary', label); node.type = 'button'; node.addEventListener('click', () => operation(body, callback)); body.append(node); };
    action(item ? '保存服务' : '添加服务', async () => {
      let argumentsList; try { argumentsList = JSON.parse(args.value); } catch { toast('命令参数需要填写 JSON 字符串数组。'); return; }
      const response = await api.mcpSave({ key, ...(item ? { id: item.id } : {}), name: name.value, transport: transport.value, enabled: enabled.checked, ...(transport.value !== 'stdio' ? { url: url.value, token: token.value, forgetToken: forget.checked } : { command: command.value, args: argumentsList }) });
      if (response.ok) { await showMcp(container, key); toast('MCP 已保存。'); } else toast(response.error);
    });
    if (item) {
      action('检测连接', async () => { const response = await api.mcpTest({ key, id: item.id }); toast(response.ok ? response.result.message : response.error); });
      if (item.transport !== 'stdio') {
        body.append(element('p', 'field-help', item.oauthConnected ? item.oauthExpired ? 'OAuth 登录已过期，请重新登录。' : '已通过 OAuth 登录此服务。' : '需要网页登录的服务可使用 OAuth；在系统浏览器确认服务和所需权限。'));
        const clientId = field('OAuth Client ID（支持自动注册时留空）'), scope = field('OAuth 权限范围（通常留空）');
        const cancel = element('button', 'button secondary', '取消登录'); cancel.type = 'button'; cancel.disabled = true; cancel.dataset.unavailable = 'true';
        cancel.addEventListener('click', async () => { cancel.disabled = true; await api.mcpCancel({ key, id: item.id }); });
        action(item.oauthConnected ? '重新 OAuth 登录' : 'OAuth 登录', async () => {
          cancel.disabled = false; toast('正在打开系统浏览器，请完成授权；可在这里取消。');
          try { const response = await api.mcpLogin({ key, id: item.id, clientId: clientId.value, scope: scope.value }); if (response.ok) { await showMcp(container, key); toast('OAuth 登录已保存。'); } else toast(response.error); }
          finally { cancel.disabled = true; }
        });
        body.append(cancel);
        if (item.oauthConnected) action('退出 OAuth 登录', async () => { const response = await api.mcpLogout({ key, id: item.id }); if (response.ok) { await showMcp(container, key); toast('已移除本机登录凭据。'); } else toast(response.error); });
      }
      action('移除服务', async () => { const response = await api.mcpRemove({ key, id: item.id }); if (response.ok) await showMcp(container, key); else toast(response.error); });
    }
    return body;
  };
  response.result.servers.forEach(item => container.append(form(item))); container.append(form());
}
function openWorkspace(workspace) {
  editing = workspace || null; $('workspace-form').reset(); clearKey('workspace-key'); result('workspace-result', '');
  $('dialog-title').textContent = editing ? '编辑工作区' : '添加工作区'; $('save-workspace').textContent = editing ? '保存修改' : '添加工作区';
  $('workspace-name').value = editing?.name || ''; $('workspace-key').required = !editing;
  $('workspace-key').placeholder = editing ? '已保存，留空保留现有 API Key' : '粘贴 Notion 连接密钥';
  $('workspace-key-help').textContent = editing ? '密钥留空即可保留；需要更换时粘贴新密钥。' : '只保存在本机，工作区会自动识别。';
  $('workspace-dialog').showModal(); $('workspace-name').focus();
}
function closeWorkspace() { if (busy) return; $('workspace-dialog').close(); clearKey('workspace-key'); editing = null; }
function workspaceInput() { return { ...(editing ? { id: editing.id } : {}), name: $('workspace-name').value, apiKey: $('workspace-key').value }; }
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('active', item === button));
  $('workspaces-view').hidden = button.dataset.view !== 'workspaces'; $('deepseek-view').hidden = button.dataset.view !== 'deepseek'; $('login-view').hidden = button.dataset.view !== 'login';
  $('updates-view').hidden = button.dataset.view !== 'updates';
  $('speech-view').hidden = button.dataset.view !== 'speech';
  $('collection-view').hidden = button.dataset.view !== 'collection';
  if (button.dataset.view === 'collection') void checkCollection();
  clearKey('deepseek-key'); clearKey('web-sources-key'); result('provider-result', '');
  if (button.dataset.view === 'login') checkLogin();
  if (button.dataset.view === 'updates') checkUpdates();
  clearInterval(speechPoll);
  if (button.dataset.view === 'speech') { checkSpeech(); speechPoll = setInterval(() => void checkSpeech().catch(() => {}), 750); }
  else if (speechRecorder?.state !== 'idle') void speechRecorder?.cancel();
}));
document.querySelectorAll('[data-toggle]').forEach(button => button.addEventListener('click', () => { const input = $(button.dataset.toggle); input.type = input.type === 'password' ? 'text' : 'password'; button.textContent = input.type === 'password' ? '显示' : '隐藏'; }));
$('add-workspace').addEventListener('click', () => openWorkspace());
$('refresh').addEventListener('click', () => operation($('workspaces-view'), load));
$('open-notion').addEventListener('click', async () => { const r = await api.openNotion(); if (!r.ok) toast(r.error); }); $('help').addEventListener('click', () => api.help());
$('close-dialog').addEventListener('click', closeWorkspace); $('cancel-dialog').addEventListener('click', closeWorkspace);
$('workspace-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('workspace-dialog').addEventListener('close', () => clearKey('workspace-key'));
$('workspace-form').addEventListener('submit', event => { event.preventDefault(); operation($('workspace-form'), async () => {
  result('workspace-result', '正在识别并保存工作区…'); const r = await api.saveWorkspace(workspaceInput());
  if (!r.ok) { result('workspace-result', r.error, true); return; }
  clearKey('workspace-key'); $('workspace-dialog').close(); editing = null; await load(); toast(r.result.message);
}); });
$('test-workspace').addEventListener('click', () => operation($('workspace-form'), async () => {
  result('workspace-result', '正在检测连接…'); const input = workspaceInput(); delete input.name;
  const r = await api.testWorkspace(input); result('workspace-result', r.ok ? r.result.workspaceName + ' · ' + r.result.message : r.error, !r.ok);
}));
$('cancel-remove').addEventListener('click', () => $('remove-dialog').close());
$('remove-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('confirm-remove').addEventListener('click', () => operation($('remove-dialog'), async () => { const r = await api.removeWorkspace({ id: removing.id }); if (r.ok) { $('remove-dialog').close(); removing = null; await load(); } toast(r.ok ? r.result.message : r.error); }));
$('test-deepseek').addEventListener('click', () => operation($('deepseek-form'), async () => { result('provider-result', '正在检测 DeepSeek…'); const r = await api.testDeepseek({ apiKey: $('deepseek-key').value }); result('provider-result', r.ok ? r.result.message : r.error, !r.ok); }));
$('deepseek-thinking').addEventListener('change', () => { $('deepseek-effort').disabled = !$('deepseek-thinking').checked; });
$('test-web-sources').addEventListener('click', () => operation($('web-sources-form'), async () => {
  result('web-sources-result', '正在用固定检测词检查搜索连接…'); const response = await api.testWebSources({ apiKey: $('web-sources-key').value });
  result('web-sources-result', response.ok ? response.result.message : response.error, !response.ok);
}));
$('web-sources-form').addEventListener('submit', event => { event.preventDefault(); operation($('web-sources-form'), async () => {
  const response = await api.saveWebSources({ enabled: $('web-sources-enabled').checked ? 'enabled' : 'disabled', apiKey: $('web-sources-key').value, forgetKey: $('web-sources-forget').checked ? 'enabled' : 'disabled' });
  result('web-sources-result', response.ok ? response.result.message : response.error, !response.ok);
  if (response.ok) { clearKey('web-sources-key'); await load(); toast(response.result.message); }
}); });
async function checkCollection() {
  const response = await api.collectionState();
  if (!response.ok) { result('collection-result', response.error, true); return; }
  const settings = response.result.settings;
  $('collection-transcribe').checked = settings.transcribe; $('collection-vision').checked = settings.vision;
  $('collection-compress').checked = settings.compress; $('collection-local').checked = settings.keepLocal; $('collection-quality').value = settings.quality;
  $('collection-destination').textContent = settings.destination ? '默认保存到：' + settings.destination.workspaceName + ' / ' + settings.destination.label : '尚未设置默认位置，请在收集窗口中搜索并选择。';
}
$('open-collection').addEventListener('click', async () => { const response = await api.openCollection(); if (!response.ok) toast(response.error); });
$('collection-form').addEventListener('submit', event => { event.preventDefault(); operation($('collection-form'), async () => {
  const response = await api.saveCollection({ transcribe: $('collection-transcribe').checked, vision: $('collection-vision').checked, compress: $('collection-compress').checked,
    keepLocal: $('collection-local').checked, quality: $('collection-quality').value });
  result('collection-result', response.ok ? response.result.message : response.error, !response.ok);
}); });
async function checkLogin() {
  const r = await api.loginStatus();
  if (!r.ok) { result('login-result', r.error, true); return; }
  $('sync-login').dataset.unavailable = String(r.result.syncSupported === false);
  $('sync-login').disabled = r.result.syncSupported === false;
  const interactive = r.result.syncSupported === false && r.result.loginStrategy === 'interactive';
  const macSync = r.result.syncSupported === true && r.result.loginStrategy === 'macos-keychain-copy';
  $('login-sync-help').hidden = interactive || macSync;
  $('login-interactive-help').hidden = !interactive;
  $('login-mac-help').hidden = !macSync;
  $('sync-login').hidden = interactive;
  $('open-login-notion').hidden = !interactive && !macSync;
  if (interactive) {
    $('login-title').textContent = r.result.hasLogin === true ? '已检测到保存的登录信息' : r.result.hasLogin === false ? '尚未检测到本机登录信息' : '暂时无法检查登录状态';
    $('login-description').textContent = r.result.hasLogin === true ? '已在本机找到登录信息；会话是否仍有效，以 Notion 窗口为准。' : '请打开 Notion 窗口，按提示登录或确认当前会话。';
    result('login-result', '登录信息保存在此应用的独立资料中。');
    return;
  }
  if (macSync) {
    $('login-title').textContent = r.result.hasLogin === true ? '已检测到保存的登录信息' : r.result.hasLogin === false ? '尚未检测到本机登录信息' : '暂时无法检查登录状态';
    $('login-description').textContent = r.result.message;
    result('login-result', r.result.lastSync?.message || '检查仅确认本机登录信息是否存在；是否仍有效，以 Notion 窗口为准。', !!r.result.lastSync && r.result.lastSync.status !== 'applied');
    return;
  }
  $('login-title').textContent = r.result.hasLogin ? '已检测到保存的登录信息' : '尚未检测到有效的本机登录信息';
  $('login-description').textContent = r.result.syncSupported === false ? r.result.message : r.result.hasLogin ? '无需重复复制。若 Notion 窗口仍要求登录，可以重新同步。' : r.result.message;
  result('login-result', r.result.lastSync?.message || '检查仅确认本机登录信息是否存在；是否仍有效，以 Notion 窗口为准。', !!r.result.lastSync && r.result.lastSync.status !== 'applied');
}
$('check-login').addEventListener('click', () => operation($('login-card'), checkLogin));
$('open-login-notion').addEventListener('click', async () => { const r = await api.openNotion(); if (!r.ok) toast(r.error); });
$('sync-login').addEventListener('click', () => $('login-dialog').showModal());
$('cancel-login').addEventListener('click', () => { if (!busy) $('login-dialog').close(); });
$('login-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('confirm-login').addEventListener('click', () => operation($('login-dialog'), async () => {
  result('login-result', '正在准备本机登录同步…'); const r = await api.syncLogin(); $('login-dialog').close();
  result('login-result', r.ok ? r.result.message : r.error, !r.ok); if (r.ok) toast('登录信息已准备好，NotionSwitch 即将自动重启。');
}));
$('deepseek-form').addEventListener('submit', event => { event.preventDefault(); operation($('deepseek-form'), async () => { result('provider-result', '正在检测并保存…'); const r = await api.saveDeepseek({ apiKey: $('deepseek-key').value, model: $('deepseek-model').value, thinking: $('deepseek-thinking').checked ? 'enabled' : 'disabled', reasoningEffort: $('deepseek-effort').value, multiAgent: $('multi-agent').checked ? 'enabled' : 'disabled' }); result('provider-result', r.ok ? r.result.message : r.error, !r.ok); if (r.ok) { clearKey('deepseek-key'); await load(); toast(r.result.message); } }); });
async function checkUpdates() {
  const r = await api.updateStatus(); if (!r.ok) { result('updates-result', r.error, true); return; }
  const info = r.result; $('updates-title').textContent = info.available ? '检测到本机 Notion 更新' : '每次启动自动检查';
  $('updates-versions').textContent = '本机原版 ' + info.originalVersion + ' · 当前原型 ' + info.prototypeVersion;
  const automatic = info.automaticCompatibility;
  $('updates-web').textContent = automatic ? '网页自动适配已开启 · 本次已检查 ' + automatic.checked + ' 个脚本 · 自动适配 ' + automatic.adapted + ' 个 · 不兼容 ' + automatic.blocked + ' 个' : '网页模块加载时自动检查。';
  $('updates-message').textContent = info.message; $('rollback-update').hidden = !info.previousVersion;
  result('updates-result', info.lastResult || '', !info.compatible || !info.clientCompatible);
}
$('check-updates').addEventListener('click', () => operation($('updates-card'), checkUpdates));
$('apply-update').addEventListener('click', () => operation($('updates-card'), async () => { const r = await api.updateNotion(); result('updates-result', r.ok ? r.result.message : r.error, !r.ok); }));
$('rollback-update').addEventListener('click', () => operation($('updates-card'), async () => { const r = await api.rollbackNotion(); result('updates-result', r.ok ? r.result.message : r.error, !r.ok); }));
async function checkSpeech() {
  if (ocrPending && api.ocrState) void checkOcr();
  if (transcriptPending && api.transcriptState) void checkTranscript();
  const response = await api.speechStatus(); if (!response.ok) { result('speech-result', response.error, true); return; }
  const s = response.result;
  $('speech-backend').textContent = `${s.engineName} · ${s.modelName} · ${s.hardwareLabel} · ${s.computeType}`;
  $('speech-status').textContent = !s.supported ? '系统暂不支持' : s.ready ? '离线引擎就绪' : s.configured ? '已配置' : '尚未准备';
  if (!speechDirty) { $('speech-enabled').checked = s.enabled; $('speech-model').value = s.model || 'medium'; $('speech-summary').checked = s.autoSummary !== false; $('speech-system-audio').checked = s.inputMode !== 'microphone'; $('speech-attach-audio').checked = s.autoAttachAudio !== false; }
  const imports = s.audioImports;
  $('speech-audio-state').textContent = imports ? (imports.capturing ? '正在为会议保留待保存的音频。' : imports.active ? '正在后台保存会议音频，不影响录音收尾。' : '会议音频已保存 ' + imports.saved + ' 场 · 待处理 ' + imports.pending + ' 场') + (imports.lastError ? ' ' + imports.lastError : '') : '';
  $('retry-meeting-audio').hidden = !imports?.failed;
  const progress = s.progress, bar = $('speech-progress');
  bar.hidden = !(s.preparing && progress?.total && Number.isFinite(progress.received));
  if (!bar.hidden) bar.value = Math.min(100, progress.received / progress.total * 100);
  if (s.preparing && progress?.message) {
    const size = bytes => bytes >= 1e9 ? (bytes / 1e9).toFixed(2) + ' GB' : (bytes / 1e6).toFixed(1) + ' MB';
    const amount = progress.total ? ` ${Math.floor(bar.value)}% · ${size(progress.received)} / ${size(progress.total)}` : '';
    const speed = Number.isFinite(progress.bytesPerSecond) ? ` · ${size(Date.now() - progress.updatedAt > 3000 ? 0 : progress.bytesPerSecond)}/s` : '';
    result('speech-result', progress.message + amount + speed);
  }
  $('speech-description').textContent = s.loaded ? `模型已载入 ${s.hardwareLabel}；空闲后自动释放，下一次使用会重新载入。` : s.configured ? `已发现本机 ${s.modelName} 模型，下一次使用时载入。` : '尚未准备；点击“检测并准备”会自动下载缺少的组件，首次需要联网。';
  $('speech-native-state').textContent = s.nativeMeetingAdapter ? '保存后重新打开 Notion 页面生效。' : '离线引擎可独立测试；原生速记接入尚未启用。';
  $('speech-enabled').disabled = !s.nativeMeetingAdapter; $('save-speech').disabled = !s.nativeMeetingAdapter;
  $('save-speech').dataset.unavailable = String(!s.nativeMeetingAdapter);
}
$('prepare-speech').addEventListener('click', () => operation($('speech-card'), async () => {
  result('speech-result', '正在查找所选模型并检测当前系统的离线引擎…');
  const r = await api.prepareSpeech(); result('speech-result', r.ok ? r.result.message : r.error, !r.ok); if (r.ok) await checkSpeech();
}));
speechRecorder = new window.SpeechRecorder(api, value => {
  $('test-speech').textContent = value.state === 'recording' ? '停止并转写' : value.state === 'transcribing' ? '正在转写…' : '录音测试';
  $('test-speech').disabled = ['preparing', 'transcribing'].includes(value.state);
  if (value.message) result('speech-result', value.message, value.state === 'error');
  if (value.state === 'preparing') $('speech-transcript').hidden = true;
  if (value.state === 'preparing') { $('speech-playback').hidden = true; $('speech-playback').removeAttribute('src'); }
  if (value.playbackUrl) { $('speech-playback').src = value.playbackUrl; $('speech-playback').hidden = false; }
  if (value.result) {
    result('speech-result', value.result.message + ` 耗时 ${(value.result.elapsedMs / 1000).toFixed(2)} 秒。`);
    $('speech-transcript').textContent = value.result.text || '未检测到清晰人声。'; $('speech-transcript').hidden = false;
  }
});
$('test-speech').addEventListener('click', () => { if (speechRecorder.state === 'recording') speechRecorder.stop(); else if (speechRecorder.state === 'idle' && !busy) void speechRecorder.start(); });
window.addEventListener('pagehide', () => { clearInterval(speechPoll); speechRecorder.clearPlayback(); void speechRecorder.cancel(); });
$('release-speech').addEventListener('click', () => operation($('speech-card'), async () => { const r = await api.releaseSpeech(); result('speech-result', r.ok ? r.result.message : r.error, !r.ok); await checkSpeech(); }));
for (const id of ['speech-model', 'speech-enabled', 'speech-summary', 'speech-system-audio', 'speech-attach-audio']) $(id).addEventListener('change', () => { speechDirty = true; });
$('save-speech').addEventListener('click', () => operation($('speech-card'), async () => { const r = await api.saveSpeech({ enabled: $('speech-enabled').checked, model: $('speech-model').value, autoSummary: $('speech-summary').checked, autoAttachAudio: $('speech-attach-audio').checked, inputMode: $('speech-system-audio').checked ? 'meeting' : 'microphone' }); result('speech-result', r.ok ? r.result.message : r.error, !r.ok); if (r.ok) speechDirty = false; await checkSpeech(); }));
$('retry-meeting-audio').addEventListener('click', () => operation($('speech-card'), async () => { result('speech-result', '正在重试保存会议录音…'); const r = await api.retryMeetingAudio(); result('speech-result', r.ok ? r.result.message : r.error, !r.ok); await checkSpeech(); }));
async function checkTranscript(response) {
  const r = response || await api.transcriptState(); if (!r.ok) { toast(r.error); return; }
  const job = r.result; transcriptPending = ['running', 'queued', 'preparing'].includes(job.status);
  $('transcript-start').disabled = transcriptPending; $('transcript-start').dataset.unavailable = String(transcriptPending); $('transcript-stop').hidden = !transcriptPending; $('transcript-save').hidden = job.status !== 'completed';
  $('transcript-prepare').disabled = transcriptPending; $('transcript-prepare').dataset.unavailable = String(transcriptPending);
  $('transcript-progress').textContent = (job.filename ? job.filename + ' · ' : '') + (job.error || job.progress || '选择文件后开始本机转写。');
  $('transcript-text').hidden = !job.text; $('transcript-text').textContent = job.text || '';
}
$('transcript-start').addEventListener('click', () => operation($('speech-view'), async () => { const r = await api.transcriptStart(); await checkTranscript(r); }));
$('transcript-prepare').addEventListener('click', () => operation($('speech-view'), async () => { await checkTranscript(await api.transcriptPrepare()); }));
$('transcript-stop').addEventListener('click', async () => { await checkTranscript(await api.transcriptStop()); });
$('transcript-save').addEventListener('click', () => operation($('speech-view'), async () => { const r = await api.transcriptSave(); if (!r.ok) toast(r.error); }));
async function checkOcr(response) {
  if (!response && !api.ocrState) return;
  const r = response || await api.ocrState(); if (!r.ok) { toast(r.error); return; }
  ocrPending = r.result.preparing;
  $('ocr-state').textContent = r.result.engine + (r.result.error ? ' · ' + r.result.error : r.result.progress ? ' · ' + r.result.progress : '');
  $('ocr-prepare').disabled = ocrPending; $('ocr-prepare').dataset.unavailable = String(ocrPending); $('ocr-stop').hidden = !ocrPending;
}
$('ocr-prepare').addEventListener('click', () => operation($('speech-view'), async () => { await checkOcr(await api.ocrPrepare()); }));
$('ocr-stop').addEventListener('click', async () => { await checkOcr(await api.ocrStop()); });
document.querySelector('[data-view="speech"]').addEventListener('click', () => { if (api.transcriptState) void checkTranscript(); void checkOcr(); });
if (!api) result('load-error', '请通过“NotionSwitch 配置”快捷方式打开此窗口。', true);
else load().then(async () => { const r = await api.updateStatus(); if (r.ok && r.result.openOnStartup) document.querySelector('[data-view="updates"]').click(); }).catch(() => result('load-error', '配置暂时无法加载，请关闭窗口后重新打开。', true));
