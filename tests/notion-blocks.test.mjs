import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { definitions, writeTools, createSession } = createRequire(import.meta.url)('../src/notion-blocks.cjs');
const P = '11111111-1111-4111-8111-111111111111', A = '22222222-2222-4222-8222-222222222222', B = '33333333-3333-4333-8333-333333333333', OTHER = '44444444-4444-4444-8444-444444444444';
const rich = content => [{ type: 'text', text: { content } }];
const para = content => ({ type: 'paragraph', paragraph: { rich_text: rich(content) } });
function fixture(extra = {}) {
  let sequence = 10, edited = 0;
  const blocks = new Map([
    [P, { object: 'block', id: P, type: 'child_page', child_page: { title: '合成父页' }, parent: { type: 'workspace', workspace: true }, has_children: true, in_trash: false }],
    [A, { object: 'block', id: A, ...para('必须保留的原文'), parent: { type: 'page_id', page_id: P }, has_children: false, in_trash: false }],
    [B, { object: 'block', id: B, type: 'to_do', to_do: { rich_text: rich('既有待办'), checked: false, color: 'default' }, parent: { type: 'page_id', page_id: P }, has_children: false, in_trash: false }],
    [OTHER, { object: 'block', id: OTHER, ...para('其他容器中的块'), parent: { type: 'page_id', page_id: OTHER }, has_children: false, in_trash: false }]
  ]);
  const children = new Map([[P, [A, B]]]), calls = [], mutations = [], authorizations = [];
  const create = (input, parent) => {
    const id = `55555555-5555-4555-8555-${String(++sequence).padStart(12, '0')}`;
    const type = input.type || Object.keys(input).find(key => key !== 'object'), payload = structuredClone(input[type]);
    const nested = payload.children; delete payload.children;
    const block = { object: 'block', id, type, [type]: payload, parent: { type: 'block_id', block_id: parent }, has_children: !!nested?.length, in_trash: false, last_edited_time: String(++edited) };
    blocks.set(id, block);
    if (nested) children.set(id, nested.map(child => create(child, id).id));
    return structuredClone(block);
  };
  const request = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (extra.request) { const result = await extra.request({ method, endpoint, body, blocks, children }); if (result) return result; }
    const url = new URL(endpoint, 'https://api.notion.com/v1/'), match = url.pathname.match(/\/blocks\/([^/]+)(\/children)?$/);
    if (!match) throw Error('Unexpected synthetic endpoint');
    const id = match[1], block = blocks.get(id);
    if (!block) throw Error('Notion API 返回 HTTP 404。');
    if (match[2]) {
      if (method === 'GET') {
        const ids = children.get(id) || [], offset = Number((url.searchParams.get('start_cursor') || 'c:0').slice(2)), size = Number(url.searchParams.get('page_size'));
        const batch = ids.slice(offset, offset + size), has_more = offset + batch.length < ids.length;
        return { object: 'list', results: batch.map(child => structuredClone(blocks.get(child))), has_more, next_cursor: has_more ? 'c:' + (offset + batch.length) : null };
      }
      assert.equal(method, 'PATCH');
      const added = body.children.map(input => create(input, id)), ids = children.get(id) || [];
      const at = body.after ? ids.indexOf(body.after) + 1 : ids.length;
      ids.splice(at, 0, ...added.map(item => item.id)); children.set(id, ids);
      return { object: 'list', results: added, has_more: false, next_cursor: null };
    }
    if (method === 'PATCH') {
      for (const [key, value] of Object.entries(body)) {
        if (key === 'in_trash') block.in_trash = value;
        else block[key] = { ...block[key], ...structuredClone(value) };
      }
      block.last_edited_time = String(++edited);
    }
    if (method === 'DELETE') { block.in_trash = true; block.last_edited_time = String(++edited); }
    return structuredClone(block);
  };
  const authorize = async (id, kind) => { authorizations.push({ id, kind }); if (!blocks.has(id) || extra.blockedReferences?.has(id) && ['page', 'database', 'block'].includes(kind)) throw Error('Notion 该块不在授权范围内。'); return id; };
  const mutate = async intent => {
    mutations.push(intent);
    const submitted = await request(intent.method, intent.endpoint, intent.body);
    const verified = await intent.verify(submitted);
    return { ...verified, operation_id: 'synthetic-' + mutations.length };
  };
  return { session: createSession({ request, authorize, mutate, signal: extra.signal }), request, blocks, children, calls, mutations, authorizations };
}

test('block catalog separates read tools and mutation tools with bounded payloads', () => {
  assert.deepEqual(definitions.map(def => def.function.name), ['read_block', 'read_block_children', 'append_blocks', 'update_block', 'trash_block', 'restore_block']);
  assert.deepEqual([...writeTools], ['append_blocks', 'update_block', 'trash_block', 'restore_block']);
  assert.ok(definitions.every(def => def.function.parameters.additionalProperties === false));
});

test('block children paginate and returned revisions can safely update the selected child', async () => {
  const f = fixture();
  const first = await f.session.execute('read_block_children', { block_id: P, page_size: 1 });
  assert.equal(first.has_more, true); assert.equal(first.complete, false); assert.equal(first.results[0].id, A);
  const second = await f.session.execute('read_block_children', { block_id: P, page_size: 1, start_cursor: first.next_cursor });
  assert.equal(second.has_more, false); assert.equal(second.results[0].id, B);
  const result = await f.session.execute('update_block', { block_id: B, block_revision: second.results[0].block_revision, block: { type: 'to_do', to_do: { checked: true } } });
  assert.equal(result.verified, true); assert.equal(f.blocks.get(B).to_do.checked, true);
  assert.deepEqual(f.blocks.get(B).to_do.rich_text, rich('既有待办'));
});

test('structured append preserves existing blocks and independently verifies rich, media and nested table content', async () => {
  const f = fixture(), beforeA = structuredClone(f.blocks.get(A)), beforeB = structuredClone(f.blocks.get(B));
  const inputs = [
    { type: 'heading_2', heading_2: { rich_text: rich('新增小节'), color: 'blue' } },
    { type: 'code', code: { rich_text: rich('print("synthetic")'), language: 'python', caption: rich('合成代码') } },
    { type: 'image', image: { type: 'external', external: { url: 'https://example.com/synthetic.png' }, caption: rich('合成图片') } },
    { type: 'table', table: { table_width: 2, has_column_header: true, has_row_header: false, children: [{ type: 'table_row', table_row: { cells: [rich('词汇'), rich('解释')] } }] } },
    { type: 'callout', callout: { rich_text: rich('提示'), icon: { type: 'emoji', emoji: '💡' }, children: [para('嵌套正文')] } }
  ];
  const result = await f.session.execute('append_blocks', { block_id: P, blocks: inputs });
  assert.equal(result.verified, true); assert.equal(result.created_block_ids.length, inputs.length);
  assert.deepEqual(f.blocks.get(A), beforeA); assert.deepEqual(f.blocks.get(B), beforeB);
  assert.deepEqual(f.children.get(P).slice(0, 2), [A, B]);
  assert.equal(f.mutations.length, 1); assert.equal(f.mutations[0].target, P);
  assert.ok(result.created_block_ids.every(id => f.calls.some(call => call.method === 'GET' && call.endpoint === 'blocks/' + id)));
  assert.ok(f.calls.some(call => call.endpoint.includes('/children?') && call.endpoint.startsWith('blocks/55555555')));
});

test('after insertion only accepts a direct child of the same container', async () => {
  const f = fixture();
  await assert.rejects(f.session.execute('append_blocks', { block_id: P, after: OTHER, blocks: [para('拒绝插入')] }), /直接子块/);
  assert.equal(f.mutations.length, 0);
  const result = await f.session.execute('append_blocks', { block_id: P, after: A, blocks: [para('插入中间')] });
  assert.equal(result.verified, true);
  assert.deepEqual(f.children.get(P), [A, result.created_block_ids[0], B]);
});

test('editing without a read, stale revisions and block type conversion never submit a write', async () => {
  const f = fixture();
  await assert.rejects(f.session.execute('update_block', { block_id: A, block_revision: '0'.repeat(64), block: para('无读取') }), /先在本轮读取/);
  const a = await f.session.execute('read_block', { block_id: A });
  f.blocks.get(A).paragraph.rich_text = rich('其他用户已修改');
  await assert.rejects(f.session.execute('update_block', { block_id: A, block_revision: a.block_revision, block: para('过期覆盖') }), /读取后已变化/);
  const current = await f.session.execute('read_block', { block_id: A });
  await assert.rejects(f.session.execute('update_block', { block_id: A, block_revision: current.block_revision, block: { type: 'heading_1', heading_1: { rich_text: rich('更换类型') } } }), /改变块类型/);
  assert.equal(f.mutations.length, 0);
});

test('trash and restore read back state and preserve content; generic blocks cannot delete pages', async () => {
  const f = fixture(), before = structuredClone(f.blocks.get(A).paragraph);
  const page = await f.session.execute('read_block', { block_id: P });
  await assert.rejects(f.session.execute('trash_block', { block_id: P, block_revision: page.block_revision }), /页面和数据库/);
  const block = await f.session.execute('read_block', { block_id: A });
  const trashed = await f.session.execute('trash_block', { block_id: A, block_revision: block.block_revision });
  assert.equal(trashed.verified, true); assert.equal(f.blocks.get(A).in_trash, true);
  const restored = await f.session.execute('restore_block', { block_id: A, block_revision: trashed.block_revision });
  assert.equal(restored.verified, true); assert.equal(f.blocks.get(A).in_trash, false);
  assert.deepEqual(f.blocks.get(A).paragraph, before);
  assert.deepEqual(f.mutations.map(intent => intent.method), ['DELETE', 'PATCH']);
  assert.deepEqual(f.mutations[1].body, { in_trash: false });
});

test('invalid structures, server metadata, unsafe URLs and excess nesting never reach mutation', async () => {
  const f = fixture();
  const invalid = [
    { type: 'child_page', child_page: { title: '不能假冒创建页面' } },
    { ...para('带服务端字段'), id: A },
    { type: 'image', image: { type: 'external', external: { url: 'file:///C:/secret.txt' } } },
    { type: 'table', table: { table_width: 2, children: [{ type: 'table_row', table_row: { cells: [rich('只有一列')] } }] } },
    { type: 'synced_block', synced_block: { synced_from: { block_id: OTHER } } },
    { type: 'paragraph', paragraph: { rich_text: rich('超层级'), children: [{ type: 'paragraph', paragraph: { rich_text: rich('1'), children: [{ type: 'paragraph', paragraph: { rich_text: rich('2'), children: [para('3')] } }] } }] } }
  ];
  for (const block of invalid) await assert.rejects(f.session.execute('append_blocks', { block_id: P, blocks: [block] }), /^Error: Notion /);
  assert.equal(f.mutations.length, 0);
});

test('readback mismatch is returned as unverified without repeating the append', async () => {
  let changed = false;
  const f = fixture({ request: ({ method, endpoint, blocks }) => {
    if (!changed && method === 'GET' && endpoint.startsWith('blocks/55555555')) {
      changed = true; const block = blocks.get(endpoint.slice(7)); block.paragraph.rich_text = rich('模拟并发变更');
    }
  } });
  const result = await f.session.execute('append_blocks', { block_id: P, blocks: [para('期望的原始提交')] });
  assert.equal(result.verified, false);
  assert.equal(f.mutations.length, 1);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('native stop before block execution issues no API or mutation request', async () => {
  const stop = new AbortController(); stop.abort();
  const f = fixture({ signal: stop.signal });
  await assert.rejects(f.session.execute('append_blocks', { block_id: P, blocks: [para('不应发送')] }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0); assert.equal(f.authorizations.length, 0); assert.equal(f.mutations.length, 0);
});

test('out-of-scope page and database references are rejected recursively before append or update', async () => {
  const f = fixture({ blockedReferences: new Set([OTHER]) });
  const mention = type => [{ type: 'mention', mention: { type, [type]: { id: OTHER } } }];
  const inputs = [
    { type: 'link_to_page', link_to_page: { type: 'page_id', page_id: OTHER } },
    { type: 'link_to_page', link_to_page: { type: 'database_id', database_id: OTHER } },
    { type: 'paragraph', paragraph: { rich_text: mention('page') } },
    { type: 'callout', callout: { rich_text: rich('包含嵌套引用'), children: [{ type: 'code', code: { rich_text: rich('synthetic'), language: 'plain text', caption: mention('database') } }] } },
    { type: 'table', table: { table_width: 1, children: [{ type: 'table_row', table_row: { cells: [mention('page')] } }] } }
  ];
  for (const block of inputs) await assert.rejects(f.session.execute('append_blocks', { block_id: P, blocks: [block] }), /授权范围/);
  const before = await f.session.execute('read_block', { block_id: A });
  await assert.rejects(f.session.execute('update_block', { block_id: A, block_revision: before.block_revision, block: { type: 'paragraph', paragraph: { rich_text: mention('database') } } }), /授权范围/);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.calls.some(call => call.method !== 'GET'), false);
});

test('authorized references retain their specific resource kinds and repeated mentions are checked once', async () => {
  const f = fixture();
  const mention = { type: 'mention', mention: { type: 'page', page: { id: A } } };
  const result = await f.session.execute('append_blocks', { block_id: P, blocks: [
    { type: 'paragraph', paragraph: { rich_text: [mention, mention] } },
    { type: 'link_to_page', link_to_page: { type: 'database_id', database_id: B } }
  ] });
  assert.equal(result.verified, true);
  assert.deepEqual(f.authorizations.filter(item => item.kind !== 'block'), [{ id: A, kind: 'page' }, { id: B, kind: 'database' }]);
});
