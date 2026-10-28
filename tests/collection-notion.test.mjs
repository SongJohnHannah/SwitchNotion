import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { CollectionNotion, renderDocument, batches } = require('../src/collection/notion.cjs');
const { normalizeDocument, preferences } = require('../src/collection/model.cjs');

test('a creation interrupted before verification recovers the same independently matching page and never submits another create', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-recover-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const workspaceId = randomUUID(), sourceId = randomUUID(), pageId = randomUUID(), jobId = randomUUID();
  const expected = { 标题: { title: [{ text: { content: '原文' } }] }, 来源链接: { url: 'https://example.com/article' }, 收集时间: { date: { start: '2026-10-27T18:18:56.075Z' } } };
  const page = { id: pageId, parent: { data_source_id: sourceId }, properties: structuredClone(expected) };
  page.properties.收集时间.date = { start: '2026-10-28T02:18:00+08:00', end: null, time_zone: null };
  fs.mkdirSync(path.join(root, 'write-journal'));
  fs.writeFileSync(path.join(root, 'write-journal', 'content-' + 'a'.repeat(64) + '.json'), JSON.stringify({ workspace_id: workspaceId, operation_scope: 'collection:' + jobId, name: 'create_database_entry', status: 'uncertain', response: { id: pageId }, request: { body: { parent: { data_source_id: sourceId }, properties: expected } } }));
  let reads = 0;
  const notion = new CollectionNotion({ root });
  notion.connect = async () => ({ target: { workspaceId }, cfg: {}, client: { request: async (cfg, method, endpoint) => { assert.equal(method, 'GET'); assert.equal(endpoint, 'pages/' + pageId); reads++; return page; } }, session: { execute: () => { throw Error('must not create again'); } } });
  const job = { id: jobId, options: { destination: {} } };
  await notion.createPage(job, () => {}, new AbortController().signal);
  assert.equal(job.page.id, pageId); assert.equal(job.creationRecovered, true); assert.equal(reads, 1);
  delete job.page; page.properties.来源链接.url = 'https://example.com/different';
  await assert.rejects(notion.createPage(job, () => {}, new AbortController().signal), /不一致/);
  assert.equal(job.page, undefined);
});
test('long article blocks retain hyperlinks and full text while each API batch stays bounded', () => {
  const text = '原文'.repeat(160000), doc = normalizeDocument({ url: 'https://example.com/a', nodes: [{ kind: 'paragraph', text: 'short' }] });
  doc.nodes[0].text = text; doc.nodes[0].spans = [{ text, href: 'https://example.com/source' }];
  const result = renderDocument(doc, doc.nodes, {}), groups = batches(result.blocks);
  assert.equal(result.blocks.slice(1).flatMap(b => b.paragraph.rich_text).map(s => s.text.content).join(''), text);
  assert.ok(groups.every(g => g.length <= 80 && Buffer.byteLength(JSON.stringify(g)) < 350000));
  assert.ok(result.blocks.slice(1).every(b => b.paragraph.rich_text.every(s => s.text.link.url === 'https://example.com/source')));
});
test('incomplete upload stays a placeholder and never attaches a pending upload', () => {
  const doc = normalizeDocument({ url: 'https://example.com/a', nodes: [{ kind: 'image', url: 'https://example.com/image.jpg' }] });
  const rendered = renderDocument(doc, doc.nodes, { [doc.nodes[0].id]: { uploads: [{ id: randomUUID(), uploaded: false }] } });
  assert.deepEqual(rendered.blocks.map(b => b.type), ['paragraph', 'paragraph']); assert.equal(rendered.slots[doc.nodes[0].id].placeholder, true);
});
test('retry fills original media positions, keeps manual edits elsewhere and does not duplicate a page or attachment', async () => {
  const store = new Map(), order = [], calls = []; let pages = 0;
  const session = { execute: async (name, args) => {
    calls.push(name);
    if (name === 'create_page') return { page_id: randomUUID(), url: 'https://www.notion.so/test', verified: true, ...(pages++, {}) };
    if (name === 'read_page_info') return {};
    if (name === 'append_blocks') {
      const ids = args.blocks.map(input => { const id = randomUUID(); store.set(id, { ...structuredClone(input), id, parent: { page_id: args.block_id } }); return id; });
      order.splice(args.after ? order.indexOf(args.after) + 1 : order.length, 0, ...ids); return { verified: true, created_block_ids: ids };
    }
    if (name === 'read_block_children') return { results: order.map(id => store.get(id)).filter(b => !b.in_trash), next_cursor: null };
    if (name === 'read_block') return { block: structuredClone(store.get(args.block_id)), block_revision: 'fixture-revision' };
    if (name === 'trash_block') { store.get(args.block_id).in_trash = true; return { verified: true }; }
    throw Error(name);
  } };
  const client = new CollectionNotion({ root: '/fixture' }); client.connect = async () => ({ session, target: { kind: 'page', id: randomUUID() } });
  const doc = normalizeDocument({ title: '原文', url: 'https://example.com/a', nodes: [{ kind: 'paragraph', text: 'before' }, { kind: 'image', url: 'https://example.com/image.jpg' }, { kind: 'paragraph', text: 'after' }] });
  const job = { id: randomUUID(), document: doc, options: preferences(), resources: {}, analyses: {}, warnings: [] };
  await client.write(job, doc.nodes, () => {});
  const userId = randomUUID(); store.set(userId, { id: userId, type: 'paragraph', paragraph: { rich_text: [{ text: { content: '用户手动写的内容' } }] } }); order.push(userId);
  job.resources[doc.nodes[1].id] = { uploads: [{ id: randomUUID(), uploaded: true }] };
  await client.write(job, doc.nodes, () => {}); await client.write(job, doc.nodes, () => {});
  const visible = order.map(id => store.get(id)).filter(b => !b.in_trash);
  assert.equal(pages, 1); assert.deepEqual(visible.slice(0, 4).map(b => b.type), ['paragraph', 'paragraph', 'image', 'paragraph']);
  assert.equal(visible.filter(b => b.type === 'image').length, 1); assert.equal(visible.at(-1).id, userId);
  job.resources[doc.nodes[1].id].uploads = [{ id: randomUUID(), uploaded: true }];
  await client.write(job, doc.nodes, () => {}); await client.write(job, doc.nodes, () => {});
  const repaired = order.map(id => store.get(id)).filter(b => !b.in_trash);
  assert.equal(repaired.filter(b => b.type === 'image').length, 1); assert.equal(repaired.at(-1).id, userId); assert.equal(pages, 1);
  const image = repaired.find(b => b.type === 'image'); image.image.caption = [{ type: 'text', text: { content: '手动备注' } }];
  job.resources[doc.nodes[1].id].uploads = [{ id: randomUUID(), uploaded: true }];
  await assert.rejects(client.write(job, doc.nodes, () => {}), /手动修改/); assert.equal(image.in_trash, undefined);
});
