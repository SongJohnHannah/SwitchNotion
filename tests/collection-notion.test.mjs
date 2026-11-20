import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { CollectionNotion, renderDocument, batches, textBlocks } = require('../src/collection/notion.cjs');
const { normalizeDocument, preferences } = require('../src/collection/model.cjs');
const blockText = block => block?.[block.type]?.rich_text?.map(span => span.text.content).join('');

test('a target workspace reports its own API failure separately from a read-only connection', async () => {
  const workspaceId = randomUUID(), otherId = randomUUID(), target = { workspaceId, id: randomUUID(), kind: 'page' };
  const calls = [];
  let unavailable = [
    { workspace_id: otherId, error: 'Notion API 返回 HTTP 401。' },
    { workspace_id: workspaceId, error: 'Notion API 连接失败，请检查网络后重试。' }
  ];
  let workspaces = [];
  const notion = new CollectionNotion({ root: '/fixture', router: { prepare: async (_signal, id) => {
    calls.push(id); return { workspaces, unavailable };
  } } });
  await assert.rejects(notion.verifyTarget(target), /Notion API 连接失败/);
  await assert.rejects(notion.search(workspaceId), /Notion API 连接失败/);
  unavailable = [];
  workspaces = [{ id: workspaceId, cfg: { readOnly: true } }];
  await assert.rejects(notion.verifyTarget(target), /设为只读/);
  assert.deepEqual(calls, [workspaceId, workspaceId, workspaceId]);
});

async function sourceCorrectionFixture() {
  const store = new Map(), order = [], calls = []; let pages = 0, failTrash = 0;
  const session = { execute: async (name, args) => {
    calls.push(name);
    if (name === 'create_page') { pages++; return { page_id: randomUUID(), verified: true }; }
    if (name === 'read_page_info') return {};
    if (name === 'append_blocks') {
      const ids = args.blocks.map(block => { const id = randomUUID(); store.set(id, { ...structuredClone(block), id, parent: { page_id: args.block_id } }); return id; });
      order.splice(args.after ? order.indexOf(args.after) + 1 : order.length, 0, ...ids); return { verified: true, created_block_ids: ids };
    }
    if (name === 'read_block_children') return { results: order.map(id => store.get(id)).filter(block => !block.in_trash), next_cursor: null };
    if (name === 'read_block') return { block: structuredClone(store.get(args.block_id)), block_revision: 'fixture-revision' };
    if (name === 'trash_block') { if (failTrash && --failTrash === 0) throw Error('fixture interruption'); store.get(args.block_id).in_trash = true; return { verified: true }; }
    throw Error(name);
  } };
  const client = new CollectionNotion({ root: '/fixture' }); client.connect = async () => ({ session, target: { kind: 'page', id: randomUUID() } });
  const old = normalizeDocument({ url: 'https://www.douyin.com/note/123456', nodes: [{ kind: 'paragraph', text: '旧版误采集的推荐文字' }, { kind: 'video', url: 'https://www.douyin.com/note/123456' }] });
  const job = { id: randomUUID(), document: old, options: preferences(), resources: {}, analyses: {}, warnings: [] };
  await client.write(job, old.nodes, () => {});
  const oldIds = job.written.flat(), userId = randomUUID();
  store.set(userId, { id: userId, type: 'paragraph', paragraph: { rich_text: [{ text: { content: '用户自己的备注' } }] } }); order.push(userId);
  const updated = normalizeDocument({ sourceRevision: 'douyin-note-v1', url: old.url, nodes: [{ kind: 'paragraph', text: '更正后的图文正文' }, { kind: 'image', url: 'https://example.com/gallery.jpg' }] });
  job.document = updated; job.sourceRefresh = { version: 'douyin-note-v1', pending: true };
  job.resources = { [updated.nodes[1].id]: { uploads: [{ id: randomUUID(), uploaded: true }] } };
  return { client, job, store, order, calls, oldIds, userId, visible: () => order.map(id => store.get(id)).filter(block => !block.in_trash), pages: () => pages, interrupt: () => { failTrash = 2; } };
}

test('corrected source replaces only the original owned content on the same page and is idempotent', async () => {
  const f = await sourceCorrectionFixture();
  await f.client.write(f.job, f.job.document.nodes, () => {});
  assert.ok(f.oldIds.every(id => f.store.get(id).in_trash)); assert.equal(f.pages(), 1);
  assert.ok(f.visible().some(block => block.id === f.userId)); assert.equal(f.visible().filter(block => block.type === 'image').length, 1);
  assert.equal(f.job.sourceRefresh.pending, false); assert.equal(Object.keys(f.job.sourceSlots).length, 2);
  const appends = f.calls.filter(name => name === 'append_blocks').length;
  await f.client.write(f.job, f.job.document.nodes, () => {});
  assert.equal(f.calls.filter(name => name === 'append_blocks').length, appends);
});

test('source correction stops before writing when original owned content was manually edited', async () => {
  const f = await sourceCorrectionFixture(), changed = f.store.get(f.oldIds[0]);
  changed.paragraph.rich_text = [{ text: { content: '手动编辑的来源内容' } }];
  const appends = f.calls.filter(name => name === 'append_blocks').length;
  await assert.rejects(f.client.write(f.job, f.job.document.nodes, () => {}), /手动修改/);
  assert.ok(f.oldIds.every(id => !f.store.get(id).in_trash)); assert.equal(f.calls.filter(name => name === 'append_blocks').length, appends);
});

test('source correction resumes interrupted cleanup without appending another copy', async () => {
  const f = await sourceCorrectionFixture(); f.interrupt();
  await assert.rejects(f.client.write(f.job, f.job.document.nodes, () => {}), /fixture interruption/);
  const appends = f.calls.filter(name => name === 'append_blocks').length;
  await f.client.write(f.job, f.job.document.nodes, () => {});
  assert.equal(f.calls.filter(name => name === 'append_blocks').length, appends);
  assert.ok(f.oldIds.every(id => f.store.get(id).in_trash)); assert.ok(f.visible().some(block => block.id === f.userId));
});

test('source correction preserves manually reordered owned content before any new write', async () => {
  const f = await sourceCorrectionFixture(); [f.order[0], f.order[1]] = [f.order[1], f.order[0]];
  const appends = f.calls.filter(name => name === 'append_blocks').length;
  await assert.rejects(f.client.write(f.job, f.job.document.nodes, () => {}), /手动/);
  assert.ok(f.oldIds.every(id => !f.store.get(id).in_trash)); assert.equal(f.calls.filter(name => name === 'append_blocks').length, appends);
});

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

test('plain paragraphs normalize native CJK word breaks while code text remains byte-for-byte unchanged', () => {
  const value = '任\u200b\u200b何内容';
  const paragraph = textBlocks({ kind: 'paragraph', text: value })[0];
  const code = textBlocks({ kind: 'code', text: value })[0];
  assert.equal(paragraph.paragraph.rich_text.map(r => r.text.content).join(''), '任何内容');
  assert.equal(code.code.rich_text.map(r => r.text.content).join(''), value);
});

test('uncertain paragraph recovery accepts only CJK break normalization proven by the original receipt', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-word-break-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const id = randomUUID(), pageId = randomUUID(), blockId = randomUUID(), workspaceId = randomUUID();
  const expected = { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '任\u200b\u200b何内容' } }] } };
  const echoed = { id: blockId, type: 'paragraph', parent: { page_id: pageId }, paragraph: { rich_text: [{ type: 'text', text: { content: '任何内容' } }] } };
  let actual = structuredClone(echoed);
  const record = { workspace_id: workspaceId, operation_scope: 'collection:' + id + ':batch:0', name: 'append_blocks', status: 'uncertain', request: { body: { children: [expected] } }, response: { results: [echoed] } };
  fs.mkdirSync(path.join(root, 'write-journal'));
  const file = path.join(root, 'write-journal', 'content-' + 'b'.repeat(64) + '.json');
  const saveRecord = () => fs.writeFileSync(file, JSON.stringify(record)); saveRecord();
  const client = new CollectionNotion({ root }), job = { id, page: { id: pageId }, options: { destination: { workspaceId } } };
  const connection = { session: { execute: async name => { assert.equal(name, 'read_block_children', 'recovery must remain read-only'); return { results: [actual], next_cursor: null }; } } };
  assert.deepEqual(await client.recoverBatch(connection, job, 0, [expected]), [blockId]);
  actual.paragraph.rich_text[0].text.content = '任意内容';
  await assert.rejects(client.recoverBatch(connection, job, 0, [expected]), /不一致/);
  actual = structuredClone(echoed); record.response.results[0].paragraph.rich_text[0].text.content = '任\u200b\u200b何内容'; saveRecord();
  await assert.rejects(client.recoverBatch(connection, job, 0, [expected]), /不一致/);
});
test('a long extraction renews expired unattached media and repairs only a definitively rejected write plan', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-upload-expiry-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const oldId = randomUUID(), newId = randomUUID(), pageId = randomUUID(), workspaceId = randomUUID(), file = path.join(root, 'video.mp4');
  fs.writeFileSync(file, 'synthetic-video');
  const doc = normalizeDocument({ url: 'https://example.com/long-extraction', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const job = { id: randomUUID(), page: { id: pageId }, document: doc, options: preferences({ destination: { workspaceId, id: randomUUID(), kind: 'page' } }), resources: { [doc.nodes[0].id]: { parts: [{ path: file }], uploads: [{ id: oldId, uploaded: true }] } }, analyses: {}, warnings: [], written: [] };
  job.writeGroups = batches(renderDocument(doc, doc.nodes, job.resources).blocks);
  job.writeFingerprint = require('../src/collection/model.cjs').hash(JSON.stringify(job.writeGroups.flat()));
  const record = { workspace_id: workspaceId, operation_scope: 'collection:' + job.id + ':batch:0', name: 'append_blocks', status: 'uncertain', request: { body: { children: structuredClone(job.writeGroups[0]) } } };
  fs.mkdirSync(path.join(root, 'write-journal'));
  const journal = path.join(root, 'write-journal', 'content-' + 'b'.repeat(64) + '.json');
  fs.writeFileSync(journal, JSON.stringify(record));
  const requests = [], writes = [], actual = [];
  const notion = new CollectionNotion({ root, fetchImpl: async (url, options) => {
    requests.push(options.method + ' ' + url.split('/v1/')[1]);
    const value = options.method === 'POST' && url.endsWith('/file_uploads') ? { id: newId } : url.endsWith(oldId) ? { status: 'expired' } : { status: 'uploaded' };
    return { ok: true, json: async () => value };
  } });
  notion.createPage = async () => job.page;
  notion.connect = async () => ({ cfg: { key: 'fixture' }, session: { execute: async (name, args) => {
    if (name === 'append_blocks') { writes.push(structuredClone(args.blocks)); const ids = args.blocks.map(() => randomUUID()); actual.push(...ids.map(id => ({ id }))); return { verified: true, created_block_ids: ids }; }
    if (name === 'read_block_children') return { results: actual };
    throw Error(name);
  } } });
  await assert.rejects(notion.write(job, doc.nodes, () => {}), /此前正文写入结果不确定/);
  assert.equal(requests.length, 0); assert.equal(writes.length, 0, 'uncertain writes cannot be replaced');
  record.status = 'rejected'; record.error = { write_outcome: 'rejected', api_status: 400, api_code: 'validation_error' };
  fs.writeFileSync(journal, JSON.stringify(record));
  await assert.rejects(notion.write(job, doc.nodes, () => {
    const upload = job.resources[doc.nodes[0].id].uploads[0];
    if (upload.id === newId && upload.uploaded) throw Error('fixture interruption after upload');
  }), /fixture interruption after upload/);
  assert.equal(writes.length, 0);
  assert.equal(job.writeGroups.flat().find(block => block.type === 'video').video.file_upload.id, oldId);
  await notion.write(job, doc.nodes, () => {});
  assert.equal(writes.length, 1); assert.equal(writes[0].find(block => block.type === 'video').video.file_upload.id, newId);
  assert.equal(job.resources[doc.nodes[0].id].uploads[0].id, newId);
  assert.equal(requests.filter(call => call === 'POST file_uploads').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(journal)).status, 'rejected', 'retain the rejected receipt');
  assert.deepEqual(job.written.flat(), actual.map(block => block.id));
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
  const toggles = plan.blocks.filter(block => block.type === 'toggle' && /^步骤/.test(blockText(block)));
  assert.deepEqual(toggles.map(block => block.toggle.children.length), [79, 11, 1]);
  assert.match(toggles[0].toggle.rich_text[0].text.content, /步骤 1｜创建项目/);
  assert.ok(plan.blocks.indexOf(toggles.at(-1)) < plan.slots[intro.id].start);
  const transcript = plan.blocks.at(-1);
  assert.equal(transcript.type, 'toggle');
  assert.equal(blockText(transcript), '语音逐字稿');
  assert.equal(blockText(transcript.toggle.children.at(-1)), '原始逐字稿');
  const appendix = plan.blocks.find(block => block.toggle?.rich_text[0]?.text.content === '识别附录');
  assert.ok(appendix);
  assert.equal(plan.blocks.filter(block => block.paragraph?.rich_text[0]?.text.content === '原始字幕').length, 0);
  assert.equal(appendix.toggle.children.filter(block => block.paragraph?.rich_text[0]?.text.content === '原始字幕').length, 1);
  assert.ok(appendix.toggle.children.some(block => block.heading_2?.rich_text[0]?.text.content === '关键帧文字'));
  assert.ok(batches(plan.blocks).every(group => group.reduce((total, block) => total + 1 + (block.toggle?.children.length || 0), 0) <= 80));
});
test('original-order pages preserve every line and note in bounded transcript toggles', () => {
  const doc = normalizeDocument({ url: 'https://example.com/a', nodes: [{ kind: 'audio', url: 'https://example.com/a.wav' }] });
  const [audio] = doc.nodes;
  const text = '完整逐字稿\n'.repeat(65000), note = '语音资料备注';
  const plan = renderDocument(doc, doc.nodes, {}, { [audio.id]: { transcript: { text, note } } });
  const toggles = plan.blocks.filter(block => block.type === 'toggle');
  assert.ok(toggles.length > 1);
  assert.equal(blockText(toggles[0]), '语音逐字稿');
  assert.equal(toggles.flatMap(block => block.toggle.children).map(blockText).join(''), text + note);
  assert.ok(batches(plan.blocks).every(group => Buffer.byteLength(JSON.stringify(group)) <= 350000));
});
test('large recognition appendices stay inside bounded toggles without dropping recognition text', () => {
  const doc = normalizeDocument({ url: 'https://example.com/gallery', nodes: Array.from({ length: 45 }, (_, i) => ({ kind: 'image', url: `https://example.com/${i}.jpg` })) });
  const resources = {}, analyses = {};
  for (const [index, node] of doc.nodes.entries()) {
    resources[node.id] = { uploads: [{ id: randomUUID(), uploaded: true }] };
    analyses[node.id] = { ocr: { text: 'OCR-' + index }, vision: { text: 'VISION-' + index } };
  }
  const plan = renderDocument(doc, doc.nodes, resources, analyses, [], undefined, 'result-first');
  const appendices = plan.blocks.filter(block => block.toggle?.rich_text[0]?.text.content.startsWith('识别附录'));
  assert.ok(appendices.length > 1);
  assert.equal(plan.anchors.analysis, plan.blocks.indexOf(appendices[0]));
  const text = appendices.flatMap(block => block.toggle.children).filter(block => block.type === 'paragraph').map(block => block.paragraph.rich_text[0].text.content);
  assert.equal(text.length, 90);
  for (let i = 0; i < 45; i++) { assert.ok(text.includes('OCR-' + i)); assert.ok(text.includes('VISION-' + i)); }
  assert.ok(appendices.every(block => block.toggle.children.length <= 79));
  assert.ok(batches(plan.blocks).every(group => group.reduce((count, block) => count + 1 + (block.toggle?.children?.length || 0), 0) <= 80));
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
  assert.equal(order.filter(block => block.type === 'toggle').length, 4);
  const appendix = order.find(block => block.toggle?.rich_text[0]?.text.content === '识别附录（补全）');
  assert.ok(appendix.toggle.children.some(block => block.paragraph?.rich_text[0]?.text.content === '画面细节'));
  const intro = order.findIndex(block => block.paragraph?.rich_text[0].text.content === '原始简介');
  assert.ok(order.findIndex(block => block.type === 'toggle') < intro);
  assert.equal(blockText(order.at(-1)), '语音逐字稿');
  assert.equal(blockText(order.at(-1).toggle.children.at(-1)), '原始逐字稿');
});

test('a transcript completed after page creation is folded in either layout and is only appended once', async () => {
  for (const layout of [undefined, 'result-first']) {
    const pageId = randomUUID(), order = [];
    const session = { execute: async (name, args) => {
      if (name === 'read_block_children') return { results: order, next_cursor: null };
      assert.equal(name, 'append_blocks');
      const blocks = args.blocks.map(block => ({ ...block, id: randomUUID() }));
      order.push(...blocks);
      return { verified: true, created_block_ids: blocks.map(block => block.id) };
    } };
    const client = new CollectionNotion({ root: '/fixture' });
    client.connect = async () => ({ session }); client.createPage = async () => {};
    const doc = normalizeDocument({ url: 'https://example.com/a', nodes: [{ kind: 'audio', url: 'https://example.com/a.wav' }] });
    const [audio] = doc.nodes;
    const job = { id: randomUUID(), layout, document: doc, options: preferences(), page: { id: pageId },
      resources: { [audio.id]: { uploads: [{ id: randomUUID(), uploaded: true }] } }, analyses: {}, warnings: [] };
    await client.write(job, doc.nodes, () => {});
    job.analyses[audio.id] = { transcript: { text: '后来补齐的语音', note: '留存备注' } };
    await client.write(job, doc.nodes, () => {});
    await client.write(job, doc.nodes, () => {});
    const toggles = order.filter(block => block.type === 'toggle' && /^语音逐字稿/.test(blockText(block)));
    assert.equal(toggles.length, 1);
    assert.ok(toggles[0].toggle.children.map(blockText).includes('后来补齐的语音'));
    assert.ok(toggles[0].toggle.children.map(blockText).includes('留存备注'));
    assert.ok(!order.some(block => blockText(block) === '后来补齐的语音'));
  }
});
