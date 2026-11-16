const fs = require('node:fs');
const path = require('node:path');
const { destination, publicUrl, mediaKinds, kinds, recognitionResult } = require('./model.cjs');
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const inside = (directory, file) => { const relative = path.relative(directory, file); return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
function localFile(directory, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\0')) throw Error('本地资料中的文件路径无效。');
  const file = path.resolve(directory, relative);
  if (!inside(directory, file)) throw Error('本地资料中的文件超出了所选文件夹。');
  for (let current = file; current !== directory; current = path.dirname(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('本地资料中的文件不能使用目录或文件链接。');
  }
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw Error('本地原视频缺失，请选择仍包含视频的资料文件夹；不会自动重新下载。');
  return file;
}
function checkRetainedAsset(asset) {
  const stat = fs.statSync(asset.path, { throwIfNoEntry: false });
  if (!stat?.isFile() || !stat.size) throw Error('本地原视频缺失或为空，已停止重新蒸馏；不会自动重新下载。');
  if (asset.bytes !== undefined && stat.size !== asset.bytes || asset.modified !== undefined && stat.mtimeMs !== asset.modified) throw Error('本地视频已改变，未把旧识别资料混入不同视频，请重新收集该文件。');
  return stat;
}
function loadLocalCollection(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error('请选择保留的本地资料文件夹。');
  let directory;
  try { directory = fs.realpathSync(value); } catch { throw Error('本地资料文件夹不存在或无法读取。'); }
  if (!fs.existsSync(path.join(directory, 'content.json'))) throw Error('本地资料文件夹缺少 content.json，请选择保留的收集资料文件夹。');
  const file = localFile(directory, 'content.json');
  if (fs.statSync(file).size > 32 * 1024 ** 2) throw Error('本地资料索引过大，无法重新蒸馏。');
  let archive;
  try { archive = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Error('本地 content.json 无法读取，请选择完整的收集资料文件夹。'); }
  const document = archive?.source;
  if (archive?.version !== 1 || !document || !Array.isArray(document.nodes) || !document.nodes.length || document.nodes.length > 5000 || !Array.isArray(archive.selectedIds)) throw Error('本地资料文件夹不是完整的 Switch Notion 收集资料。');
  const ids = new Set();
  for (const node of document.nodes) {
    if (!node || typeof node.id !== 'string' || !/^[\w-]{1,100}$/.test(node.id) || ids.has(node.id) || !kinds.has(node.kind) || typeof node.text !== 'string' || typeof node.caption !== 'string') throw Error('本地资料的素材标识或内容无效。');
    ids.add(node.id);
  }
  if (archive.selectedIds.some(id => !ids.has(id))) throw Error('本地资料的素材选择已不完整。');
  const selected = new Set(archive.selectedIds);
  // This action distils the videos and their source text; unrelated audio and images stay in the original collection.
  const nodes = document.nodes.filter(node => selected.has(node.id) && (node.kind === 'video' || !mediaKinds.has(node.kind)));
  if (!nodes.some(node => node.kind === 'video')) throw Error('本地资料中没有已收集的视频。');
  const page = archive.notion;
  if (!uuid.test(page?.id)) throw Error('本地资料没有原 Notion 页面记录，无法关联原视频。');
  const referencePage = { id: page.id, url: 'https://www.notion.so/' + page.id.replaceAll('-', '') };
  const resources = {}, analyses = {};
  for (const node of nodes.filter(node => node.kind === 'video')) {
    const video = localFile(directory, archive.files?.[node.id]);
    const previous = archive.assets?.[node.id] || {};
    const metadata = Object.fromEntries(['duration', 'audio', 'video', 'width', 'height', 'bytes', 'modified'].filter(key => Object.hasOwn(previous, key)).map(key => [key, previous[key]]));
    const asset = { ...metadata, kind: 'video', path: video };
    const stat = checkRetainedAsset(asset); asset.bytes = stat.size; asset.modified = stat.mtimeMs;
    resources[node.id] = { asset, referencePage };
    const previousAnalysis = archive.analyses?.[node.id] || {};
    if (typeof previousAnalysis !== 'object' || Array.isArray(previousAnalysis)) throw Error('本地资料中的识别结果无效。');
    const analysis = analyses[node.id] = structuredClone(previousAnalysis);
    for (const key of ['transcript', 'ocr', 'vision', 'frameVerification']) if (analysis[key] && (typeof analysis[key] !== 'object' || Array.isArray(analysis[key]))) throw Error('本地资料中的识别结果无效。');
    const ocr = recognitionResult(previousAnalysis, 'ocr');
    if (ocr) analysis.ocr = { ...ocr };
    delete analysis.vision; delete analysis.frameVerification; analysis.errors = [];
    // Retain OCR text, while avoiding old absolute frame paths after a folder was moved or copied.
    if (analysis.ocr) { delete analysis.ocr.frames; delete analysis.ocr.recognizedFramePaths; }
  }
  const sourceUrl = document.url ? publicUrl(document.url) : referencePage.url;
  return { directory, referencePage, resources, analyses, selectedIds: nodes.map(node => node.id),
    document: { ...document, warnings: Array.isArray(document.warnings) ? document.warnings : [], title: String(document.title || archive.title || '视频资料'), url: document.url ? sourceUrl : '' },
    url: sourceUrl, destination: archive.destination ? destination(archive.destination) : null };
}
module.exports = { loadLocalCollection, checkRetainedAsset, inside };
