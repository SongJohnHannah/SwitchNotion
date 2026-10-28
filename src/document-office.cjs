const { readZip } = require('./document-zip.cjs');
const { parseXml, attr, children, descendants, text, relationships } = require('./document-xml.cjs');
const WORD = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const SHEET = new Set(['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main']);
const REL = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships']);
const fail = message => { throw Error('Notion 附件' + message); };
const nodes = (node, name) => children(node).filter(value => value.name === name && value.uri === node.uri);
const first = (node, name) => nodes(node, name)[0];
function warnings() {
  const values = new Set(); let omitted = 0;
  return { add(value) { if (values.has(value)) return; if (values.size >= 100) omitted++; else values.add(value); }, list() { return [...values, ...(omitted ? ['另有 ' + omitted + ' 项解析限制。'] : [])]; } };
}
function docx(bytes) {
  const zip = readZip(bytes), notes = warnings(), main = parseXml(zip.read('word/document.xml'));
  if (!WORD.has(main.uri) || main.name !== 'document') fail('不是已支持的 Word 文档。');
  const body = first(main, 'body'); if (!body) fail('缺少 Word 正文。');
  const references = { footnote: new Set(), endnote: new Set() };
  function inline(node) {
    if (typeof node === 'string') return '';
    if (WORD.has(node.uri)) {
      if (['del', 'moveFrom'].includes(node.name)) return '';
      if (node.name === 't') return text(node);
      if (node.name === 'tab') return '\t';
      if (['br', 'cr'].includes(node.name)) return '\n';
      if (node.name === 'noBreakHyphen') return '\u2011';
      if (node.name === 'softHyphen') return '\u00ad';
      for (const kind of ['footnote', 'endnote']) if (node.name === kind + 'Reference') {
        const id = attr(node, 'id'); if (!/^\d{1,8}$/.test(id || '')) fail('注释引用标识无效。'); references[kind].add(id);
        return '[' + (kind === 'footnote' ? '脚注' : '尾注') + id + ']';
      }
      if (['drawing', 'pict', 'object', 'altChunk'].includes(node.name)) notes.add('图像、嵌入对象和外部正文没有解析，仅读取文字层。');
      if (node.name === 'commentReference') notes.add('文档批注未展开，仅读取正文及脚注/尾注。');
    }
    if (node.name === 't' && /officeDocument\/2006\/math$|ooxml\/officeDocument\/math$/.test(node.uri)) { notes.add('数学公式仅提取文字，未还原二维版式。'); return text(node); }
    return node.children.map(value => typeof value === 'object' ? inline(value) : '').join('');
  }
  function blocks(node) {
    const result = [];
    for (const child of children(node)) {
      if (!WORD.has(child.uri)) { if (child.children.length) notes.add('部分扩展格式的正文未展开。'); continue; }
      if (child.name === 'p') {
        if (descendants(child, 'numPr', child.uri).length) notes.add('自动编号仅保留段落顺序，未还原显示编号。');
        const value = inline(child); if (value.trim()) result.push({ type: 'paragraph', text: value });
      } else if (child.name === 'tbl') result.push({ type: 'table', rows: nodes(child, 'tr').map(row => nodes(row, 'tc').map(cell => blocks(cell))) });
      else if (['sdt', 'sdtContent', 'customXml', 'ins', 'moveTo'].includes(child.name)) result.push(...blocks(child));
      else if (child.name === 'altChunk') notes.add('文档包含未展开的附加正文。');
    }
    return result;
  }
  const sections = [{ label: '正文', blocks: blocks(body) }], rels = relationships(zip, 'word/document.xml'), seen = new Set();
  for (const name of ['headerReference', 'footerReference']) for (const node of descendants(body, name, main.uri)) {
    const id = node.attrs.find(value => value.name === 'id' && REL.has(value.uri))?.value, rel = rels.get(id);
    if (!rel || rel.external || !rel.type.endsWith(name === 'headerReference' ? '/header' : '/footer') || !zip.has(rel.name)) { notes.add('部分页眉或页脚未能读取。'); continue; }
    if (seen.has(rel.name)) continue; seen.add(rel.name);
    const part = parseXml(zip.read(rel.name)); if (!WORD.has(part.uri)) fail('页眉或页脚格式无效。');
    sections.push({ label: name === 'headerReference' ? '页眉' : '页脚', blocks: blocks(part) });
  }
  for (const kind of ['footnote', 'endnote']) if (references[kind].size) {
    const file = 'word/' + kind + 's.xml';
    if (!zip.has(file)) { notes.add('部分脚注或尾注没有正文。'); continue; }
    const root = parseXml(zip.read(file)); if (!WORD.has(root.uri)) fail('脚注或尾注格式无效。');
    const found = new Map();
    for (const node of nodes(root, kind)) { const id = attr(node, 'id'); if (found.has(id)) fail('脚注或尾注标识重复。'); found.set(id, node); }
    for (const id of references[kind]) {
      if (!found.has(id)) { notes.add('部分脚注或尾注没有正文。'); continue; }
      sections.push({ label: (kind === 'footnote' ? '脚注' : '尾注') + id, blocks: blocks(found.get(id)) });
    }
  }
  if (zip.names.some(name => /vbaProject\.bin$/i.test(name))) notes.add('文档包含宏；没有运行或解析宏代码。');
  return { format: 'docx', sections, warnings: notes.list(), complete: notes.list().length === 0, text_layer_only: true, layout_rendered: false, embedded_media_read: false };
}
const builtinFormats = { 0: 'General', 14: 'mm-dd-yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0' };
function serialDate(value, format, date1904) {
  if (!/^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(value)) return;
  const serial = Number(value); if (!Number.isFinite(serial) || serial < 0 || serial > 2958465 || /\[(?:h+|m+|s+)\]/i.test(format)) return;
  const pattern = format.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
  if (!/[ymdhs]/i.test(pattern) || /general/i.test(pattern)) return;
  const days = Math.floor(serial), milliseconds = Math.round((serial - days) * 86400000);
  if (!/[yd]/i.test(pattern) && /[hs]/i.test(pattern)) return new Date(milliseconds).toISOString().slice(11, 23);
  if (!date1904 && days === 60) return '1900-02-29（Excel 兼容日期）';
  const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31);
  const date = new Date(epoch + (days - (!date1904 && days > 60 ? 1 : 0)) * 86400000 + milliseconds);
  return date.toISOString().slice(0, /[hs]/i.test(pattern) ? 23 : 10);
}
function cellAddress(value) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value || ''); if (!match) fail('单元格位置无效。');
  const column = [...match[1]].reduce((number, char) => number * 26 + char.charCodeAt(0) - 64, 0), row = Number(match[2]);
  if (column > 16384 || row > 1048576) fail('单元格位置超过工作表范围。');
  return { column, row };
}
function columnName(number) { let value = ''; for (; number > 0; number = Math.floor((number - 1) / 26)) value = String.fromCharCode(65 + (number - 1) % 26) + value; return value; }
function richText(node) {
  if (!node) return '';
  return node.children.map(value => typeof value === 'object' && value.uri === node.uri ? value.name === 't' ? text(value) : value.name === 'rPh' ? '' : richText(value) : '').join('');
}
function xlsx(bytes) {
  const zip = readZip(bytes), notes = warnings(), main = parseXml(zip.read('xl/workbook.xml'));
  if (!SHEET.has(main.uri) || main.name !== 'workbook') fail('不是已支持的 Excel 工作簿。');
  const rels = relationships(zip, 'xl/workbook.xml'), dateFlag = attr(first(main, 'workbookPr') || { attrs: [] }, 'date1904');
  if (dateFlag !== undefined && !['0', '1', 'true', 'false'].includes(dateFlag)) fail('工作簿日期系统无效。');
  const date1904 = ['1', 'true'].includes(dateFlag);
  let shared = [], formats = [];
  const findPart = kind => [...rels.values()].find(value => value.type.endsWith('/' + kind) && !value.external)?.name;
  const sharedPart = findPart('sharedStrings');
  if (sharedPart) { const root = parseXml(zip.read(sharedPart)); if (!SHEET.has(root.uri) || root.name !== 'sst') fail('共享字符串格式无效。'); shared = nodes(root, 'si').map(richText); }
  const stylesPart = findPart('styles');
  if (stylesPart) {
    const root = parseXml(zip.read(stylesPart)); if (!SHEET.has(root.uri) || root.name !== 'styleSheet') fail('工作簿格式定义无效。');
    const custom = new Map(nodes(first(root, 'numFmts') || { children: [] }, 'numFmt').map(node => [Number(attr(node, 'numFmtId')), attr(node, 'formatCode')]));
    formats = nodes(first(root, 'cellXfs') || { children: [] }, 'xf').map(node => custom.get(Number(attr(node, 'numFmtId'))) || builtinFormats[Number(attr(node, 'numFmtId'))] || '未还原的内置格式');
  }
  const sheetNodes = nodes(first(main, 'sheets') || { children: [] }, 'sheet'); if (!sheetNodes.length || sheetNodes.length > 32) fail('工作表为空或超过 32 张。');
  let cells = 0, rows = 0; const sheets = [], names = new Set();
  for (const node of sheetNodes) {
    const name = attr(node, 'name'), id = node.attrs.find(value => value.name === 'id' && REL.has(value.uri))?.value, relation = rels.get(id);
    if (!name || names.has(name) || !relation || relation.external || !relation.type.endsWith('/worksheet') || !zip.has(relation.name)) fail('工作表名称、关系或正文不完整。'); names.add(name);
    const root = parseXml(zip.read(relation.name)); if (!SHEET.has(root.uri) || root.name !== 'worksheet') fail('工作表格式无效。');
    const visibility = attr(node, 'state') || 'visible'; if (!['visible', 'hidden', 'veryHidden'].includes(visibility)) fail('工作表可见状态无效。');
    const result = { name, visibility, rows: [], merged_cells: [] }, seen = new Set(); let previous = 0;
    for (const row of nodes(first(root, 'sheetData') || { children: [] }, 'row')) {
      const firstCell = nodes(row, 'c')[0], firstAddress = firstCell && attr(firstCell, 'r');
      const rowNumber = Number(attr(row, 'r') ?? (firstAddress ? cellAddress(firstAddress).row : previous + 1)); if (!Number.isSafeInteger(rowNumber) || rowNumber <= previous || rowNumber > 1048576 || ++rows > 20000) fail('工作表行位置重复、无效或超过 20,000 行。'); previous = rowNumber;
      const output = { row: rowNumber, hidden: ['1', 'true'].includes(attr(row, 'hidden')), cells: [] };
      let previousColumn = 0;
      for (const cell of nodes(row, 'c')) {
        const address = attr(cell, 'r') || columnName(previousColumn + 1) + rowNumber, position = cellAddress(address); if (position.row !== rowNumber || seen.has(address) || ++cells > 100000) fail('单元格位置重复或超过 100,000 个。'); seen.add(address); previousColumn = position.column;
        const type = attr(cell, 't') || 'n', formulaNode = first(cell, 'f'), valueNode = first(cell, 'v');
        const rawCached = valueNode ? text(valueNode) : undefined, cached = rawCached === '' && type !== 'str' ? undefined : rawCached, item = { cell: address, type, value: null };
        if (type === 's') {
          if (!/^\d+$/.test(cached || '') || Number(cached) >= shared.length) fail('单元格共享字符串引用无效。'); item.value = shared[Number(cached)];
        } else if (type === 'inlineStr') item.value = richText(first(cell, 'is'));
        else if (['n', 'str', 'd', 'e'].includes(type)) {
          if (type === 'n' && cached !== undefined && !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(cached)) fail('数字单元格包含无效值。');
          item.value = cached ?? null;
        }
        else if (type === 'b') { if (cached !== undefined && !['0', '1'].includes(cached)) fail('复选值无效。'); item.value = cached === undefined ? null : cached === '1'; }
        else fail('包含尚未支持的单元格类型。');
        const style = attr(cell, 's'); if (style !== undefined && !/^\d+$/.test(style)) fail('单元格格式索引无效。');
        item.format = formats[Number(style || 0)] || 'General';
        if (style !== undefined && !formats[Number(style)] && Number(style) !== 0) { item.format_unknown = true; notes.add('部分单元格格式未取得，保留原始值，未推断日期或显示格式。'); }
        if (type === 'n' && cached !== undefined) { const date = serialDate(cached, item.format, date1904); if (date) item.date_interpretation = date; }
        if (formulaNode) {
          item.formula = text(formulaNode); item.formula_executed = false; item.cached_value_available = cached !== undefined;
          const kind = attr(formulaNode, 't') || 'normal'; item.formula_kind = kind;
          if (kind !== 'normal') {
            item.formula_range = attr(formulaNode, 'ref') || null; item.shared_formula_index = attr(formulaNode, 'si') || null;
            notes.add('共享、数组或数据表等特殊公式没有展开，保留本单元格公式文字与保存时缓存。');
          }
          if (cached === undefined) notes.add('部分公式缺少保存时的计算缓存，没有执行这些公式。');
        }
        output.cells.push(item);
      }
      output.cells.sort((a, b) => cellAddress(a.cell).column - cellAddress(b.cell).column); result.rows.push(output);
    }
    const merges = nodes(first(root, 'mergeCells') || { children: [] }, 'mergeCell'); if (merges.length > 1000) fail('合并单元格范围过多。');
    for (const merge of merges) { const range = attr(merge, 'ref'), parts = range?.split(':'); if (!parts || parts.length !== 2) fail('合并单元格范围无效。'); parts.forEach(cellAddress); result.merged_cells.push(range); }
    sheets.push(result);
  }
  if (zip.names.some(name => /vbaProject\.bin$/i.test(name))) notes.add('工作簿包含宏；没有运行或解析宏代码。');
  if (zip.names.some(name => /^xl\/(?:charts|drawings|comments|externalLinks)\//.test(name) || /^xl\/comments\d+\.xml$/.test(name))) notes.add('图表、绘图、批注或外部链接未展开，仅读取工作表单元格。');
  return { format: 'xlsx', date_system: date1904 ? '1904' : '1900', sheets, warnings: notes.list(), complete: notes.list().length === 0, formula_execution: false, layout_rendered: false };
}
module.exports = { docx, xlsx, serialDate };
