const fs = require('node:fs');
const path = require('node:path');
const { atomicJson, layoutNodes, selectedNodes } = require('./model.cjs');
const { ownedExport } = require('./history.cjs');
function prepareLocalOutput(job, downloadsDirectory) {
  if (job.exportOwned && job.exportDirectory) {
    const existing = ownedExport(job); if (existing) return existing;
  }
  const base = path.resolve(job.options.outputDirectory || path.join(downloadsDirectory, 'NotionSwitch'));
  let title = String(job.document.title || '未命名资料').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || '未命名资料';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) title = '_' + title;
  fs.mkdirSync(base, { recursive: true });
  for (let index = 1; index <= 1000; index++) {
    const directory = path.join(base, title + (index === 1 ? '' : ' (' + index + ')'));
    try { fs.mkdirSync(directory); } catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    atomicJson(path.join(directory, '.switch-notion-task.json'), { version: 1, taskId: job.id });
    job.exportDirectory = directory; job.exportBaseDirectory = base; job.exportOwned = true; return directory;
  }
  throw Error('同名资料文件夹过多，请选择其他下载目录。');
}
function writeLocalOutput(job) {
  if (!job.exportOwned || !job.exportDirectory || !fs.existsSync(job.exportDirectory)) return;
  const directory = ownedExport(job); if (!directory) return;
  const nodes = layoutNodes(selectedNodes(job.document, job.options, job.selectedIds), job.layout), files = {};
  for (const node of nodes) {
    const file = job.resources[node.id]?.asset?.path;
    if (!file || !fs.existsSync(file)) continue;
    const relative = path.relative(directory, file);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) files[node.id] = relative.replaceAll('\\', '/');
  }
  atomicJson(path.join(directory, 'content.json'), { version: 1, title: job.document.title, source: job.document, status: job.status,
    selectedIds: nodes.map(n => n.id), files, analyses: job.analyses, extraction: job.extraction, notion: job.page });
  const text = ['# ' + job.document.title, '', '来源：' + job.document.url, '']; let mediaHeading = false;
  for (const node of nodes) {
    if (['video', 'audio'].includes(node.kind) && !mediaHeading) { text.push('## 原始音视频', ''); mediaHeading = true; }
    if (node.text) {
      const content = node.spans?.length ? node.spans.map(s => s.href ? '[' + s.text.replaceAll(']', '\\]') + '](<' + s.href + '>)' : s.text).join('') : node.text;
      text.push((node.kind === 'heading' ? '#'.repeat((node.level || 1) + 1) + ' ' : '') + content, '');
    }
    if (['image', 'video', 'audio'].includes(node.kind)) {
      const name = node.caption || ({ image: '图片', video: '视频', audio: '音频' }[node.kind]);
      text.push(files[node.id] ? (node.kind === 'image' ? '!' : '') + '[' + name.replaceAll(']', '\\]') + '](' + encodeURI(files[node.id]) + ')' : '【' + name + '待下载】', '');
    }
  }
  fs.writeFileSync(path.join(directory, '原文.md'), text.join('\n'), { mode: 0o600 });
  const analysisText = key => nodes.filter(n => job.analyses[n.id]?.[key]).map(n => '## 素材 ' + (nodes.indexOf(n) + 1) + '\n\n' + (job.analyses[n.id][key].text || job.analyses[n.id][key].note || '')).join('\n\n');
  for (const [key, name] of [['transcript', '逐字稿.md'], ['vision', '图片与画面识别.md']]) {
    const value = analysisText(key); if (value) fs.writeFileSync(path.join(directory, name), value, { mode: 0o600 });
  }
  if (job.extraction?.text) fs.writeFileSync(path.join(directory, 'AI提取结果.md'), job.extraction.text, { mode: 0o600 });
}
module.exports = { prepareLocalOutput, writeLocalOutput };
