const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { crc32 } = require('./document-zip.cjs');
const { scopeKey } = require('./workspace-memory.cjs');
const { uuid } = require('./native-context.cjs');
const xml = value => String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char])).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const relationships = entries => header + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + entries.map(([id, type, target]) => `<Relationship Id="${xml(id)}" Type="${rel}/${type}" Target="${xml(target)}"/>`).join('') + '</Relationships>';
function zip(parts) {
  const chunks = [], central = []; let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    const filename = Buffer.from(name), data = Buffer.from(content), crc = crc32(data), local = Buffer.alloc(30), directory = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(0x21, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    chunks.push(local, filename, data); central.push(directory, filename); offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(parts).length, 8); end.writeUInt16LE(Object.keys(parts).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...chunks, directory, end]);
}
function table(value) {
  if (!value || !Array.isArray(value.columns) || !value.columns.length || value.columns.length > 50 || value.columns.some(item => typeof item !== 'string' || item.length > 300) || !Array.isArray(value.rows) || value.rows.length > 2000 || value.rows.some(row => !Array.isArray(row) || row.length !== value.columns.length || row.some(cell => cell !== null && !['string', 'number', 'boolean'].includes(typeof cell) || typeof cell === 'string' && cell.length > 30000 || typeof cell === 'number' && !Number.isFinite(cell))) || value.rows.length * value.columns.length > 80000) throw Error('Notion 文件生成表格数据无效或超过范围。');
  return [value.columns, ...value.rows];
}
function spreadsheet(value) {
  const rows = table(value), column = number => { let result = ''; for (number++; number; number = Math.floor((number - 1) / 26)) result = String.fromCharCode(65 + (number - 1) % 26) + result; return result; };
  return zip({
    '[Content_Types].xml': header + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': relationships([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': header + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${rel}"><sheets><sheet name="AI结果" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relationships([['rId1', 'worksheet', 'worksheets/sheet1.xml']]),
    'xl/worksheets/sheet1.xml': header + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rows.map((row, index) => `<row r="${index + 1}">` + row.map((cell, at) => `<c r="${column(at)}${index + 1}"${typeof cell === 'number' ? '' : typeof cell === 'boolean' ? ' t="b"' : ' t="inlineStr"'}>${typeof cell === 'number' ? `<v>${cell}</v>` : typeof cell === 'boolean' ? `<v>${cell ? 1 : 0}</v>` : `<is><t xml:space="preserve">${xml(cell ?? '')}</t></is>`}</c>`).join('') + '</row>').join('') + '</sheetData></worksheet>'
  });
}
function presentation(slides) {
  if (!Array.isArray(slides) || !slides.length || slides.length > 30 || slides.some(slide => typeof slide.title !== 'string' || slide.title.length > 200 || typeof slide.body !== 'string' || slide.body.length > 4000)) throw Error('Notion 文件生成幻灯片应为 1—30 页，每页包含标题和正文。');
  const fittedFont = (text, preferred, minimum, height) => {
    for (let size = preferred; size >= minimum; size--) {
      const lines = text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil([...line].reduce((n, char) => n + (char.codePointAt(0) > 255 ? 1 : 0.6), 0) / (820 / size))), 0);
      if (lines * size * 1.3 <= height) return size * 100;
    }
    throw Error('Notion 文件生成幻灯片文字过多，请缩短标题或将正文拆成更多页。');
  };
  const ns = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${rel}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`, group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>', colors = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';
  const shape = (id, title, text, y, height, font) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${title}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="640000" y="${y}"/><a:ext cx="10900000" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${text.split('\n').map(line => `<a:p><a:r><a:rPr lang="zh-CN" sz="${font}"/><a:t xml:space="preserve">${xml(line)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${font}"/></a:p>`).join('')}</p:txBody></p:sp>`;
  const overrides = [['/ppt/presentation.xml', 'presentation.main'], ['/ppt/slideMasters/slideMaster1.xml', 'slideMaster'], ['/ppt/slideLayouts/slideLayout1.xml', 'slideLayout'], ...slides.map((_, i) => ['/ppt/slides/slide' + (i + 1) + '.xml', 'slide'])];
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>', theme = header + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Notion AI"><a:themeElements><a:clrScheme name="Notion AI">' + Object.entries({ dk1: '202020', lt1: 'FFFFFF', dk2: '314358', lt2: 'F5F7FA', accent1: '2673DB', accent2: '267D68', accent3: 'BE7540', accent4: '7554A3', accent5: '4987A0', accent6: 'A65364', hlink: '2673DB', folHlink: '7554A3' }).map(([name, color]) => `<a:${name}><a:srgbClr val="${color}"/></a:${name}>`).join('') + '</a:clrScheme><a:fontScheme name="Default"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Default"><a:fillStyleLst>' + fill.repeat(3) + '</a:fillStyleLst><a:lnStyleLst>' + [9525, 25400, 38100].map(width => `<a:ln w="${width}">${fill}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join('') + '</a:lnStyleLst><a:effectStyleLst>' + '<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3) + '</a:effectStyleLst><a:bgFillStyleLst>' + fill.repeat(3) + '</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
  const parts = {
    '[Content_Types].xml': header + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + overrides.map(([name, type]) => `<Override PartName="${name}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${type}+xml"/>`).join('') + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>',
    '_rels/.rels': relationships([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': header + `<p:presentation ${ns}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relationships([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...slides.map((_, i) => ['rId' + (i + 2), 'slide', 'slides/slide' + (i + 1) + '.xml'])]),
    'ppt/slideMasters/slideMaster1.xml': header + `<p:sldMaster ${ns}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group}</p:spTree></p:cSld><p:clrMap ${colors}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': relationships([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]),
    'ppt/theme/theme1.xml': theme,
    'ppt/slideLayouts/slideLayout1.xml': header + `<p:sldLayout ${ns} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': relationships([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])
  };
  slides.forEach((slide, i) => {
    parts['ppt/slides/slide' + (i + 1) + '.xml'] = header + `<p:sld ${ns}><p:cSld><p:spTree>${group}${shape(2, '标题', slide.title, 450000, 950000, fittedFont(slide.title, 34, 24, 62))}${shape(3, '正文', slide.body, 1550000, 4700000, fittedFont(slide.body, 22, 12, 350))}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    parts['ppt/slides/_rels/slide' + (i + 1) + '.xml.rels'] = relationships([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]);
  });
  return zip(parts);
}
class GeneratedFiles {
  constructor({ root, printPdf }) { this.directory = path.join(root, 'generated-files'); this.printPdf = printPdf; }
  open(scope) {
    const key = scopeKey(scope), definitions = [{ type: 'function', function: { name: 'create_downloadable_file', description: '按当前用户要求生成可下载的 TXT/Markdown/CSV/JSON/XLSX/PPTX/PDF 文件。文件只含提供的数据，不执行代码、宏或公式。XLSX/CSV 用 table；PPTX 用 slides；PDF/TXT/Markdown 用 text。', parameters: { type: 'object', properties: { filename: { type: 'string' }, text: { type: 'string' }, table: { type: 'object', properties: { columns: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } } }, required: ['columns', 'rows'], additionalProperties: false }, slides: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'], additionalProperties: false } }, data: { type: 'object', additionalProperties: true } }, required: ['filename'], additionalProperties: false } } }];
    return { definitions, execute: async (name, args) => {
      scope.signal?.throwIfAborted(); if (name !== 'create_downloadable_file' || !args || typeof args !== 'object' || Object.keys(args).some(k => !['filename', 'text', 'table', 'slides', 'data'].includes(k)) || typeof args.filename !== 'string' || !args.filename.isWellFormed() || args.filename.length > 200 || /[\\/\x00-\x1f\x7f]/.test(args.filename) || JSON.stringify(args).length > 500000) throw Error('Notion 文件生成名称或内容无效。');
      const ext = path.extname(args.filename).toLowerCase(); let bytes, type;
      if (ext === '.xlsx') { bytes = spreadsheet(args.table); type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; }
      else if (ext === '.pptx') { bytes = presentation(args.slides); type = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'; }
      else if (ext === '.json') { if (!args.data || typeof args.data !== 'object') throw Error('Notion 文件生成 JSON 缺少 data。'); bytes = Buffer.from(JSON.stringify(args.data, null, 2)); type = 'application/json'; }
      else if (ext === '.csv') { bytes = Buffer.from('\uFEFF' + table(args.table).map(row => row.map(cell => '"' + String(typeof cell === 'string' && /^[=+@-]/.test(cell) ? "'" + cell : cell ?? '').replaceAll('"', '""') + '"').join(',')).join('\r\n')); type = 'text/csv'; }
      else if (['.txt', '.md', '.pdf'].includes(ext)) {
        if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 200000) throw Error('Notion 文件生成缺少正文或正文过长。');
        if (ext === '.pdf') { if (!this.printPdf) throw Error('Notion 文件生成 PDF 引擎尚未就绪。'); bytes = await this.printPdf(args.filename, args.text, scope.signal); type = 'application/pdf'; }
        else { bytes = Buffer.from(args.text); type = ext === '.md' ? 'text/markdown' : 'text/plain'; }
      } else throw Error('Notion 文件生成支持 TXT、MD、CSV、JSON、XLSX、PPTX、PDF。');
      scope.signal?.throwIfAborted(); if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 * 1024) throw Error('Notion 文件生成结果超过 16 MB。');
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); const id = randomUUID(), token = randomBytes(32).toString('hex'), metadata = { id, token, key, userId: scope.userId, spaceId: scope.spaceId, filename: args.filename, type, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      fs.writeFileSync(path.join(this.directory, id + '.bin'), bytes, { mode: 0o600, flag: 'wx', flush: true }); fs.writeFileSync(path.join(this.directory, id + '.json'), JSON.stringify(metadata), { mode: 0o600, flag: 'wx', flush: true });
      return { filename: args.filename, size_bytes: bytes.length, download_url: 'https://app.notion.com/notion-switch-generated/' + id + '/' + token, generated: true, formulas_executed: false, note: ext === '.csv' ? '可能被表格程序当作公式的文字已加单引号前缀。' : undefined };
    } };
  }
  serve(request) {
    const url = new URL(request.url), match = /^\/notion-switch-generated\/([a-f\d-]{36})\/([a-f\d]{64})$/.exec(url.pathname);
    if (!match || !uuid(match[1]) || !['GET', 'HEAD'].includes(request.method) || request.headers.get('sec-fetch-site') === 'cross-site') return new Response(null, { status: 404 });
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(this.directory, match[1] + '.json'), 'utf8'));
      if (metadata.token !== match[2] || request.headers.has('x-notion-active-user-header') && uuid(request.headers.get('x-notion-active-user-header')) !== uuid(metadata.userId) || request.headers.has('x-notion-space-id') && uuid(request.headers.get('x-notion-space-id')) !== uuid(metadata.spaceId)) return new Response(null, { status: 404 });
      const file = path.join(this.directory, match[1] + '.bin'), stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== metadata.bytes || stat.size > 16 * 1024 * 1024) throw Error();
      const bytes = fs.readFileSync(file); if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw Error();
      return new Response(request.method === 'HEAD' ? null : bytes, { headers: { 'content-type': metadata.type, 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(metadata.filename), 'content-length': String(bytes.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } catch { return new Response(null, { status: 404 }); }
  }
}
module.exports = { GeneratedFiles, spreadsheet, presentation, zip, xml };
