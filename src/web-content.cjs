const { parse, parseFragment } = require('./vendor/parse5/dist/cjs/index.js');
const skip = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'head', 'nav', 'footer', 'form', 'input', 'button', 'textarea', 'select', 'audio', 'video', 'iframe', 'object', 'embed']);
const blocks = new Set(['p', 'div', 'article', 'main', 'section', 'header', 'aside', 'blockquote', 'pre', 'ul', 'ol', 'li', 'table', 'tr', 'dl', 'dt', 'dd', 'hr']);
const attrs = node => Object.fromEntries((node.attrs || []).map(value => [value.name, value.value]));
const hidden = node => { const a = attrs(node); return a.hidden !== undefined || a.inert !== undefined || a['aria-hidden'] === 'true' || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?(?:;|$)/i.test(a.style || ''); };
function textOf(root) {
  const output = [], stack = [{ node: root }]; let count = 0;
  while (stack.length) {
    const { node, end } = stack.pop(); if (++count > 150000) throw Error('Notion 联网读取页面结构过长。');
    const tag = node.tagName;
    if (skip.has(tag) || hidden(node)) continue;
    if (end) { if (blocks.has(tag) || /^h[1-6]$/.test(tag)) output.push('\n'); if (tag === 'td' || tag === 'th') output.push(' | '); continue; }
    if (node.nodeName === '#text') { output.push(node.value); continue; }
    if (tag === 'br') output.push('\n');
    if (blocks.has(tag) || /^h[1-6]$/.test(tag)) output.push('\n');
    if (/^h[1-6]$/.test(tag)) output.push('#'.repeat(Number(tag[1])) + ' '); if (tag === 'li') output.push('- ');
    stack.push({ node, end: true }); for (let index = (node.childNodes || []).length - 1; index >= 0; index--) stack.push({ node: node.childNodes[index] });
  }
  return output.join('').replace(/\r\n?/g, '\n').replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function snippet(value, max = 3000) { return typeof value === 'string' ? textOf(parseFragment(value.slice(0, max * 4))).slice(0, max) : ''; }
function extractContent(body, contentType = '') {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (!['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'application/json'].includes(mime)) throw Error('Notion 联网读取暂只支持网页、纯文本和 JSON；未解析此附件正文。');
  const charset = contentType.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || (mime.includes('html') && body.subarray(0, 2048).toString('ascii').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]) || 'utf-8';
  let source; try { source = new TextDecoder(charset, { fatal: true }).decode(body); } catch { throw Error('Notion 联网读取无法按网页编码解析正文。'); }
  let title = '', text = source, extraction = 'plain-text';
  if (mime.includes('html')) {
    const document = parse(source), stack = [document]; let main, article, root, titleNode, count = 0;
    while (stack.length) {
      const node = stack.pop(); if (++count > 150000) throw Error('Notion 联网读取页面结构过长。');
      if (hidden(node)) continue;
      if (node.tagName === 'title') titleNode ||= node;
      if (node.tagName === 'main') main ||= node; if (node.tagName === 'article') article ||= node; if (node.tagName === 'body') root ||= node;
      if (skip.has(node.tagName) && node.tagName !== 'head') continue;
      for (let i = (node.childNodes || []).length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    title = titleNode ? textOf(titleNode).slice(0, 500) : ''; text = textOf(main || article || root || document);
    extraction = main ? 'static-main' : article ? 'static-article' : 'static-body';
  }
  if (!text.trim()) throw Error('Notion 联网读取未得到正文；页面可能需要登录、脚本渲染或不包含可读文字。');
  const truncated = text.length > 120000;
  return { title, text: text.slice(0, 120000), extraction, encoding: charset, source_truncated: truncated, original_characters: text.length, script_rendered: false };
}
module.exports = { extractContent, snippet };
