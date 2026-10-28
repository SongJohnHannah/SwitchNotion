const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { promptSettings } = require('./prompts.cjs');
const kinds = new Set(['paragraph', 'heading', 'quote', 'list', 'code', 'divider', 'image', 'video', 'audio', 'link']);
const mediaKinds = new Set(['image', 'video', 'audio']);
const defaults = Object.freeze({ shortcut: 'CommandOrControl+Shift+J', transcribe: true, vision: true,
  compress: true, quality: '720p', keepLocal: true, keepHistory: false, extraction: Object.freeze(promptSettings()), types: ['text', 'image', 'video', 'audio'],
  browserPort: 19333, browserExecutable: '', browserProfile: '', proxy: '', outputDirectory: '', destination: null, favorites: [] });
const hash = value => createHash('sha256').update(String(value)).digest('hex');
function publicUrl(value) {
  let url; try { url = new URL(value); } catch { throw Error('请粘贴有效的网页或媒体链接。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) throw Error('请使用不含账号密码的 HTTP 或 HTTPS 链接。');
  url.hash = ''; return url.href;
}
function extractUrls(value) {
  if (typeof value !== 'string' || value.length > 65536) throw Error('链接内容过长。');
  const urls = value.match(/https?:\/\/[^\s<>"“”\[\]]+/g) || [];
  const trim = url => { url = url.replace(/[，。；、]+$/, ''); for (const [open, close] of [['(', ')'], ['（', '）']]) {
    while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
  } return url; };
  const result = [...new Set(urls.map(url => publicUrl(trim(url))))];
  if (!result.length || result.length > 30) throw Error('请粘贴 1 到 30 个链接，也可直接粘贴分享文案。');
  return result;
}
function destination(value) {
  if (value === null || value === undefined) return null;
  const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
  if (!value || !uuid.test(value.workspaceId) || !uuid.test(value.id) || !['page', 'database'].includes(value.kind) ||
    value.dataSourceId && !uuid.test(value.dataSourceId)) throw Error('请选择有效的 Notion 工作区、数据库或页面。');
  return { workspaceId: value.workspaceId, id: value.id, kind: value.kind, label: String(value.label || '未命名').slice(0, 200),
    workspaceName: String(value.workspaceName || '').slice(0, 80), ...(value.dataSourceId ? { dataSourceId: value.dataSourceId } : {}) };
}
function preferences(input = {}, base = defaults) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(defaults, k))) throw Error('收集设置包含未知选项。');
  const result = { ...base, ...input };
  for (const key of ['transcribe', 'vision', 'compress', 'keepLocal', 'keepHistory']) if (typeof result[key] !== 'boolean') throw Error('收集开关无效。');
  result.extraction = promptSettings(input.extraction, base.extraction || defaults.extraction);
  if (!['720p', '1080p', 'original'].includes(result.quality)) throw Error('请选择有效的画质。');
  if (!Array.isArray(result.types) || !result.types.length || result.types.some(t => !['text', 'image', 'video', 'audio'].includes(t))) throw Error('请至少选择一种内容类型。');
  if (typeof result.shortcut !== 'string' || result.shortcut.length > 80 || !/^(?:(?:CommandOrControl|Command|Control|Ctrl|Alt|Option|Shift|Super)\+)+(?:[A-Z0-9]|Space|F\d{1,2})$/i.test(result.shortcut)) throw Error('快捷键需包含修饰键，例如 CommandOrControl+Shift+J。');
  if (!Number.isInteger(result.browserPort) || result.browserPort < 1024 || result.browserPort > 65535) throw Error('浏览器端口必须在 1024 到 65535 之间。');
  for (const key of ['browserExecutable', 'browserProfile', 'outputDirectory']) if (typeof result[key] !== 'string' || result[key] && (!path.isAbsolute(result[key]) || result[key].includes('\0'))) throw Error('请选择本机的绝对路径。');
  if (typeof result.proxy !== 'string') throw Error('代理地址无效。');
  if (result.proxy) { const u = new URL(result.proxy); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error('代理只支持不含账号密码的 HTTP 或 HTTPS 地址。'); }
  result.destination = destination(result.destination);
  if (!Array.isArray(result.favorites) || result.favorites.length > 30) throw Error('收藏位置最多 30 个。');
  result.favorites = result.favorites.map(destination); result.types = [...new Set(result.types)]; return result;
}
function normalizeDocument(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.nodes)) throw Error('没有获取到可识别的正文。');
  const sourceUrl = publicUrl(value.url), title = String(value.title || new URL(sourceUrl).hostname).slice(0, 300);
  const nodes = value.nodes.slice(0, 5000).filter(n => kinds.has(n.kind)).map((n, i) => {
    const node = { id: 'item-' + i + '-' + hash([n.kind, n.url || n.text, i].join('|')).slice(0, 12), kind: n.kind,
      text: String(n.text || ''), caption: String(n.caption || '') };
    if (n.url) { try { node.url = publicUrl(new URL(n.url, sourceUrl).href); } catch {} }
    if (n.poster) { try { node.poster = publicUrl(new URL(n.poster, sourceUrl).href); } catch {} }
    if (n.level) node.level = Math.min(3, Math.max(1, Number(n.level) || 1));
    if (Array.isArray(n.spans)) node.spans = n.spans.filter(s => s && typeof s.text === 'string').map(s => ({ text: s.text, ...(s.href && /^https?:\/\//.test(s.href) ? { href: s.href } : {}) }));
    if (n.duration > 0) node.duration = Number(n.duration);
    if (n.platform) node.platform = String(n.platform).slice(0, 40);
    if (typeof n.contentId === 'string' && /^[a-f\d]{64}$/.test(n.contentId)) node.contentId = n.contentId;
    if (n.direct === true) node.direct = true;
    if (n.expectedAudio === true) node.expectedAudio = true;
    return node;
  });
  return { title, url: sourceUrl, author: String(value.author || '').slice(0, 200), nodes,
    warnings: [...new Set([...(Array.isArray(value.warnings) ? value.warnings.map(String) : []), ...(value.nodes.length > 5000 ? ['正文超过 5000 项，尚未完整获取。'] : [])])],
    requiresLogin: value.requiresLogin === true, incomplete: value.incomplete === true || value.nodes.length > 5000 };
}
function selectedNodes(document, options, selectedIds) {
  if (selectedIds !== undefined && (!Array.isArray(selectedIds) || selectedIds.some(id => !document.nodes.some(n => n.id === id)))) throw Error('所选内容已变化，请重新检查预览。');
  const selected = selectedIds && new Set(selectedIds);
  return document.nodes.filter(node => options.types.includes(mediaKinds.has(node.kind) ? node.kind : 'text') && (!selected || selected.has(node.id)));
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flush: true }); fs.renameSync(temp, file);
}
function layoutNodes(nodes, layout) {
  if (layout !== 'media-at-end') return nodes;
  return [...nodes.filter(node => !['audio', 'video'].includes(node.kind)), ...nodes.filter(node => ['audio', 'video'].includes(node.kind))];
}
module.exports = { defaults, kinds, mediaKinds, hash, publicUrl, extractUrls, destination, preferences, normalizeDocument, selectedNodes, atomicJson, layoutNodes };
