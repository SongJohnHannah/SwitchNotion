const path = require('node:path');
const { SaxesParser } = require('./vendor/saxes/saxes.js');
const { partName } = require('./document-zip.cjs');
function decodeText(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  let value; try { value = new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch { throw Error('Notion 附件文字编码无法读取，请转换为 UTF-8 或带标记的 UTF-16。'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw Error('Notion 附件包含二进制数据或不支持的控制字符。');
  return value;
}
function parseXml(bytes) {
  if (bytes.length > 8 * 1024 * 1024) throw Error('Notion 附件 XML 超过解析上限。');
  const parser = new SaxesParser({ xmlns: true }), stack = []; let root, count = 0;
  parser.on('doctype', () => { throw Error('Notion 附件不支持 DTD 或自定义实体。'); });
  parser.on('error', () => { throw Error('Notion 附件 XML 格式不完整或无效。'); });
  parser.on('opentag', tag => {
    if (++count > 180000 || stack.length >= 128) throw Error('Notion 附件 XML 层级或节点过多。');
    const node = { name: tag.local, uri: tag.uri, attrs: Object.values(tag.attributes).map(value => ({ name: value.local, uri: value.uri, value: value.value })), children: [] };
    if (stack.length) stack.at(-1).children.push(node); else root = node;
    stack.push(node);
  });
  const text = value => { if (stack.length) stack.at(-1).children.push(value); };
  parser.on('text', text); parser.on('cdata', text); parser.on('closetag', () => stack.pop());
  try { parser.write(decodeText(bytes)).close(); } catch (error) { if (/^Notion /.test(error.message)) throw error; throw Error('Notion 附件 XML 无法读取。'); }
  if (!root) throw Error('Notion 附件 XML 缺少根节点。'); return root;
}
const attr = (node, name, uri) => node.attrs.find(value => value.name === name && (uri === undefined || value.uri === uri))?.value;
const children = (node, name, uri) => node.children.filter(value => typeof value === 'object' && (!name || value.name === name) && (!uri || value.uri === uri));
const descendants = (node, name, uri) => children(node).flatMap(value => [...(value.name === name && (!uri || value.uri === uri) ? [value] : []), ...descendants(value, name, uri)]);
const text = node => node.children.map(value => typeof value === 'string' ? value : text(value)).join('');
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
function relationships(zip, base) {
  const file = path.posix.join(path.posix.dirname(base), '_rels', path.posix.basename(base) + '.rels'), result = new Map();
  if (!zip.has(file)) return result;
  const root = parseXml(zip.read(file)); if (root.name !== 'Relationships' || root.uri !== REL) throw Error('Notion 附件关系格式无效。');
  for (const node of children(root, 'Relationship', REL)) {
    const id = attr(node, 'Id'), target = attr(node, 'Target'), type = attr(node, 'Type');
    if (!id || result.has(id) || !target || !type) throw Error('Notion 附件关系标识无效或重复。');
    if (attr(node, 'TargetMode') === 'External') result.set(id, { external: true, type });
    else {
      let decoded; try { decoded = decodeURIComponent(target); } catch { throw Error('Notion 附件关系路径无效。'); }
      if (/[\\:\u0000-\u001f\u007f?#]/.test(decoded)) throw Error('Notion 附件关系路径无效。');
      const name = path.posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(path.posix.dirname(base), decoded));
      result.set(id, { name: partName(name), type });
    }
  }
  return result;
}
module.exports = { decodeText, parseXml, attr, children, descendants, text, relationships };
