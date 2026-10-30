'use strict';
const api = window.collection, $ = id => document.getElementById(id);
let state, chosen, expanded = false, activePanel = 'destination', selectedJob, destinationResults = [], cursors = {}, searchTimer, refreshTimer, searchVersion = 0, promptDraft, promptTab = 'article', checkingAccounts = false;
const names = { paragraph: '正文', heading: '标题', quote: '引用', list: '列表', code: '代码', divider: '分隔', link: '链接', image: '图片', video: '视频', audio: '音频' };
const statuses = { queued: '等待中', reading: '识别中', downloading: '下载中', processing: '转写／识别', uploading: '上传中', saving: '保存中', awaiting_selection: '待选择', needs_login: '需登录／检查完整性', completed: '已保存', partial: '待补全', failed: '失败', cancelled: '已停止', interrupted: '可继续' };
const active = ['queued', 'reading', 'downloading', 'processing', 'uploading', 'saving'];
const element = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
function message(text, error = false) { $('message').textContent = text || ''; $('message').hidden = !text; $('message').classList.toggle('error', error); }
async function request(action, input) { const response = await api.request(action, input); if (!response.ok) { message(response.error, true); throw Error(response.error); } return response.result; }
function button(label, callback, cls = 'text') { const b = element('button', cls, label); b.type = 'button'; b.addEventListener('click', () => Promise.resolve().then(callback).catch(() => {})); return b; }
function setExpanded(value) { expanded = value; $('expanded').hidden = !value; $('expand').textContent = value ? '收起选项 ⌃' : '展开选项 ⌄'; $('expand').setAttribute('aria-expanded', String(value)); void api.request('expand', { expanded: value }); if (value && activePanel === 'destination') void loadWorkspaces().catch(() => {}); }
function setPanel(name, focus = false) {
  activePanel = name;
  for (const tab of document.querySelectorAll('[data-tab]')) { const current = tab.dataset.tab === name; tab.setAttribute('aria-selected', String(current)); tab.tabIndex = current ? 0 : -1; if (current && focus) tab.focus(); }
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
  if (expanded && name === 'destination') void loadWorkspaces().catch(() => {});
}
function readOptions() {
  return { transcribe: $('transcribe').checked, vision: $('vision').checked, compress: $('compress').checked, keepLocal: $('keepLocal').checked,
    quality: $('quality').value, types: [...$('type-options').querySelectorAll('input:checked')].map(i => i.value), destination: chosen, extraction: state.settings.extraction };
}
function showOptions(options) { for (const id of ['transcribe', 'vision', 'compress', 'keepLocal']) $(id).checked = options[id]; $('quality').value = options.quality;
  for (const input of $('type-options').querySelectorAll('input')) input.checked = options.types.includes(input.value); }
async function refresh() {
  const first = !state; state = await request('state');
  if (first) { chosen = state.settings.destination; showOptions(state.settings); $('shortcut-input').value = state.settings.shortcut; $('browser-port').value = state.settings.browserPort; $('browser-path').value = state.settings.browserExecutable; $('browser-profile').value = state.settings.browserProfile || ''; $('proxy').value = state.settings.proxy; }
  $('shortcut').textContent = state.settings.shortcut.replace('CommandOrControl', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl').replaceAll('+', ' ');
  $('destination-pill').textContent = chosen ? (chosen.workspaceName ? chosen.workspaceName + ' / ' : '') + chosen.label + ' ⌄' : '选择工作区、数据库或页面 ⌄';
  $('queue-state').textContent = state.active ? state.active + ' 个任务处理中' : '支持链接与本地路径，原始内容优先';
  $('prompt-status').textContent = ({ auto: '✧ 自动提取 · 文章 / 音视频', article: '✧ 文章精读模板', video: '✧ 音视频提取模板', off: '仅保存原文 · 未启用 AI 提取' })[state.settings.extraction.mode];
  $('keep-history').checked = state.settings.keepHistory;
  $('last-result').hidden = !state.latestCompletion;
  $('components').textContent = (state.binaries.downloader ? '下载器已就绪' : '下载器待准备') + ' · ' + (state.binaries.ffmpeg ? '媒体处理已就绪' : '媒体处理待准备') + (state.lastError ? ' · ' + state.lastError : '');
  $('prepare').disabled = state.preparing;
  $('local-directory').textContent = '本地资料保存到：' + (state.settings.outputDirectory || state.defaultDownloadDirectory || '系统下载目录 / NotionSwitch') + ' / 链接标题';
  if (state.shortcutError || state.configError) message(state.shortcutError || state.configError, true);
  renderFavorites(); renderTasks();
  if (selectedJob) renderSelection(state.jobs.find(j => j.id === selectedJob));
}
async function loadWorkspaces() {
  if ($('workspace').dataset.loaded) return;
  const data = await request('workspaces'), select = $('workspace'); select.replaceChildren(element('option', '', '选择工作区'));
  select.options[0].value = '';
  for (const item of data.workspaces) { const option = element('option', '', item.name + (item.readOnly ? '（只读）' : '')); option.value = item.id; option.disabled = item.readOnly; select.append(option); }
  select.value = chosen?.workspaceId || data.workspaces.find(w => !w.readOnly)?.id || ''; select.dataset.loaded = '1';
  if (select.value) await searchDestinations();
}
async function searchDestinations(more = false) {
  const version = ++searchVersion;
  const workspaceId = $('workspace').value; if (!workspaceId) return;
  const result = await request('destinations', { workspaceId, query: $('destination-search').value.trim(), cursors: more ? cursors : {} });
  if (version !== searchVersion) return;
  cursors = result.cursors; destinationResults = more ? [...destinationResults, ...result.results] : result.results;
  const list = $('destinations'); list.replaceChildren();
  if (!destinationResults.length) list.append(element('p', 'hint', '没有找到已授权位置。请在 Notion 目标页面中添加对应连接。'));
  for (const item of destinationResults) {
    const b = button('', () => choose(item), 'destination-item');
    b.dataset.id = item.id; b.dataset.workspaceId = item.workspaceId;
    const indicator = element('span', 'destination-selected', '✓ 已选中'); indicator.setAttribute('aria-hidden', 'true');
    b.append(element('span', 'destination-label', (item.kind === 'database' ? '▦  ' : '▤  ') + item.label), element('small', '', item.kind === 'database' ? '数据库' : '父页面'), indicator); list.append(b);
  }
  updateDestinationSelection();
  $('more-destinations').hidden = !result.hasMore;
}
function updateDestinationSelection() {
  for (const node of document.querySelectorAll('.destination-item, .favorite-chip')) {
    const selected = node.dataset.id === chosen?.id && node.dataset.workspaceId === chosen?.workspaceId;
    node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected));
    const indicator = node.querySelector('.destination-selected'); if (indicator) indicator.hidden = !selected;
    const check = node.querySelector('.favorite-check'); if (check) check.hidden = !selected;
  }
  for (const id of ['favorite', 'default-destination', 'open-destination']) $(id).disabled = !chosen;
  $('create-library').disabled = !chosen || chosen.kind !== 'page' || chosen.workspaceId !== $('workspace').value;
  const favorite = state?.settings.favorites.some(item => item.id === chosen?.id && item.workspaceId === chosen?.workspaceId);
  $('favorite').textContent = favorite ? '★ 已收藏 · 点击取消' : '☆ 收藏当前位置';
}
function choose(item) { chosen = item; $('destination-pill').textContent = item.workspaceName + ' / ' + item.label + ' ⌄'; updateDestinationSelection(); void refresh().catch(() => {}); }
function renderFavorites() {
  const root = $('favorites'); root.replaceChildren();
  if (!state.settings.favorites.length) root.append(element('div', 'favorites-empty', '收藏常用位置，下次点击卡片即可切换。'));
  for (const item of state.settings.favorites) {
    const b = button('', () => choose(item), 'favorite-chip'), copy = element('span', 'favorite-copy'), check = element('span', 'favorite-check', '✓');
    b.dataset.id = item.id; b.dataset.workspaceId = item.workspaceId; check.setAttribute('aria-hidden', 'true');
    const star = element('span', 'favorite-star', '★'); star.setAttribute('aria-hidden', 'true');
    copy.append(element('strong', '', item.label), element('small', '', item.workspaceName)); b.append(star, copy, check); root.append(b);
  }
  updateDestinationSelection();
}
async function submit(preview) {
  if (!preview && !chosen) { setPanel('destination'); setExpanded(true); message('请先搜索并选择保存位置。', true); return; }
  const result = await request('create', { input: $('links').value, options: readOptions(), preview });
  const pending = result.jobs.filter(job => job.status !== 'completed');
  const waiting = pending.find(job => ['awaiting_selection', 'needs_login'].includes(job.status));
  $('links').value = ''; message(!pending.length ? '此来源已保存，无需重复收集；点击下方打开 Notion。' : waiting ? '此来源已有待处理内容，请在下方完成选择或登录。' : preview ? '正在识别内容，完成后可逐项选择。' : '已加入后台队列，可以收起窗口继续工作。');
  if (waiting || preview && pending.length) { selectedJob = (waiting || pending[0]).id; setExpanded(true); } await refresh();
}
function renderSelection(job) {
  if (!job?.preview) { $('selection-section').hidden = true; return; }
  $('selection-section').hidden = false; $('selection-title').textContent = job.title + (job.preview.incomplete ? ' · 当前内容尚不完整' : '');
  const root = $('selection-list'), previous = new Map([...root.querySelectorAll('input')].map(i => [i.value, i.checked])); root.replaceChildren();
  for (const item of job.preview.nodes) { const label = element('label', 'selection-item'), input = document.createElement('input'); input.type = 'checkbox'; input.value = item.id; input.checked = previous.has(item.id) ? previous.get(item.id) : !job.selectedIds || job.selectedIds.includes(item.id);
    input.disabled = !['awaiting_selection', 'needs_login'].includes(job.status); label.append(input, element('span', 'kind', names[item.kind]), element('span', 'excerpt', item.text || item.caption || '按原文位置保存此媒体')); root.append(label); }
  $('save-selected').disabled = !['awaiting_selection', 'needs_login'].includes(job.status); $('save-selected').textContent = job.preview.incomplete ? '保存所选的已获取内容' : '收集所选内容';
  $('reread').hidden = !!job.page || active.includes(job.status); $('reread').textContent = job.local ? '重新读取文件' : '重新读取原文';
}
function renderTasks() {
  const filter = $('status-filter').value, query = $('task-search').value.trim().toLowerCase();
  const jobs = state.jobs.filter(j => (filter === 'all' || filter === 'active' && active.includes(j.status) || filter === 'completed' && j.status === 'completed' || filter === 'attention' && !active.includes(j.status) && j.status !== 'completed') && (j.title + ' ' + j.url + ' ' + j.options.destination?.label).toLowerCase().includes(query));
  $('tasks-section').hidden = !state.jobs.length;
  $('tasks-summary').textContent = state.settings.keepHistory ? '本机收集记录（' + state.jobs.length + '）' : '当前处理与待补全（' + state.jobs.length + '）';
  const root = $('tasks'); root.replaceChildren(); if (!jobs.length) root.append(element('div', 'empty', '当前筛选下没有内容'));
  for (const job of jobs.slice(0, 100)) { const card = element('article', 'task ' + job.status), title = element('div', 'task-title', job.title); title.append(element('span', 'badge', statuses[job.status] || job.status));
    card.append(title, element('div', 'task-meta', (job.local ? '本地音视频' : new URL(job.url).hostname) + ' · ' + (job.options.destination?.label || '尚未选择位置')), element('div', 'task-message', job.message));
    const actions = element('div', 'task-actions');
    if (job.preview) actions.append(button(['awaiting_selection', 'needs_login'].includes(job.status) ? '选择内容' : '查看内容', () => { selectedJob = job.id; renderSelection(job); }));
    if (job.page) actions.append(button('打开 Notion ↗', () => request('open-page', { id: job.id })));
    if (job.status === 'completed') actions.append(button('重新收集为新记录', async () => { await request('create', { input: job.url, options: readOptions(), force: true }); await refresh(); }));
    if (active.includes(job.status)) actions.append(button('停止', async () => { await request('cancel', { id: job.id }); await refresh(); }));
    if (['failed', 'partial', 'cancelled', 'interrupted', 'needs_login'].includes(job.status)) actions.append(button('继续／重试', async () => { await request('retry', { id: job.id }); await refresh(); }));
    if (job.canDelete) {
      const remove = button('删除任务', async () => {
        remove.disabled = true;
        try {
          const result = await request('delete-task', { id: job.id });
          if (selectedJob === job.id) { selectedJob = undefined; renderSelection(null); }
          await refresh(); message(result.message);
        } catch (error) { card.querySelector('.task-message').textContent = '删除未完成：' + error.message; }
        finally { remove.disabled = false; }
      }, 'text danger');
      remove.title = '删除本机任务及相关文件，保留已保存的 Notion 页面和原始本地文件'; actions.append(remove);
    }
    actions.append(button(job.local ? '打开文件位置' : '打开原文／登录', () => request('open-source', { id: job.id })));
    if (job.options.keepLocal && job.status === 'completed') actions.append(button('本地副本', () => request('open-local', { id: job.id })));
    card.append(actions); root.append(card);
  }
}
async function accounts(verify = false) {
  if (checkingAccounts) return;
  checkingAccounts = true;
  const control = $('check-accounts'), feedback = $('accounts-feedback'), root = $('accounts');
  if (verify) message('');
  control.disabled = true; control.textContent = '检测中…'; root.setAttribute('aria-busy', 'true');
  if (verify) for (const node of root.querySelectorAll('.account:not(.wechat)')) {
    node.classList.remove('valid', 'missing'); node.classList.add('checking');
    node.querySelector('.account-status').replaceChildren(element('span', 'status-dot'), document.createTextNode('正在检测…'));
    const note = node.querySelector('.account-note'); if (note) note.hidden = true;
  }
  feedback.hidden = false; feedback.classList.remove('error'); feedback.textContent = verify ? '正在检测网站登录状态，可继续收集，无需等待…' : '正在准备平台列表…';
  try {
    const data = await request('accounts', { verify });
    root.replaceChildren();
    for (const site of data) {
      const wechat = site.id === 'wechat', node = element('div', 'account ' + site.state + (wechat ? ' wechat' : '')), copy = element('div', 'account-copy');
      const icons = { douyin: '♪', xiaohongshu: '红', bilibili: 'B', tiktok: '♪', youtube: '▶', x: 'X', wechat: '微' };
      const icon = element('span', 'account-icon ' + site.id, icons[site.id] || '↗'); icon.setAttribute('aria-hidden', 'true');
      const labels = { valid: '登录有效', missing: '需要登录', saved: '收集时检查', deferred: '收集时检查', unknown: /超时|连接|启动/.test(site.message || '') ? '连接未完成' : /安全验证/.test(site.message || '') ? '需安全验证' : '暂未确认', link: '分享时检查' };
      const status = element('div', 'account-status'); status.title = site.message || '访问权限以实际读取结果为准。';
      status.append(element('span', 'status-dot'), document.createTextNode(wechat ? labels.link : labels[site.state] || labels.deferred));
      copy.append(element('div', 'account-name', site.name), status);
      if (wechat) copy.append(element('div', 'account-note', '复制微信分享链接后，直接收集即可尝试。'));
      const action = button(wechat ? '使用说明' : site.state === 'missing' ? '去登录' : '打开 ↗', async () => {
        if (wechat) { $('wechat-help').showModal(); return; }
        try { const result = await request('login', { site: site.id }); feedback.classList.remove('error'); feedback.textContent = result.message; message(result.message); }
        catch (error) { feedback.classList.add('error'); feedback.textContent = '网站未能打开：' + error.message; }
      });
      if (!wechat) { action.title = '在收集浏览器中打开' + site.name; action.setAttribute('aria-label', '打开' + site.name + '网站'); }
      node.append(icon, copy, action); root.append(node);
    }
    const unknown = data.filter(site => site.state === 'unknown'), valid = data.filter(site => site.state === 'valid').length;
    feedback.textContent = verify ? '检测完成 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' · ' + valid + ' 个已确认' + (unknown.length ? '，' + unknown.length + ' 个待确认。' : '。') : '可直接收集，需要登录时会提示。';
  } catch (error) { root.replaceChildren(); feedback.classList.add('error'); feedback.textContent = '检测未完成：' + error.message; }
  finally { checkingAccounts = false; control.disabled = false; control.textContent = '检测登录状态'; root.setAttribute('aria-busy', 'false'); }
}
$('capture-form').addEventListener('submit', event => { event.preventDefault(); void submit(false).catch(() => {}); });
const linksInput = $('links');
const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files') || event.dataTransfer?.files.length > 0;
// File drops outside the input must not navigate away from the collection window.
for (const type of ['dragover', 'drop']) document.addEventListener(type, event => {
  if (hasFiles(event)) { event.preventDefault(); if (type === 'dragover') event.dataTransfer.dropEffect = 'none'; }
});
for (const type of ['dragenter', 'dragover']) linksInput.addEventListener(type, event => {
  if (!hasFiles(event)) return;
  event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; linksInput.classList.add('file-dragover');
});
function clearFileDrag() { linksInput.classList.remove('file-dragover'); }
linksInput.addEventListener('dragleave', clearFileDrag);
document.addEventListener('drop', clearFileDrag);
document.addEventListener('dragend', clearFileDrag);
window.addEventListener('blur', clearFileDrag);
linksInput.addEventListener('drop', event => {
  if (!hasFiles(event)) return;
  event.preventDefault(); event.stopPropagation(); clearFileDrag();
  try {
    const files = [...event.dataTransfer.files];
    if (!files.length) throw Error('请从 Finder 或资源管理器拖入本机文件，或直接粘贴完整路径。');
    const paths = files.map(file => api.getPathForFile(file));
    if (paths.some(path => !path || /[\r\n\0]/.test(path))) throw Error('无法读取拖入文件的完整路径，请从 Finder 或资源管理器拖入本机文件，或直接粘贴路径。');
    const existing = new Set(linksInput.value.split(/\r?\n/).map(line => line.trim().replace(/^['"]|['"]$/g, '')));
    const additions = [...new Set(paths)].filter(path => !existing.has(path));
    const value = linksInput.value + (additions.length && linksInput.value && !linksInput.value.endsWith('\n') ? '\n' : '') + additions.join('\n');
    if (value.length > 65536 || paths.length > 30) throw Error('每次最多添加 30 个文件，输入内容不能超过 65536 个字符。');
    linksInput.value = value; linksInput.focus(); linksInput.setSelectionRange(value.length, value.length); linksInput.scrollTop = linksInput.scrollHeight;
    message(additions.length ? '已添加 ' + additions.length + ' 个文件路径；本地收集支持音频和视频，点击收集后开始处理。' : '这些文件路径已在输入框中。');
  } catch (error) { message(error.message || '无法读取文件路径，请直接粘贴完整路径。', true); }
});
$('links').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit(false).catch(() => {}); } });
$('preview').addEventListener('click', () => void submit(true).catch(() => {}));
$('expand').addEventListener('click', () => setExpanded(!expanded)); $('destination-pill').addEventListener('click', () => { setPanel('destination'); setExpanded(true); }); $('hide').addEventListener('click', () => api.request('hide'));
for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => setPanel(tab.dataset.tab));
  tab.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('[data-tab]')], index = tabs.indexOf(tab);
    const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (next !== undefined) { event.preventDefault(); setPanel(tabs[next].dataset.tab, true); }
  });
}
for (const id of ['wechat-help-close', 'wechat-help-done']) $(id).addEventListener('click', () => $('wechat-help').close());
$('wechat-yuanbao').addEventListener('click', () => void request('login', { site: 'wechat' }).then(result => { $('wechat-help').close(); message(result.message); }).catch(() => {}));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) api.request('hide'); });
function editPromptTab(kind) {
  if (promptDraft) promptDraft[promptTab] = $('prompt-editor').value;
  promptTab = kind; $('prompt-editor').value = promptDraft[kind]; $('prompt-editor').scrollTop = 0;
  $('prompt-label').textContent = (kind === 'article' ? '文章精读' : '音视频提取') + '提示词 · 可自由修改';
  for (const tab of ['article', 'video']) $('tab-' + tab).setAttribute('aria-selected', String(tab === kind));
}
async function openPrompts() {
  if (!state) await refresh(); promptDraft = structuredClone(state.settings.extraction); promptTab = 'article';
  $('prompt-editor').value = promptDraft.article; $('extraction-mode').value = promptDraft.mode;
  $('prompt-error').hidden = true; editPromptTab('article');
  await api.request('expand', { expanded: true }); $('prompt-dialog').showModal(); $('prompt-editor').focus({ preventScroll: true }); $('prompt-editor').setSelectionRange(0, 0); $('prompt-editor').scrollTop = 0;
}
function closePrompts() { $('prompt-dialog').close(); }
$('prompt-open').addEventListener('click', () => void openPrompts().catch(() => {}));
$('prompt-status').addEventListener('click', () => void openPrompts().catch(() => {}));
$('prompt-close').addEventListener('click', closePrompts); $('prompt-cancel').addEventListener('click', closePrompts);
$('prompt-dialog').addEventListener('close', () => { promptDraft = null; void api.request('expand', { expanded }); });
for (const kind of ['article', 'video']) $('tab-' + kind).addEventListener('click', () => editPromptTab(kind));
$('prompt-reset').addEventListener('click', () => { $('prompt-editor').value = state.promptTemplates[promptTab]; });
$('prompt-form').addEventListener('submit', async event => {
  event.preventDefault(); promptDraft[promptTab] = $('prompt-editor').value; promptDraft.mode = $('extraction-mode').value;
  $('prompt-save').disabled = true;
  try { await request('configure', { settings: { extraction: promptDraft } }); await refresh(); closePrompts(); message('提取要求已保存，下一次收集将使用这份模板。'); }
  catch (error) { $('prompt-error').textContent = error.message; $('prompt-error').hidden = false; }
  finally { $('prompt-save').disabled = false; }
});
$('keep-history').addEventListener('change', () => void request('configure', { settings: { keepHistory: $('keep-history').checked } }).then(refresh).catch(() => {}));
$('last-result').addEventListener('click', () => state.latestCompletion && void request('open-page', { id: state.latestCompletion.id }).catch(() => {}));
$('connections').addEventListener('click', () => api.request('settings'));
$('refresh-workspaces').addEventListener('click', () => { delete $('workspace').dataset.loaded; void loadWorkspaces().catch(() => {}); });
$('workspace').addEventListener('change', () => void searchDestinations().catch(() => {})); $('search').addEventListener('click', () => void searchDestinations().catch(() => {}));
$('destination-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => void searchDestinations().catch(() => {}), 450); });
$('more-destinations').addEventListener('click', () => void searchDestinations(true).catch(() => {}));
$('default-destination').addEventListener('click', () => void request('configure', { settings: { destination: chosen } }).then(() => { message('已设为默认保存位置。'); return refresh(); }).catch(() => {}));
$('open-destination').addEventListener('click', () => chosen && void request('open-destination', { target: chosen }).catch(() => {}));
$('create-library').addEventListener('click', () => {
  if (!chosen || chosen.kind !== 'page' || chosen.workspaceId !== $('workspace').value) { message('请先在上方搜索并选择当前工作区中的一个父页面。', true); return; }
  void request('create-library', { workspaceId: chosen.workspaceId, parentId: chosen.id }).then(result => { chosen = result.destination; message(result.message); return refresh(); }).catch(() => {});
});
$('favorite').addEventListener('click', () => { if (!chosen) return; const favorites = state.settings.favorites.filter(d => d.id !== chosen.id || d.workspaceId !== chosen.workspaceId); if (favorites.length === state.settings.favorites.length) favorites.push(chosen); void request('configure', { settings: { favorites } }).then(refresh).catch(() => {}); });
$('save-defaults').addEventListener('click', () => void request('configure', { settings: readOptions() }).then(() => { message('已保存默认收集选项。'); return refresh(); }).catch(() => {}));
$('choose-directory').addEventListener('click', () => void request('directory').then(result => result.path && request('configure', { settings: { outputDirectory: result.path } })).then(refresh).catch(() => {}));
$('open-downloads').addEventListener('click', () => void request('open-downloads').catch(() => {}));
$('choose-browser').addEventListener('click', () => void request('browser').then(result => { if (result.path) $('browser-path').value = result.path; }).catch(() => {}));
$('choose-profile').addEventListener('click', () => void request('profile').then(result => { if (result.path) $('browser-profile').value = result.path; }).catch(() => {}));
$('reset-profile').addEventListener('click', () => { $('browser-profile').value = ''; });
$('save-advanced').addEventListener('click', () => void request('configure', { settings: { shortcut: $('shortcut-input').value, browserPort: Number($('browser-port').value), browserExecutable: $('browser-path').value, browserProfile: $('browser-profile').value, proxy: $('proxy').value.trim() } }).then(refresh).catch(() => {}));
$('prepare').addEventListener('click', () => void request('prepare').then(result => { message(result.message); return refresh(); }).catch(() => {}));
$('check-accounts').addEventListener('click', () => void accounts(true).catch(() => {})); $('login-site').addEventListener('click', () => void request('login', { site: $('custom-site').value.trim() }).then(r => message(r.message)).catch(() => {}));
$('select-all').addEventListener('click', () => { const inputs = [...$('selection-list').querySelectorAll('input:not(:disabled)')], all = inputs.every(i => i.checked); inputs.forEach(i => { i.checked = !all; }); });
$('save-selected').addEventListener('click', () => void request('select', { id: selectedJob, ids: [...$('selection-list').querySelectorAll('input:checked')].map(i => i.value), options: readOptions(), allowPartial: true }).then(refresh).catch(() => {}));
$('reread').addEventListener('click', () => void request('reread', { id: selectedJob }).then(refresh).catch(() => {}));
$('task-search').addEventListener('input', () => state && renderTasks()); $('status-filter').addEventListener('change', () => state && renderTasks());
api.onChange(() => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void refresh().catch(() => {}), 150); });
api.onShow(({ expanded: showExpanded }) => { setExpanded(showExpanded); $('links').focus(); });
void refresh().then(() => { $('links').focus(); return accounts(); }).catch(() => {});
