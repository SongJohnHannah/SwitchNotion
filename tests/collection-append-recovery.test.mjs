import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollectionNotion } = require('../src/collection/notion.cjs');
const { matchesBlockContent } = require('../src/notion-blocks.cjs');
const linked = url => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: '[S1]', link: { url } } }] } });

test('Notion query encoding changes compare equal while parameter values, order, and encoded paths remain significant', () => {
  const input = 'https://example.com/a%2Fb?ref=docs/path&sig=a%2Bb&x=1&x=2';
  const encoded = 'https://example.com/a%2Fb?ref=docs%2Fpath&sig=a%2Bb&x=1&x=2';
  assert.equal(matchesBlockContent(linked(encoded), linked(input)), true);
  for (const changed of [encoded.replace('sig=a%2Bb', 'sig=a+b'), encoded.replace('x=1&x=2', 'x=2&x=1'), encoded.replace('/a%2Fb', '/a/b'), encoded.replace('&x=2', ''), encoded.replace('docs%2Fpath', 'docs%252Fpath')]) {
    assert.equal(matchesBlockContent(linked(changed), linked(input)), false, changed);
  }
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-append-recovery-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const page = randomUUID(), anchor = randomUUID(), blockId = randomUUID(), childId = randomUUID(), tailId = randomUUID();
  const job = { id: randomUUID(), options: { destination: { workspaceId: randomUUID() } }, page: { id: page } };
  const blocks = [{ object: 'block', type: 'toggle', toggle: { rich_text: [{ type: 'text', text: { content: '补充核验' } }], children: [linked('https://example.com/manual?ref=docs/path&sig=keep')] } }];
  const { children, ...content } = blocks[0].toggle;
  const echoed = { id: blockId, type: 'toggle', toggle: content, parent: { page_id: page } };
  const nested = { ...linked('https://example.com/manual?ref=docs%2Fpath&sig=keep'), id: childId, parent: { block_id: blockId } };
  const actual = [ { id: anchor, parent: { page_id: page } }, structuredClone(echoed), { id: tailId, parent: { page_id: page } } ];
  const record = { workspace_id: job.options.destination.workspaceId, operation_scope: 'collection:' + job.id, name: 'append_blocks', status: 'uncertain', intended: { block_id: page, blocks, after: anchor }, request: { body: { children: blocks } }, response: { results: [echoed, actual[2]] }, result: { verified: false, created_block_ids: [blockId] } };
  fs.mkdirSync(path.join(root, 'write-journal'));
  const file = path.join(root, 'write-journal', 'content-' + 'a'.repeat(64) + '.json');
  const save = () => fs.writeFileSync(file, JSON.stringify(record)); save();
  const reads = [], connection = { session: { execute: async (name, args) => {
    assert.equal(name, 'read_block_children', 'recover from receipts without another append'); reads.push(args.block_id);
    return { results: args.block_id === page ? actual : [nested], next_cursor: null };
  } } };
  return { client: new CollectionNotion({ root }), job, blocks, anchor, blockId, nested, actual, record, file, save, connection, reads };
}
test('a late report recovers an uncertain append with existing sibling echoes and nested citations', async t => {
  const f = fixture(t);
  const result = await f.client.appendRecoverably(f.connection, f.job, f.blocks, f.anchor);
  assert.equal(result.verified, true); assert.deepEqual(result.created_block_ids, [f.blockId]);
  assert.ok(f.reads.includes(f.blockId));
  assert.equal(JSON.parse(fs.readFileSync(f.file)).status, 'verified');
  assert.deepEqual((await f.client.appendRecoverably(f.connection, f.job, f.blocks, f.anchor)).created_block_ids, [f.blockId]);
});
test('late report recovery refuses changed content, moved blocks and incomplete server receipts', async t => {
  for (const change of [
    f => { f.nested.bulleted_list_item.rich_text[0].text.link.url += '-changed'; },
    f => { f.actual.reverse(); },
    f => { f.blocks[0].toggle.rich_text[0].text.content = '另一份报告'; },
    f => { f.record.result.created_block_ids = [randomUUID()]; f.save(); },
    f => { delete f.record.result; f.record.response.results = f.record.response.results.slice(0, 1); f.save(); },
    f => { delete f.record.response; f.save(); }
  ]) {
    const f = fixture(t); change(f);
    await assert.rejects(f.client.appendRecoverably(f.connection, f.job, f.blocks, f.anchor), /回执|核验|不一致|不确定/);
  }
});
