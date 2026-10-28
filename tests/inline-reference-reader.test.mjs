import test from 'node:test';
import assert from 'node:assert/strict';
import { createInlineReferenceReader, referencePointers } from '../src/inline-references.cjs';
const id = n => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
const SPACE = id(1), PAGE = id(2), OTHER_SPACE = id(3);
const pointer = n => ({ table: 'block', id: id(n), spaceId: SPACE });
const block = (n, type = 'paragraph', text = '', parent = PAGE, extra = {}) => ({ object: 'block', id: id(n), type,
  parent: { type: 'page_id', page_id: parent }, has_children: false,
  [type]: { rich_text: [{ type: 'text', plain_text: text, text: { content: text } }] }, ...extra });
const missing = () => Object.assign(Error('Notion API HTTP 404'), { status: 404 });
function setup(handler, limits) {
  const calls = [];
  const read = createInlineReferenceReader({ workspace: { open: async ({ signal }) => ({ execute: async (name, args) => {
    signal.throwIfAborted(); calls.push({ name, args }); return handler(name, args, signal);
  } }) }, ...limits });
  return { calls, read: args => read({ pointers: [], spaceId: SPACE, pageId: PAGE, ...args }) };
}

test('additional page references read every Markdown chunk in their explicit workspace', async () => {
  const f = setup(async (name, args) => {
    assert.equal(args.workspace_id, OTHER_SPACE);
    if (name === 'read_block') throw missing();
    if (name === 'read_page_info') return { page_id: id(4), title: '附加合成页', parent: { workspace: true } };
    if (name === 'read_page') return args.offset ? { markdown: '尾段927', incomplete: false, next_offset: null }
      : { markdown: '青色', incomplete: false, next_offset: 2 };
    assert.fail(name);
  });
  const result = await f.read({ pointers: [{ ...pointer(4), spaceId: OTHER_SPACE }] });
  assert.equal(result.references[0].text, '青色尾段927');
  assert.equal(result.references[0].complete, true);
  assert.deepEqual(f.calls.filter(c => c.name === 'read_page').map(c => c.args.offset), [0, 2]);
});

test('container-only selections read nested table rows and pagination without reading the whole page', async () => {
  const table = block(4, 'table', '', PAGE, { has_children: true }), row = n => block(n, 'table_row', '', id(4), {
    parent: { type: 'block_id', block_id: id(4) }, table_row: { cells: [[{ plain_text: n === 5 ? '第一行' : '第二行' }]] } });
  const f = setup((name, args) => {
    if (name === 'read_block') { assert.equal(args.block_id, id(4)); return { block: table }; }
    if (name === 'read_block_children') return { results: [row(args.start_cursor ? 6 : 5)],
      has_more: !args.start_cursor, next_cursor: args.start_cursor ? null : 'next-row' };
    assert.fail('Unexpected whole-page or write operation: ' + name);
  });
  const result = await f.read({ selection: { type: 'blocks', text: '', value: [pointer(4)] } });
  assert.deepEqual(result.selection.blocks[0].content.children.map(row => row.cells[0]), ['第一行', '第二行']);
  assert.equal(result.selection.complete, true);
});

test('block references retain task state, page mentions and media metadata with explicit body limits', async () => {
  const values = new Map([
    [id(4), block(4, 'to_do', '待确认', PAGE, { to_do: { checked: true, rich_text: [{ plain_text: '待确认',
      type: 'mention', mention: { type: 'page', page: { id: id(7) } } }] } })],
    [id(5), block(5, 'pdf', '', PAGE, { pdf: { type: 'external', external: { url: 'https://example.test/synthetic.pdf' }, caption: [{ plain_text: '合成附件' }] } })],
    [id(6), block(6, 'future_block', '未知正文', PAGE, { future_block: { synthetic_field: '实际返回字段' } })]
  ]);
  const f = setup((name, args) => { assert.equal(name, 'read_block'); return { block: values.get(args.block_id) }; });
  const result = await f.read({ pointers: [pointer(4), pointer(5), pointer(6)] });
  const [task, pdf, future] = result.references.map(ref => ref.content);
  assert.equal(task.data.checked, true);
  assert.equal(task.data.rich_text[0].mention.page.id, id(7));
  assert.equal(pdf.data.external.url, 'https://example.test/synthetic.pdf');
  assert.equal(pdf.body_available, false);
  assert.equal(future.data.synthetic_field, '实际返回字段');
  assert.equal(future.body_available, false);
  assert.ok(!f.calls.some(call => call.args.block_id === id(7)), 'mentions are not implicit read authorization');
});

test('database references include paginated records and complete fields without expanding record bodies', async () => {
  const entry = n => ({ page_id: id(n), properties: { 内容: '开头' }, property_ids: { 内容: 'rt' },
    property_types: { 内容: 'rich_text' }, incomplete_properties: n === 5 ? ['内容'] : [] });
  const f = setup((name, args) => {
    if (name === 'read_block') return { block: block(4, 'child_database') };
    if (name === 'read_database') return { database_id: id(4), data_source_ids: [id(7)], incomplete: false };
    if (name === 'query_database') return { results: [entry(args.start_cursor ? 6 : 5)], has_more: !args.start_cursor,
      next_cursor: args.start_cursor ? null : 'next-entry' };
    if (name === 'read_database_entry_property') return { items: [args.start_cursor ? '结尾' : '开头'],
      has_more: !args.start_cursor, next_cursor: args.start_cursor ? null : 'next-property' };
    assert.fail(name);
  });
  const result = await f.read({ pointers: [pointer(4)] });
  assert.equal(result.references[0].rows.length, 2);
  assert.equal(result.references[0].rows[0].properties.内容, '开头结尾');
  assert.deepEqual(result.references[0].rows[0].incomplete_properties, []);
  assert.equal(result.references[0].view_scope, 'database-all-records');
});

test('truncated text ranges use grapheme offsets, preserving emoji families and combining marks', async () => {
  const f = setup(name => { assert.equal(name, 'read_block'); return { block: block(4, 'paragraph', 'A👨‍👩‍👧‍👦e\u0301中尾巴') }; });
  const result = await f.read({ selection: { type: 'text', text: '👨‍👩‍👧‍👦', isPreviewTruncated: true,
    value: { start: { pointer: pointer(4), index: 1 }, end: { pointer: pointer(4), index: 5 } } } });
  assert.equal(result.selection.text, '👨‍👩‍👧‍👦e\u0301中尾');
});

test('cross-block ranges preserve ordered nested content while excluding unselected siblings', async () => {
  const values = new Map([
    [PAGE, block(2, 'child_page', '', null, { parent: { workspace: true }, has_children: true })],
    [id(4), block(4, 'paragraph', 'AA开始')], [id(5), block(5, 'toggle', '中间', PAGE, { has_children: true })],
    [id(6), block(6, 'paragraph', '嵌套内容', id(5), { parent: { type: 'block_id', block_id: id(5) } })],
    [id(7), block(7, 'paragraph', '尾END')], [id(8), block(8, 'paragraph', 'UNSELECTED')]
  ]);
  const f = setup((name, args) => {
    if (name === 'read_block') return { block: values.get(args.block_id) };
    if (name === 'read_block_children') return { results: args.block_id === PAGE
      ? [values.get(id(4)), values.get(id(5)), values.get(id(7)), values.get(id(8))] : [values.get(id(6))], has_more: false };
    assert.fail(name);
  });
  const result = await f.read({ selection: { type: 'text', text: '开始', isPreviewTruncated: true,
    value: { start: { pointer: pointer(4), index: 2 }, end: { pointer: pointer(7), index: 1 } } } });
  assert.equal(result.selection.text, '开始\n中间\n嵌套内容\n尾');
  assert.ok(!JSON.stringify(result).includes('UNSELECTED'));
});

test('permission errors, stale previews and repeated cursors fail without returning partial content', async () => {
  const permission = setup(() => { throw Object.assign(Error('Notion API HTTP 403'), { status: 403 }); });
  await assert.rejects(permission.read({ pointers: [pointer(4)] }), /403/); assert.equal(permission.calls.length, 1);
  const stale = setup(() => ({ block: block(4, 'paragraph', '已经变化的内容') }));
  await assert.rejects(stale.read({ selection: { type: 'text', text: '原内容', isPreviewTruncated: true,
    value: { start: { pointer: pointer(4), index: 0 }, end: { pointer: pointer(4), index: 5 } } } }), /不一致/);
  const cycle = setup(name => name === 'read_block' ? { block: block(4, 'toggle', '', PAGE, { has_children: true }) }
    : { results: [], has_more: true, next_cursor: 'same' });
  await assert.rejects(cycle.read({ pointers: [pointer(4)] }), /分页不完整/);
});

test('cancellation and size limits stop reads without invoking any writing tools', async () => {
  const abort = new AbortController();
  const f = setup(async (name, _args, signal) => {
    assert.equal(name, 'read_block'); abort.abort(); signal.throwIfAborted();
  });
  await assert.rejects(f.read({ pointers: [pointer(4)], signal: abort.signal })); assert.equal(f.calls.length, 1);
  const bounded = setup(() => ({ block: block(4, 'paragraph', 'x'.repeat(200)) }), { maxCharacters: 100 });
  await assert.rejects(bounded.read({ pointers: [pointer(4)] }), /内容过长/);
});

test('pointer normalization keeps only source IDs, rejects unsupported sources and does not silently lose references', () => {
  assert.deepEqual(referencePointers([{ ...pointer(4), token: 'must-not-forward' }, pointer(4)], SPACE), [pointer(4)]);
  assert.throws(() => referencePointers([{ table: 'file', id: id(4) }], SPACE), /类型或标识/);
  assert.throws(() => referencePointers(Array(33).fill(pointer(4)), SPACE), /32/);
});

test('selected blocks use the selection budget rather than the 32 attached-reference limit', async () => {
  const f = setup((name, args) => {
    assert.equal(name, 'read_block'); return { block: block(Number(args.block_id.slice(-12)), 'paragraph', '合成内容') };
  });
  const result = await f.read({ selection: { type: 'blocks', text: '', value: Array.from({ length: 33 }, (_, i) => pointer(i + 10)) } });
  assert.equal(result.selection.blocks.length, 33);
});

test('page edits between chunks are rejected instead of combining different document versions', async () => {
  const f = setup((name, args) => {
    if (name === 'read_block') throw missing();
    if (name === 'read_page_info') return { title: '合成页' };
    if (name === 'read_page') return { markdown: '内容', revision: args.offset ? 'changed' : 'original',
      next_offset: args.offset ? null : 2 };
    assert.fail(name);
  });
  await assert.rejects(f.read({ pointers: [pointer(4)] }), /分页读取期间发生变化/);
});

test('an unavailable enclosing page is not read above the selected page boundary', async () => {
  const first = block(4, 'paragraph', '合成开头'), last = block(5, 'paragraph', '合成结尾');
  const page = block(2, 'child_page', '', id(99), { has_children: true });
  const f = setup((name, args) => {
    if (name === 'read_block') {
      assert.notEqual(args.block_id, id(99), 'Do not expand reads above the current page');
      return { block: args.block_id === id(4) ? first : args.block_id === id(5) ? last : page };
    }
    if (name === 'read_block_children') return { results: [first, last], has_more: false };
    assert.fail(name);
  });
  const result = await f.read({ selection: { type: 'text', text: '合成', isPreviewTruncated: true,
    value: { start: { pointer: pointer(4), index: 0 }, end: { pointer: pointer(5), index: 2 } } } });
  assert.equal(result.selection.text, '合成开头\n合成');
});
