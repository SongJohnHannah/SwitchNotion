const { createHash } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { PageFiles } = require('./page-files.cjs');
const plain = value => Array.isArray(value) ? value.map(span => typeof span?.[0] === 'string' ? span[0] : '').join('') : '';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function openNativePageFiles({ store, parseContent, signal, fetchFile, budget }) {
  const userId = uuid(store.userId), spaceId = uuid(store.spaceId), signed = new Map();
  if (!userId || !spaceId) throw Error('Notion 文件读取原生账号或工作区无效。');
  const session = { execute: async (name, args) => {
    signal?.throwIfAborted();
    if (name !== 'read_block' || uuid(args?.workspace_id) !== spaceId || !uuid(args?.block_id) || store.userId !== userId || store.spaceId !== spaceId) throw Error('Notion 文件读取只允许当前账号和工作区的附件。');
    const id = uuid(args.block_id), entry = (await store.records([id], signal)).get(id), block = entry?.value;
    if (!block || uuid(block.space_id) !== spaceId || block.alive === false || !['reader', 'commenter', 'editor', 'owner'].includes(entry.role) || !['file', 'pdf', 'image', 'audio', 'video'].includes(block.type)) throw Error('Notion 文件读取原生附件不可访问或类型无效。');
    const source = plain(block.properties?.source).trim();
    if (!source || source.length > 8192 || /[\u0000-\u001f]/.test(source)) throw Error('Notion 文件读取原生附件地址无效。');
    let fallback;
    try { fallback = source.startsWith('attachment:') ? decodeURIComponent(source.split(':').slice(2).join(':')) : decodeURIComponent(new URL(source).pathname.split('/').pop()); } catch {}
    const title = plain(block.properties?.title).trim(), filename = /\.[A-Za-z0-9]{1,10}$/.test(title) ? title : fallback;
    if (typeof filename !== 'string' || !filename || filename.length > 255 || /[\\/\u0000-\u001f]/.test(filename)) throw Object.assign(Error('Notion 文件读取无法识别原生附件文件名。'), { code: 'NOTION_FILE_UNSUPPORTED' });
    const revision = createHash('sha256').update(JSON.stringify(canonical([entry.role, block]))).digest('hex');
    let address = signed.get(revision);
    if (!address) {
      const result = await store.api('getSignedFileUrls', { urls: [{ url: source, download: false, downloadName: filename, permissionRecord: { table: 'block', id, spaceId } }] }, { signal, spaceId });
      signal?.throwIfAborted();
      if (!Array.isArray(result?.signedUrls) || result.signedUrls.length !== 1 || typeof result.signedUrls[0] !== 'string') throw Error('Notion 文件读取没有取得原生附件签名地址。');
      let url; try { url = new URL(result.signedUrls[0]); } catch { throw Error('Notion 文件读取原生签名地址无效。'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href.length > 16384) throw Error('Notion 文件读取原生签名地址不受支持。');
      address = url.href; signed.set(revision, address);
    }
    return { block: { id, type: block.type, [block.type]: { type: 'file', name: filename, file: { url: address } } }, block_revision: revision, url: 'https://www.notion.so/' + id.replaceAll('-', '') };
  } };
  return new PageFiles({ parseContent, ...(fetchFile ? { fetchFile } : {}) }).open({ spaceId, signal, session, ...(budget ? { budget } : {}) });
}
module.exports = { openNativePageFiles };
