const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
async function download({ url, file, sha256, maxBytes = 32 * 1024 * 1024, signal, onProgress = () => {}, fetchImpl = fetch }) {
  if (!/^[a-f\d]{64}$/.test(sha256)) throw Error('下载校验和缺失。');
  let response;
  for (let hop = 0; hop < 8; hop++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname) || parsed.username || parsed.password) throw Error('下载地址不属于已验证的发行站点。');
    response = await fetchImpl(url, { redirect: 'manual', signal, headers: { 'user-agent': 'Switch-Notion-Speech-Setup' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = response.headers.get('location'); await response.body?.cancel(); if (!next) throw Error('下载跳转无效。'); url = new URL(next, url).href;
  }
  if (!response?.ok || !response.body) throw Error('下载未完成，请检查网络后重新准备。');
  const total = Number(response.headers.get('content-length')) || 0;
  if (total > maxBytes) { await response.body.cancel(); throw Error('下载文件大小异常。'); }
  fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = file + '.partial', hash = createHash('sha256'); let bytes = 0;
  try {
    await pipeline(Readable.from((async function* () { for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > maxBytes) throw Error('下载文件大小异常。'); hash.update(chunk); onProgress({ received: bytes, total }); yield chunk;
    } })()), fs.createWriteStream(temp, { mode: 0o600 }), { signal });
    if (hash.digest('hex') !== sha256) throw Error('下载文件校验失败，未执行。');
    fs.renameSync(temp, file); return file;
  } catch (error) { if (fs.existsSync(temp)) fs.unlinkSync(temp); throw error; }
}
module.exports = { download };
