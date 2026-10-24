'use strict';
const api = window.notionSwitch;
const $ = id => document.getElementById(id);
let state, editing, removing, toastTimer, busy = false, speechRecorder, speechPoll, speechDirty = false;
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
  state = response.result; result('load-error', ''); render();
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
    card.append(icon, info, actions); list.append(card);
  }
  const model = $('deepseek-model'); model.replaceChildren(); for (const item of state.deepseek.models) { const option = element('option', '', item.name); option.value = item.id; model.append(option); } model.value = state.deepseek.model;
  $('deepseek-status').textContent = state.deepseek.keyConfigured ? '已配置' : '尚未配置'; $('deepseek-status').classList.toggle('connected', state.deepseek.keyConfigured);
  $('deepseek-key').placeholder = state.deepseek.keyConfigured ? '已保存，留空保留现有 API Key' : '粘贴 DeepSeek API Key';
  $('deepseek-key-help').textContent = state.deepseek.keyConfigured ? '已保存的密钥不会回显。需要更换时，在这里粘贴新密钥。' : '密钥仅保存在本机。';
  $('deepseek-thinking').checked = state.deepseek.thinking; $('deepseek-effort').value = state.deepseek.reasoningEffort;
  $('deepseek-effort').disabled = !state.deepseek.thinking; $('multi-agent').checked = state.deepseek.multiAgent;
}
function clearKey(id) { $(id).value = ''; $(id).type = 'password'; const button = document.querySelector('[data-toggle="' + id + '"]'); if (button) button.textContent = '显示'; }
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
  clearKey('deepseek-key'); result('provider-result', '');
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
async function checkLogin() {
  const r = await api.loginStatus();
  if (!r.ok) { result('login-result', r.error, true); return; }
  $('sync-login').dataset.unavailable = String(r.result.syncSupported === false);
  $('sync-login').disabled = r.result.syncSupported === false;
  $('login-title').textContent = r.result.hasLogin ? '已检测到保存的登录信息' : '尚未检测到有效的本机登录信息';
  $('login-description').textContent = r.result.syncSupported === false ? r.result.message : r.result.hasLogin ? '无需重复复制。若 Notion 窗口仍要求登录，可以重新同步。' : r.result.message;
  result('login-result', r.result.lastSync?.message || '检查仅确认本机登录信息是否存在；是否仍有效，以 Notion 窗口为准。', !!r.result.lastSync && r.result.lastSync.status !== 'applied');
}
$('check-login').addEventListener('click', () => operation($('login-card'), checkLogin));
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
  $('updates-message').textContent = info.message; $('rollback-update').hidden = !info.previousVersion;
  result('updates-result', info.lastResult || '', !info.compatible || !info.clientCompatible);
}
$('check-updates').addEventListener('click', () => operation($('updates-card'), checkUpdates));
$('apply-update').addEventListener('click', () => operation($('updates-card'), async () => { const r = await api.updateNotion(); result('updates-result', r.ok ? r.result.message : r.error, !r.ok); }));
$('rollback-update').addEventListener('click', () => operation($('updates-card'), async () => { const r = await api.rollbackNotion(); result('updates-result', r.ok ? r.result.message : r.error, !r.ok); }));
async function checkSpeech() {
  const response = await api.speechStatus(); if (!response.ok) { result('speech-result', response.error, true); return; }
  const s = response.result;
  $('speech-backend').textContent = `${s.engineName} · ${s.modelName} · ${s.hardwareLabel} · ${s.computeType}`;
  $('speech-status').textContent = !s.supported ? '系统暂不支持' : s.ready ? '离线引擎就绪' : s.configured ? '已配置' : '尚未准备';
  if (!speechDirty) { $('speech-enabled').checked = s.enabled; $('speech-model').value = s.model || 'medium'; }
  if (s.preparing && s.progress?.message) {
    const percentage = s.progress.total ? ` ${Math.min(100, Math.floor(s.progress.received / s.progress.total * 100))}%` : '';
    result('speech-result', s.progress.message + percentage);
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
  if (value.result) {
    result('speech-result', value.result.message + ` 耗时 ${(value.result.elapsedMs / 1000).toFixed(2)} 秒。`);
    $('speech-transcript').textContent = value.result.text || '未检测到清晰人声。'; $('speech-transcript').hidden = false;
  }
});
$('test-speech').addEventListener('click', () => { if (speechRecorder.state === 'recording') speechRecorder.stop(); else if (speechRecorder.state === 'idle' && !busy) void speechRecorder.start(); });
window.addEventListener('pagehide', () => { clearInterval(speechPoll); void speechRecorder.cancel(); });
$('release-speech').addEventListener('click', () => operation($('speech-card'), async () => { const r = await api.releaseSpeech(); result('speech-result', r.ok ? r.result.message : r.error, !r.ok); await checkSpeech(); }));
for (const id of ['speech-model', 'speech-enabled']) $(id).addEventListener('change', () => { speechDirty = true; });
$('save-speech').addEventListener('click', () => operation($('speech-card'), async () => { const r = await api.saveSpeech({ enabled: $('speech-enabled').checked, model: $('speech-model').value }); result('speech-result', r.ok ? r.result.message : r.error, !r.ok); if (r.ok) speechDirty = false; await checkSpeech(); }));
if (!api) result('load-error', '请通过“NotionSwitch 配置”快捷方式打开此窗口。', true);
else load().then(async () => { const r = await api.updateStatus(); if (r.ok && r.result.openOnStartup) document.querySelector('[data-view="updates"]').click(); }).catch(() => result('load-error', '配置暂时无法加载，请关闭窗口后重新打开。', true));
