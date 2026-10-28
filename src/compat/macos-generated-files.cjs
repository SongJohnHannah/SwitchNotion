const { GeneratedFiles } = require('../generated-files.cjs');

// The current Mac renderer treats UUIDs in notion.com paths as page links.
// Keep download capabilities opaque to that page-link parser. The existing
// file service still validates the original token, scope, bytes and hash.
class MacGeneratedFiles extends GeneratedFiles {
  open(scope) {
    const service = super.open(scope);
    return { ...service, execute: async (...args) => {
      const result = await service.execute(...args);
      const url = new URL(result.download_url);
      const match = /^\/notion-switch-generated\/([a-f\d-]{36})\/([a-f\d]{64})$/.exec(url.pathname);
      if (!match) throw Error('Mac 文件下载地址无效。');
      const id = Buffer.from(match[1].replaceAll('-', ''), 'hex').toString('base64url');
      const token = Buffer.from(match[2], 'hex').toString('base64url').match(/.{1,8}/g).join('.');
      url.pathname = '/notion-switch-generated/mac/' + id + '/' + token;
      return { ...result, download_url: url.href };
    } };
  }
  serve(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/notion-switch-generated/mac/')) return super.serve(request);
    const match = /^\/notion-switch-generated\/mac\/([A-Za-z\d_-]{22})\/((?:[A-Za-z\d_-]{8}\.){5}[A-Za-z\d_-]{3})$/.exec(url.pathname);
    if (!match) return new Response(null, { status: 404 });
    const id = Buffer.from(match[1], 'base64url'), token = Buffer.from(match[2].replaceAll('.', ''), 'base64url');
    if (id.length !== 16 || token.length !== 32 || id.toString('base64url') !== match[1] || token.toString('base64url').match(/.{1,8}/g).join('.') !== match[2]) return new Response(null, { status: 404 });
    const hex = id.toString('hex');
    url.pathname = '/notion-switch-generated/' + [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-') + '/' + token.toString('hex');
    return super.serve(new Request(url.href, request));
  }
}
// Fetch through the local protocol handler before starting a blob download.
// A direct navigation is instead consumed by the Mac client's SPA router.
function installDownloads() {
  if (window.__notionSwitchMacDownloads) return;
  window.__notionSwitchMacDownloads = true;
  window.addEventListener('click', async event => {
    const link = event.target?.closest?.('a[href]'); if (!link) return;
    let url; try { url = new URL(link.href, location.href); } catch { return; }
    if (url.origin !== location.origin || url.search || url.hash || !/^\/notion-switch-generated\/mac\/[A-Za-z\d_-]{22}\/(?:[A-Za-z\d_-]{8}\.){5}[A-Za-z\d_-]{3}$/.test(url.pathname)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (link.dataset.notionSwitchDownloading) return;
    link.dataset.notionSwitchDownloading = '1';
    try {
      const response = await fetch(url.href, { credentials: 'same-origin' });
      const encoded = response.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const filename = encoded && decodeURIComponent(encoded);
      if (!response.ok || !filename || /[\\/\x00-\x1f\x7f]/.test(filename)) throw Error();
      const objectUrl = URL.createObjectURL(await response.blob()), download = document.createElement('a');
      download.href = objectUrl; download.download = filename; download.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      link.title = '已开始下载';
    } catch { link.title = '下载未完成，请重试。'; }
    finally { delete link.dataset.notionSwitchDownloading; }
  }, true);
}
const downloadScript = '(' + installDownloads.toString() + ')()';
module.exports = { MacGeneratedFiles, downloadScript };
