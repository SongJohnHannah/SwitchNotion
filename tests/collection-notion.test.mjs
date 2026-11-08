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
test('new video pages start with video, put expandable instructions first and end with transcripts', () => {
  const doc = normalizeDocument({ url: 'https://example.com/v', nodes: [{ kind: 'paragraph', text: '原始简介' }, { kind: 'video', url: 'https://example.com/v.mp4' }] });
  const [intro, video] = doc.nodes;
  const extraction = { name: '内容理解', text: '## 操作步骤\n### 步骤 1｜创建项目\n' + '- 操作细节\n'.repeat(90) + '### 步骤 2｜导出\n- 检查\n## 口播脚本\n开场' };
  const plan = renderDocument(doc, doc.nodes, { [video.id]: { uploads: [{ id: randomUUID(), uploaded: true }] } },
    { [video.id]: { transcript: { text: '原始逐字稿' }, vision: { text: '原始字幕', ocrText: '原始字幕' } } }, [], extraction, 'result-first');
  assert.equal(plan.blocks[0].type, 'video');
  const toggles = plan.blocks.filter(block => block.type === 'toggle');
  assert.deepEqual(toggles.map(block => block.toggle.children.length), [79, 11, 1]);
  assert.match(toggles[0].toggle.rich_text[0].text.content, /步骤 1｜创建项目/);
  assert.ok(plan.blocks.indexOf(toggles.at(-1)) < plan.slots[intro.id].start);
  assert.equal(plan.blocks.at(-1).paragraph.rich_text[0].text.content, '原始逐字稿');
  assert.equal(plan.blocks.filter(block => block.paragraph?.rich_text[0]?.text.content === '原始字幕').length, 1);
  assert.ok(plan.blocks.some(block => block.heading_2?.rich_text[0]?.text.content === '关键帧文字'));
  assert.ok(batches(plan.blocks).every(group => group.reduce((total, block) => total + 1 + (block.toggle?.children.length || 0), 0) <= 80));
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
test('a late summary and vision result are inserted above the original transcript', async () => {
  const pageId = randomUUID(), order = [], inserted = [];
  const session = { execute: async (name, args) => {
    if (name === 'read_block_children') return { results: order, next_cursor: null };
    assert.equal(name, 'append_blocks');
    const blocks = args.blocks.map(block => ({ ...block, id: randomUUID() }));
    if (args.after) { inserted.push(args.after); assert.ok(order.some(block => block.id === args.after)); }
    order.splice(args.after ? order.findIndex(block => block.id === args.after) + 1 : order.length, 0, ...blocks);
    return { verified: true, created_block_ids: blocks.map(block => block.id) };
  } };
  const client = new CollectionNotion({ root: '/fixture' });
  client.connect = async () => ({ session }); client.createPage = async () => {};
  const doc = normalizeDocument({ url: 'https://example.com/v', nodes: [{ kind: 'paragraph', text: '原始简介' }, { kind: 'video', url: 'https://example.com/v.mp4' }] });
  const video = doc.nodes[1];
  const job = { id: randomUUID(), layout: 'result-first', document: doc, options: preferences(), page: { id: pageId },
    resources: { [video.id]: { uploads: [{ id: randomUUID(), uploaded: true }] } }, analyses: { [video.id]: { transcript: { text: '原始逐字稿' } } }, warnings: [] };
  await client.write(job, doc.nodes, () => {});
  job.analyses[video.id].vision = { text: '画面细节' };
  job.extraction = { name: '画面分析', text: '## 操作步骤\n### 步骤 1｜做片头\n检查节奏' };
  await client.write(job, doc.nodes, () => {});
  await client.write(job, doc.nodes, () => {});
  assert.equal(inserted.length, 2);
  assert.equal(order[0].type, 'video');
  assert.equal(order.filter(block => block.type === 'toggle').length, 1);
  const intro = order.findIndex(block => block.paragraph?.rich_text[0].text.content === '原始简介');
  assert.ok(order.findIndex(block => block.type === 'toggle') < intro);
  assert.equal(order.at(-1).paragraph.rich_text[0].text.content, '原始逐字稿');
});
