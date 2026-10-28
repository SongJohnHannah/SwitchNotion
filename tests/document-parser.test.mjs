import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { officeZip, docxParts, xlsxParts, textPdf, chinesePdf, chineseCmapPdf } from './helpers/document-fixtures.mjs';
const require = createRequire(import.meta.url), { parseAttachment } = require('../src/document-parser.cjs');
const { readZip, crc32 } = require('../src/document-zip.cjs');
const { serialDate } = require('../src/document-office.cjs');
const wordType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', excelType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test('UTF-8, marked UTF-16, JSON and RFC-style CSV/TSV preserve Unicode and literal formulas without executing them', async () => {
  const value = '合成青色927 😀';
  for (const bytes of [Buffer.from(value), Buffer.concat([Buffer.from([255, 254]), Buffer.from(value, 'utf16le')])]) assert.equal((await parseAttachment(bytes, '中文 文件.txt', 'text/plain')).text, value);
  const csv = await parseAttachment(Buffer.from('姓名,内容\r\n合成甲,"含逗号,和换行\n青色927"\r\n合成乙,=HYPERLINK("""https://example.com""" )'), 'data.csv', 'text/csv').catch(() => null);
  assert.equal(csv, null, 'Malformed quotes are rejected instead of repaired');
  const valid = await parseAttachment(Buffer.from('姓名,内容\r\n合成甲,"含逗号,和换行\n青色927"\r\n合成乙,"=SUM(1,2)"\r\n'), 'data.csv', 'text/csv');
  assert.equal(valid.rows[1].values[1], '含逗号,和换行\n青色927'); assert.equal(valid.rows[2].values[1], '=SUM(1,2)'); assert.equal(valid.formula_execution, false);
  assert.equal((await parseAttachment(Buffer.from('甲\t乙\n1\t2'), 'data.tsv', 'text/tab-separated-values')).rows[1].values[1], '2');
  assert.match((await parseAttachment(Buffer.from('{"合成":"青色927"}'), 'data.json', 'application/json')).text, /青色927/);
});

test('DOCX preserves paragraph/table order, referenced header and footnote, but never restores deleted text', async () => {
  const result = await parseAttachment(officeZip(docxParts(), { descriptor: true }), '文档.docx', wordType);
  assert.equal(result.complete, true); assert.equal(result.sections[0].blocks[0].text, '合成 Word 青色927 😀[脚注1]');
  assert.equal(result.sections[0].blocks[1].rows[1][1][0].text, '12');
  assert.deepEqual(result.sections.map(value => value.label), ['正文', '页眉', '脚注1']); assert.ok(!JSON.stringify(result).includes('删除文字不得恢复'));
  assert.equal(result.external_resources_fetched, false); assert.equal(result.layout_rendered, false);
});

test('DOCX extension content and XLSX shared formulas disclose the parts not expanded', async () => {
  const word = docxParts();
  word['word/document.xml'] = word['word/document.xml'].replace('</w:body>', '<x:extension xmlns:x="urn:synthetic-extension"><w:p><w:r><w:t>unhandled block</w:t></w:r></w:p></x:extension></w:body>');
  const parsed = await parseAttachment(officeZip(word), 'extension.docx', wordType);
  assert.equal(parsed.complete, false); assert.match(parsed.warnings.join(' '), /扩展格式/);
  const excel = xlsxParts();
  excel['xl/worksheets/sheet1.xml'] = excel['xl/worksheets/sheet1.xml'].replace(/<f>[^<]*<\/f>/, '<f t="shared" si="0"/>');
  const shared = await parseAttachment(officeZip(excel), 'shared.xlsx', excelType);
  const cell = shared.sheets[0].rows.flatMap(row => row.cells).find(cell => cell.formula_kind === 'shared');
  assert.equal(cell.formula, ''); assert.equal(cell.shared_formula_index, '0'); assert.equal(cell.cached_value_available, true);
  assert.equal(shared.complete, false); assert.match(shared.warnings.join(' '), /特殊公式没有展开/);
});

test('XLSX preserves cell addresses, shared strings, cached formulas, sparse rows and hidden sheet visibility', async () => {
  const result = await parseAttachment(officeZip(xlsxParts()), '工作簿.xlsx', excelType);
  assert.equal(result.complete, true); assert.equal(result.sheets.length, 2); assert.equal(result.sheets[0].rows[1].row, 3);
  assert.equal(result.sheets[0].rows[0].cells[0].value, '合成表格青色927'); assert.equal(result.sheets[0].rows[1].cells[0].value, '中文与😀');
  const formula = result.sheets[0].rows[1].cells[1]; assert.equal(formula.cell, 'B3'); assert.equal(formula.value, '14.5'); assert.equal(formula.formula_executed, false);
  assert.equal(result.sheets[0].rows[1].cells[2].date_interpretation, '1900-03-01'); assert.deepEqual(result.sheets[0].merged_cells, ['A5:B5']);
  assert.equal(result.sheets[1].visibility, 'hidden'); assert.equal(result.sheets[1].rows[0].hidden, true);
  assert.equal(serialDate('60', 'mm-dd-yy', false), '1900-02-29（Excel 兼容日期）'); assert.equal(serialDate('0', 'mm-dd-yy', true), '1904-01-01');
});

test('missing formula cache, macros and embedded objects are disclosed and do not become executed results', async () => {
  const parts = xlsxParts(); parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('<v>14.5</v>', ''); parts['xl/vbaProject.bin'] = Buffer.from('not executed');
  const result = await parseAttachment(officeZip(parts), 'cached.xlsx', excelType); assert.equal(result.complete, false);
  assert.equal(result.sheets[0].rows[1].cells[1].cached_value_available, false); assert.match(result.warnings.join(' '), /缓存/); assert.match(result.warnings.join(' '), /宏/);
  parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('<f>SUM(B1,2)</f>', '<f>SUM(B1,2)</f><v></v>');
  const empty = await parseAttachment(officeZip(parts), 'empty-cache.xlsx', excelType); assert.equal(empty.sheets[0].rows[1].cells[1].cached_value_available, false);
});

test('PDF text extraction preserves pages and Chinese ToUnicode mappings without rendering or running document JavaScript', async () => {
  const result = await parseAttachment(textPdf(['SYNTHETIC PDF CYAN927', 'SECOND PAGE 128'], { script: true }), '资料.pdf', 'application/pdf');
  assert.equal(result.complete, true); assert.match(result.pages[0].text, /CYAN927/); assert.equal(result.pages[1].page, 2); assert.match(result.pages[1].text, /128/);
  assert.equal(result.active_content_executed, false); assert.equal(result.embedded_media_read, false);
  const chinese = await parseAttachment(chinesePdf(), '中文.pdf', 'application/pdf'); assert.equal(chinese.pages[0].text, '合成青');
  const predefined = await parseAttachment(chineseCmapPdf(), '预定义中文映射.pdf', 'application/pdf'); assert.equal(predefined.pages[0].text, '合成青');
});

test('valid implicit cell/row coordinates are inferred while corrupt numeric cells fail explicitly', async () => {
  const parts = xlsxParts(); parts['xl/worksheets/sheet2.xml'] = parts['xl/worksheets/sheet2.xml'].replace('r="2" hidden', 'hidden').replace('r="C2"', '');
  const parsed = await parseAttachment(officeZip(parts), 'implicit.xlsx', excelType);
  assert.equal(parsed.sheets[1].rows[0].row, 1); assert.equal(parsed.sheets[1].rows[0].cells[0].cell, 'A1');
  parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('<v>12.50</v>', '<v>invalid-number</v>');
  await assert.rejects(parseAttachment(officeZip(parts), 'broken-number.xlsx', excelType), /数字单元格/);
});

test('image-only or malformed PDFs fail before model use and mixed missing text pages carry an incomplete flag', async () => {
  await assert.rejects(parseAttachment(textPdf(['']), 'scan.pdf', 'application/pdf'), /OCR/);
  const mixed = await parseAttachment(textPdf(['SYNTHETIC TEXT', '']), 'mixed.pdf', 'application/pdf'); assert.equal(mixed.complete, false); assert.match(mixed.warnings[0], /2/);
  await assert.rejects(parseAttachment(Buffer.from('%PDF-1.7\nbroken'), 'broken.pdf', 'application/pdf'), /PDF/);
});

test('XML entities and external parts never fetch remote resources, and invalid references fail instead of dropping sources', async () => {
  const dtd = docxParts(); dtd['word/document.xml'] = '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///not-readable">]>' + dtd['word/document.xml'];
  await assert.rejects(parseAttachment(officeZip(dtd), 'entities.docx', wordType), /DTD|XML/);
  const external = xlsxParts(); external['xl/_rels/workbook.xml.rels'] = external['xl/_rels/workbook.xml.rels'].replace('Target="worksheets/sheet1.xml"', 'Target="https://example.com/private" TargetMode="External"');
  await assert.rejects(parseAttachment(officeZip(external), 'external.xlsx', excelType), /关系|正文/);
  const missing = xlsxParts(); delete missing['xl/sharedStrings.xml']; await assert.rejects(parseAttachment(officeZip(missing), 'missing.xlsx', excelType), /缺少/);
});

test('ZIP CRC, path traversal, duplicate part names, encryption and output limits reject malformed archives', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.throws(() => readZip(officeZip({ '../escape.xml': '<x/>' })), /ZIP/);
  assert.throws(() => readZip(officeZip({ 'word/a.xml': '<x/>', 'word/A.xml': '<y/>' })), /ZIP/);
  const valid = officeZip({ 'word/a.xml': '<x/>' }), broken = Buffer.from(valid); broken[31 + Buffer.byteLength('word/a.xml')] ^= 1;
  assert.throws(() => readZip(broken).read('word/a.xml'), /ZIP/);
  const encrypted = Buffer.from(valid); encrypted.writeUInt16LE(0x801, 6); assert.throws(() => readZip(encrypted), /ZIP/);
});

test('binary masquerades, unsupported file kinds, oversize input and cancellation cannot yield partial success', async () => {
  await assert.rejects(parseAttachment(Buffer.from([0, 1, 2, 3]), 'fake.txt', 'text/plain'), /编码|二进制/);
  await assert.rejects(parseAttachment(Buffer.from('text'), 'legacy.doc', 'application/msword'), /目前支持/);
  await assert.rejects(parseAttachment(Buffer.alloc(16 * 1024 * 1024 + 1), 'large.txt', 'text/plain'), /过大/);
  await assert.rejects(parseAttachment(Buffer.from('x'.repeat(200001)), 'long.txt', 'text/plain'), /过长/);
  const controller = new AbortController(), parsing = parseAttachment(officeZip(docxParts()), 'cancel.docx', wordType, { signal: controller.signal }); controller.abort(Error('synthetic stop'));
  await assert.rejects(parsing, /synthetic stop/);
  await assert.rejects(parseAttachment(officeZip(docxParts()), 'timeout.docx', wordType, { timeoutMs: 1 }), /超时/);
});
