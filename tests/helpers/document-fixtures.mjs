import { deflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { crc32 } = require('../../src/document-zip.cjs');
export function officeZip(parts, { descriptor = false } = {}) {
  const local = [], central = []; let offset = 0;
  for (const [name, value] of Object.entries(parts)) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value), filename = Buffer.from(name), packed = deflateRawSync(data), crc = crc32(data), flags = 0x800 | (descriptor ? 8 : 0);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(8, 8);
    if (!descriptor) { header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(data.length, 22); } header.writeUInt16LE(filename.length, 26);
    const trailer = descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (descriptor) { trailer.writeUInt32LE(0x08074b50); trailer.writeUInt32LE(crc, 4); trailer.writeUInt32LE(packed.length, 8); trailer.writeUInt32LE(data.length, 12); }
    local.push(header, filename, packed, trailer);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(flags, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42); central.push(entry, filename);
    offset += header.length + filename.length + packed.length + trailer.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(parts).length, 8); end.writeUInt16LE(Object.keys(parts).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', P = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const docxParts = () => ({
  'word/document.xml': `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:r><w:t>合成 Word 青色927 😀</w:t></w:r><w:del><w:r><w:delText>删除文字不得恢复</w:delText></w:r></w:del><w:r><w:footnoteReference w:id="1"/></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>合成甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:headerReference w:type="default" r:id="header"/></w:sectPr></w:body></w:document>`,
  'word/_rels/document.xml.rels': `<Relationships xmlns="${P}"><Relationship Id="header" Type="${R}/header" Target="header1.xml"/><Relationship Id="footnote" Type="${R}/footnotes" Target="footnotes.xml"/></Relationships>`,
  'word/header1.xml': `<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>合成页眉</w:t></w:r></w:p></w:hdr>`,
  'word/footnotes.xml': `<w:footnotes xmlns:w="${W}"><w:footnote w:id="1"><w:p><w:r><w:t>合成脚注来源</w:t></w:r></w:p></w:footnote></w:footnotes>`
});
export const xlsxParts = () => ({
  'xl/workbook.xml': `<workbook xmlns="${S}" xmlns:r="${R}"><workbookPr date1904="0"/><sheets><sheet name="合成数据" sheetId="1" r:id="one"/><sheet name="隐藏合成表" sheetId="2" state="hidden" r:id="two"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${P}"><Relationship Id="one" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="two" Type="${R}/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="strings" Type="${R}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/></Relationships>`,
  'xl/sharedStrings.xml': `<sst xmlns="${S}"><si><t>合成表格青色927</t></si><si><r><t>中文</t></r><r><t>与😀</t></r></si></sst>`,
  'xl/styles.xml': `<styleSheet xmlns="${S}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
  'xl/worksheets/sheet1.xml': `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12.50</v></c><c r="C1" t="b"><v>1</v></c></row><row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><f>SUM(B1,2)</f><v>14.5</v></c><c r="C3" s="1"><v>61</v></c></row></sheetData><mergeCells><mergeCell ref="A5:B5"/></mergeCells></worksheet>`,
  'xl/worksheets/sheet2.xml': `<worksheet xmlns="${S}"><sheetData><row r="2" hidden="1"><c r="C2" t="inlineStr"><is><t>隐藏表明确标注</t></is></c></row></sheetData></worksheet>`
});
function pdfObjects(objects) {
  const buffers = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')], positions = [0]; let length = buffers[0].length;
  for (const [index, object] of objects.entries()) {
    positions.push(length); const buffer = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, 'latin1'); buffers.push(buffer); length += buffer.length;
  }
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ', ...positions.slice(1).map(value => String(value).padStart(10, '0') + ' 00000 n '), 'trailer', `<< /Size ${objects.length + 1} /Root 1 0 R >>`, 'startxref', String(length), '%%EOF\n'].join('\n');
  return Buffer.concat([...buffers, Buffer.from(xref, 'latin1')]);
}
const stream = content => `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
export function textPdf(pages = ['SYNTHETIC PDF CYAN927'], { script = false } = {}) {
  const objects = [`<< /Type /Catalog /Pages 2 0 R ${script ? '/OpenAction << /S /JavaScript /JS (throw bad_document_script) >>' : ''} >>`,
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  pages.forEach((value, index) => { const escaped = value.replace(/[\\()]/g, '\\$&');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`, stream(`BT /F1 12 Tf 50 700 Td (${escaped}) Tj ET`));
  }); return pdfObjects(objects);
}
export function chinesePdf() {
  const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Synthetic def /CMapType 2 def 1 begincodespacerange <0000> <ffff> endcodespacerange 3 beginbfchar <0001> <5408> <0002> <6210> <0003> <9752> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
  return pdfObjects(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticChinese /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticChinese /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /CIDToGIDMap /Identity >>', stream(cmap), stream('BT /F1 12 Tf 50 700 Td <000100020003> Tj ET')]);
}
export function chineseCmapPdf() {
  return pdfObjects(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>',
    stream('BT /F1 12 Tf 50 700 Td <540862109752> Tj ET')]);
}
