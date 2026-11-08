const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const video = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.wmv', '.mpeg', '.mpg', '.ts', '.mts', '.m2ts', '.3gp']);
const audio = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg', '.opus', '.aif', '.aiff', '.wma']);
const image = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);
const localKind = ext => video.has(ext) ? 'video' : audio.has(ext) ? 'audio' : image.has(ext) ? 'image' : null;
function parseInputs(value, { platform = process.platform, home = os.homedir() } = {}) {
  if (typeof value !== 'string' || value.length > 65536) throw Error('请输入网页链接或本地图片、音视频路径，最多 30 项。');
  const paths = platform === 'win32' ? path.win32 : path.posix, result = [];
  for (let line of value.split(/\r?\n/).map(text => text.trim()).filter(Boolean)) {
    if (/^file:/i.test(line.replace(/^['"]|['"]$/g, ''))) {
      line = line.replace(/^['"]|['"]$/g, '');
      const url = new URL(line); if (url.hostname && url.hostname !== 'localhost') throw Error('只支持当前电脑上的本地文件，不支持网络共享路径。');
      if (url.search || url.hash) throw Error('本地文件地址不能带查询参数或片段；文件名中的特殊字符请使用原始路径或编码后的 file 地址。');
      line = platform === process.platform ? fileURLToPath(url) : decodeURIComponent(url.pathname).replace(platform === 'win32' ? /^\/([a-z]:)/i : /$^/, '$1');
    } else if (/https?:\/\//i.test(line)) {
      const { extractUrls } = require('./model.cjs');
      const urls = extractUrls(line);
      const title = urls.length === 1 && /(?:^|\.)(?:douyin\.com|iesdouyin\.com)$/i.test(new URL(urls[0]).hostname) &&
        /【[^】]{1,100}的作品】\s*([^\[\r\n]+?)\s*\[?https?:\/\//iu.exec(line)?.[1]?.trim().slice(0, 300);
      result.push(...urls.map(url => ({ kind: 'web', url, ...(title ? { shareTitle: title } : {}) }))); continue;
    } else line = line.replace(/^['"]|['"]$/g, '');
    if (line.startsWith('~/') || line.startsWith('~\\')) line = paths.join(home, line.slice(2));
    if (/^\\\\|^\/\//.test(line)) throw Error('只支持当前电脑上的本地文件，不支持网络共享路径。');
    if (!paths.isAbsolute(line) || line.includes('\0') || !localKind(paths.extname(line).toLowerCase())) throw Error('请输入网页链接，或完整的本地图片、音视频文件路径；多个来源请分行填写。');
    result.push({ kind: 'local', path: paths.normalize(line) });
  }
  const unique = [...new Map(result.map(source => [source.url || source.path, source])).values()];
  if (!unique.length || unique.length > 30) throw Error('请输入 1 到 30 个网页链接或本地图片、音视频路径。');
  return unique;
}
function videoExtension(file) { return video.has(path.extname(String(file).replace(/[?#].*$/, '')).toLowerCase()); }
function isLikelyVideoInput(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 65536) return false;
  for (let line of value.split(/\r?\n/).map(text => text.trim()).filter(Boolean)) {
    line = line.replace(/^['"]|['"]$/g, '');
    if (/^file:/i.test(line)) { try { line = fileURLToPath(new URL(line)); } catch { continue; } }
    if (/^https?:\/\//i.test(line)) {
      let url; try { url = new URL(line); } catch { continue; }
      const host = url.hostname.toLowerCase().replace(/^www\./, ''), pathname = url.pathname.toLowerCase();
      if (videoExtension(pathname)) return true;
      if (/(^|\.)bilibili\.com$/.test(host) && /^\/(video|bangumi)\//.test(pathname)) return true;
      if (host === 'b23.tv' || host === 'bili2233.cn') return true;
      if (/(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(host) && /^\/(watch|shorts|live)\b/.test(pathname)) return true;
      if (host === 'youtu.be') return true;
      if (/(^|\.)(douyin\.com|iesdouyin\.com)$/.test(host) || host === 'v.douyin.com') return true;
      if (/(^|\.)tiktok\.com$/.test(host)) return true;
      if (/(^|\.)xiaohongshu\.com$/.test(host) && /^\/(explore|discovery)\//.test(pathname)) return true;
      if (host === 'channels.weixin.qq.com' || host === 'weishi.qq.com' || host === 'weixin.qq.com' && /^\/sph\//.test(pathname)) return true;
      if (/(^|\.)(vimeo\.com|twitch\.tv|ixigua\.com|kuaishou\.com)$/.test(host)) return true;
      if (/(^|\.)(x\.com|twitter\.com)$/.test(host) && /\/status\//.test(pathname)) return true;
      continue;
    }
    if (videoExtension(line)) return true;
  }
  return false;
}
function describeLocal(file) {
  let real, stat; try { real = fs.realpathSync(file); stat = fs.statSync(real); } catch { throw Error('本地文件不存在或无法读取，请检查完整路径。'); }
  const kind = localKind(path.extname(real).toLowerCase());
  if (!kind || !stat.isFile() || !stat.size) throw Error('请选择有内容的本地图片、音频或视频文件。');
  const signature = createHash('sha256').update(JSON.stringify([real, stat.size, stat.mtimeMs])).digest('hex');
  return { kind, path: real, name: path.basename(real), bytes: stat.size, modified: stat.mtimeMs, signature };
}
function checkLocal(source) {
  const current = describeLocal(source.path);
  if (current.signature !== source.signature) throw Error('本地文件已改变，请重新提交路径，避免把不同内容混入已有任务。');
  return current;
}
function localDocument(source) {
  return { title: path.basename(source.name, path.extname(source.name)), url: '', sourceKind: 'local', sourceName: source.name, author: '', warnings: [], incomplete: false, requiresLogin: false,
    nodes: [{ id: 'local-' + source.signature.slice(0, 12), kind: source.kind, text: '', caption: source.name }] };
}
module.exports = { parseInputs, describeLocal, checkLocal, localDocument, isLikelyVideoInput };
