import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { CollectionService } = require('../src/collection/service.cjs');
const { normalizeDocument, preferences } = require('../src/collection/model.cjs');
const { renderDocument } = require('../src/collection/notion.cjs');
const parent = path.resolve(import.meta.dirname, '../.notion-switch');
function fixture(t, extra = {}) {
  fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'test-collection-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(parent)); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = [], saved = [];
  const document = normalizeDocument({ title: '一篇混合内容', url: 'https://example.com/article', nodes: [
    { kind: 'heading', text: '原文标题', level: 1 }, { kind: 'paragraph', text: '第一段' }, { kind: 'image', url: 'https://example.com/original.png' },
    { kind: 'paragraph', text: '中间的原文' }, { kind: 'video', url: 'https://example.com/video.mp4' }, { kind: 'audio', url: 'https://example.com/audio.mp3' }] });
  const notion = { verifyTarget: async () => ({ limit: 5 * 1024 ** 2 }),
    upload: async (_file, _job, state, save) => { calls.push('upload'); Object.assign(state, { id: randomUUID(), uploaded: true }); save(); },
    write: async (job, nodes, save) => { calls.push('write'); job.page ||= { id: randomUUID(), url: 'https://www.notion.so/test' }; saved.push(renderDocument(job.document, nodes, job.resources, job.analyses, job.warnings)); save(); return job.page; } };
  const media = { acquire: async (node, directory) => { calls.push('download:' + node.kind); fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'original.bin'); fs.writeFileSync(file, 'fixture'); return { path: file, kind: node.kind, duration: 1, audio: true }; },
    prepareUpload: async asset => [{ path: asset.path, kind: asset.kind }], transcript: async () => { calls.push('transcript'); return { text: '原始语音逐字稿' }; },
    vision: async () => { calls.push('vision'); return { text: '画面识别结果' }; }, ...extra.media };
  const service = new CollectionService({ root, binaries: { directory: root, status: () => ({}) }, browser: { inspect: async () => extra.document || document }, notion, media });
  const destination = { workspaceId: randomUUID(), id: randomUUID(), kind: 'page', label: '资料收集', workspaceName: '独立工作区' };
  service.settings = preferences({ destination }); t.after(() => service.close());
  return { root, service, calls, saved, document, destination };
}
async function idle(service) { for (let n = 0; n < 400; n++) { if (!service.running && !service.queue.length) return; await sleep(5); } throw Error('collection test did not settle'); }
test('choosing a destination after preview updates duplicate detection for later submissions', async t => {
  const f = fixture(t), result = await f.service.create({ input: 'https://example.com/article', preview: true, options: { destination: null } }); await idle(f.service);
  f.service.select(result.jobs[0].id, { ids: [f.document.nodes[1].id], options: { destination: f.destination } }); await idle(f.service);
  const again = await f.service.create({ input: 'https://example.com/article' });
  assert.equal(again.jobs[0].id, result.jobs[0].id); assert.equal(again.jobs[0].existing, true); assert.equal(f.calls.filter(call => call === 'write').length, 1);
});
test('complete mixed collection preserves original order, stores transcripts separately and snapshots per-task choices', async t => {
  const f = fixture(t);
  const result = await f.service.create({ input: 'https://example.com/article', options: { vision: false } }); await idle(f.service);
  const job = f.service.jobs.get(result.jobs[0].id); assert.equal(job.status, 'completed'); assert.equal(f.service.settings.vision, true);
  assert.equal(f.calls.includes('vision'), false); assert.equal(f.calls.filter(x => x === 'transcript').length, 2);
  assert.deepEqual(f.saved[0].blocks.slice(1, 7).map(b => b.type), ['heading_1', 'paragraph', 'image', 'paragraph', 'video', 'audio']);
  assert.ok(f.saved[0].blocks.findIndex(b => b.type === 'heading_1' && b.heading_1.rich_text[0]?.text.content === '逐字稿与识别结果') > 6);
  const again = await f.service.create({ input: 'https://example.com/article', options: { vision: false } }); assert.equal(again.jobs[0].existing, true); assert.equal(f.calls.filter(c => c === 'write').length, 1);
});
test('preview pauses before downloads and individual selection saves only selected resources in source order', async t => {
  const f = fixture(t), result = await f.service.create({ input: 'https://example.com/article', preview: true }); await idle(f.service);
  const id = result.jobs[0].id; assert.equal(f.service.jobs.get(id).status, 'awaiting_selection'); assert.deepEqual(f.calls, []);
  f.service.select(id, { ids: [f.document.nodes[4].id, f.document.nodes[1].id], options: { vision: false } }); await idle(f.service);
  assert.deepEqual(f.calls.filter(c => c.startsWith('download:')), ['download:video']);
  assert.deepEqual(f.saved[0].blocks.slice(1, 3).map(b => b.type), ['paragraph', 'video']);
});
test('incomplete authenticated content waits for login instead of claiming a completed archive', async t => {
  const document = normalizeDocument({ title: '受限内容', url: 'https://example.com/private', nodes: [{ kind: 'paragraph', text: '只显示开头' }], requiresLogin: true, incomplete: true });
  const f = fixture(t, { document }); await f.service.create({ input: document.url }); await idle(f.service);
  const job = [...f.service.jobs.values()][0]; assert.equal(job.status, 'needs_login'); assert.equal(f.calls.includes('write'), false);
  f.service.select(job.id, { ids: [document.nodes[0].id], allowPartial: true }); await idle(f.service);
  assert.equal(job.status, 'partial'); assert.equal(f.saved.length, 1);
});
test('vision failure retains originals and transcripts and can retry recognition without re-downloading', async t => {
  let fail = true;
  const f = fixture(t, { media: { vision: async () => { if (fail) throw Error('DeepSeek 余额不足。'); return { text: '已补全画面识别' }; } } });
  await f.service.create({ input: 'https://example.com/article' }); await idle(f.service);
  const job = [...f.service.jobs.values()][0], page = job.page.id; assert.equal(job.status, 'partial');
  const downloads = f.calls.filter(x => x.startsWith('download:')).length; fail = false; f.service.retry(job.id); await idle(f.service);
  assert.equal(job.status, 'completed'); assert.equal(job.page.id, page); assert.equal(f.calls.filter(x => x.startsWith('download:')).length, downloads);
});
test('cancel stops remaining stages, persisted interrupted work reloads and malformed requests expose no credentials', async t => {
  const f = fixture(t, { media: { acquire: async (_node, _directory, { signal }) => { await sleep(10000, null, { signal }); } } });
  const result = await f.service.create({ input: 'https://example.com/article' }); await sleep(30); f.service.cancel(result.jobs[0].id); await idle(f.service);
  assert.equal(f.service.jobs.get(result.jobs[0].id).status, 'cancelled'); assert.equal(f.calls.includes('write'), false);
  const response = await f.service.request('configure', { settings: { apiKey: 'secret_should_not_exist' } }); assert.equal(response.ok, false); assert.equal(JSON.stringify(response).includes('secret_should_not_exist'), false);
  const file = path.join(f.root, 'collection/jobs', result.jobs[0].id, 'job.json'), job = JSON.parse(fs.readFileSync(file)); job.status = 'uploading'; fs.writeFileSync(file, JSON.stringify(job));
  const restored = new CollectionService({ root: f.root, browser: {}, media: {}, notion: {}, binaries: { status: () => ({}) } });
  assert.equal(restored.jobs.get(job.id).status, 'interrupted'); restored.close();
});
