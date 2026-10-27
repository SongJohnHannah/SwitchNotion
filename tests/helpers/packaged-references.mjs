import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const SPACE = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const blockId = n => '44444444-4444-4444-8444-' + String(n).padStart(12, '0');
// Reading an opaque/unsupported block must still preserve its type and data.
// Media metadata is not proof that the model can see/hear its contents.
export const referencedBlockTypes = ['paragraph', 'heading_1', 'heading_2', 'heading_3', 'heading_4', 'bulleted_list_item', 'numbered_list_item', 'quote', 'to_do', 'toggle', 'callout', 'code', 'equation', 'divider', 'breadcrumb', 'table_of_contents', 'table', 'table_row', 'column_list', 'column', 'synced_block', 'link_to_page', 'child_page', 'child_database', 'image', 'video', 'audio', 'file', 'pdf', 'bookmark', 'embed', 'link_preview', 'tab', 'meeting_notes', 'unsupported'];

// Load the files copied by the real packager and exercise native input ->
// Agent -> scoped Router -> HTTP -> tool result -> model -> saved transcript.
export async function verifyPackagedReferences(sourceDirectory, root) {
  const require = createRequire(path.join(sourceDirectory, 'agent-mock.cjs'));
  const { AgentMock } = require('./agent-mock.cjs');
  const { NotionRouter } = require('./notion-routing.cjs');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'notion-connections.local.json'), JSON.stringify({ version: 2, connections: [{ workspaceId: SPACE, apiKey: 'synthetic-reference-test', enabled: true, readOnly: true }] }));
  const blocks = new Map(referencedBlockTypes.map((type, index) => [blockId(index), { object: 'block', id: blockId(index), type, parent: { type: 'page_id', page_id: PAGE }, has_children: type === 'table', [type]: { synthetic_marker: type + '-source' } }]));
  const calls = [], fetchImpl = async (url, options) => {
    const request = new URL(url); calls.push([options.method, request.pathname, request.search]);
    assert.equal(options.method, 'GET', 'Reference inspection must never write');
    let value;
    if (request.pathname === '/v1/users/me') value = { object: 'user', type: 'bot', bot: { workspace_id: SPACE, workspace_name: '合成引用测试' } };
    else if (request.pathname.endsWith('/children')) {
      const continued = request.searchParams.has('start_cursor');
      value = { results: [{ object: 'block', id: blockId(100 + Number(continued)), type: 'table_row', table_row: { cells: [[{ type: 'text', text: { content: continued ? 'second row' : 'first row' } }]] } }], has_more: !continued, next_cursor: continued ? null : 'second-batch' };
    } else if (request.pathname.startsWith('/v1/blocks/')) value = blocks.get(request.pathname.slice('/v1/blocks/'.length));
    if (!value) throw Error('Unexpected reference request: ' + request.pathname);
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
  const selection = { type: 'blocks', text: '', value: [...blocks.keys()].map(id => ({ table: 'block', id, spaceId: SPACE })) };
  let round = 0;
  const provider = { config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate({ messages, onToolCalls }) {
    const quote = messages.findLast(m => m.notionSwitchSelection);
    assert.deepEqual(JSON.parse(quote.content).value, selection.value);
    if (round++ === 0) {
      onToolCalls([...blocks.keys()].map((id, index) => ({ id: 'read-' + index, type: 'function', function: { name: 'read_block', arguments: JSON.stringify({ block_id: id }) } })));
    } else if (round === 2) {
      const results = messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
      assert.equal(results.length, referencedBlockTypes.length);
      assert.deepEqual(results.map(item => item.block.type), referencedBlockTypes);
      for (const item of results) { assert.equal(item.workspace_id, SPACE); assert.equal(item.block[item.block.type].synthetic_marker, item.block.type + '-source'); }
      onToolCalls([{ id: 'rows-1', type: 'function', function: { name: 'read_block_children', arguments: JSON.stringify({ block_id: blockId(referencedBlockTypes.indexOf('table')), page_size: 1 }) } }]);
    } else if (round === 3) {
      const result = JSON.parse(messages.at(-1).content);
      assert.equal(result.has_more, true); assert.equal(result.complete, false);
      onToolCalls([{ id: 'rows-2', type: 'function', function: { name: 'read_block_children', arguments: JSON.stringify({ block_id: blockId(referencedBlockTypes.indexOf('table')), page_size: 1, start_cursor: result.next_cursor }) } }]);
    } else {
      assert.equal(JSON.parse(messages.at(-1).content).complete, true);
      yield '所选引用已逐项读取（合成测试）。';
    }
  } };
  const stateFile = path.join(root, '引用 上下文.json');
  const agent = new AgentMock({ provider, workspace: new NotionRouter({ root, fetchImpl, intervalMs: 0 }), stateFile });
  agent.create({ spaceId: SPACE, threadId: 'packaged-reference-test', threadContext: { currentBlockId: PAGE, selectionPageId: PAGE, selection }, content: [{ type: 'text', text: '读取所有选中的引用；不要修改内容，也不要读取邻居页。' }] });
  for (let i = 0; agent.status().active && i < 200; i++) await sleep(5);
  assert.equal(agent.status().active, 0); assert.equal(agent.status().failed, 0); assert.equal(round, 4);
  assert.equal(calls.filter(([method, endpoint]) => endpoint.startsWith('/v1/blocks/') && !endpoint.endsWith('/children')).length, referencedBlockTypes.length);
  assert.ok(!JSON.stringify(calls).includes(OTHER));
  const restored = new AgentMock({ stateFile });
  const users = (await restored.transcript({ threadId: 'packaged-reference-test' }).json()).patches.filter(p => p.entity.kind === 'user_message');
  assert.deepEqual(users[0].entity.thread_context.selection, selection);
}
