import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { CollectionService } = require('../src/collection/service.cjs');
const { CollectionMedia } = require('../src/collection/media.cjs');
const { normalizeDocument, preferences } = require('../src/collection/model.cjs');
const { renderDocument } = require('../src/collection/notion.cjs');
const { transcribeGpuFile } = require('../src/speech/windows-operator/module/src/speech/gpu-file.cjs');
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
    write: async (job, nodes, save) => { calls.push('write'); job.page ||= { id: randomUUID(), url: 'https://www.notion.so/test' }; saved.push(renderDocument(job.document, nodes, job.resources, job.analyses, job.warnings, job.extraction)); save(); return job.page; } };
  const media = { acquire: async (node, directory) => { calls.push('download:' + node.kind); fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'original.bin'); fs.writeFileSync(file, 'fixture'); return { path: file, kind: node.kind, duration: 1, audio: true }; },
    prepareUpload: async asset => [{ path: asset.path, kind: asset.kind }], transcript: async () => { calls.push('transcript'); return { text: '原始语音逐字稿' }; },
    vision: async () => { calls.push('vision'); return { text: '画面识别结果' }; }, ...extra.media };
  const service = new CollectionService({ root, downloadsDirectory: path.join(root, 'Downloads'), binaries: { directory: root, status: () => ({}) }, browser: { inspect: async () => extra.document || document }, notion, media, provider: extra.provider, extraction: extra.extraction });
  const destination = { workspaceId: randomUUID(), id: randomUUID(), kind: 'page', label: '资料收集', workspaceName: '独立工作区' };
  service.settings = preferences({ destination, keepLocal: false, keepHistory: true, extraction: { mode: 'off' } }); t.after(() => service.close());
  return { root, service, calls, saved, document, destination };
}
async function idle(service) { for (let n = 0; n < 400; n++) { if (!service.running && !service.queue.length) return; await sleep(5); } throw Error('collection test did not settle'); }

test('failed video download defers summary despite a page title and recovers on the same page', async t => {
  let fail = true, summaries = 0;
  const document = normalizeDocument({ title: 'Jensen Huang interview', url: 'https://www.youtube.com/watch?v=fixture', nodes: [
    { kind: 'heading', text: 'Jensen Huang interview', level: 1 }, { kind: 'video', url: 'https://www.youtube.com/watch?v=fixture' }] });
  const f = fixture(t, { document, media: { acquire: async (node, directory) => {
    if (fail) throw Error('下载失败：HTTP 502');
    fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'original.mp4'); fs.writeFileSync(file, 'video'); return { path: file, kind: node.kind, audio: true, duration: 1 };
  } }, extraction: { run: async job => { summaries++; assert.equal(job.analyses[document.nodes[1].id].transcript.text, '原始语音逐字稿'); return { name: '访谈', text: '有逐字稿依据的总结' }; } } });
  f.service.settings = preferences({ extraction: { mode: 'auto' }, vision: false }, f.service.settings);
  await f.service.create({ input: document.url }); await idle(f.service);
  const job = [...f.service.jobs.values()][0];
  assert.equal(summaries, 0, 'a failed download must not call the summarizer with just the title');
  assert.equal(job.status, 'partial'); assert.equal(job.extraction.deferred, true);
  assert.doesNotMatch(job.message, /登录/); assert.match(job.message, /下载/);
  const page = job.page.id; fail = false; f.service.retry(job.id); await idle(f.service);
  assert.equal(job.status, 'completed'); assert.equal(summaries, 1); assert.equal(job.page.id, page);
});

test('failed transcription defers summary even if video frames and webpage text are available', async t => {
  let fail = true, summaries = 0;
  const f = fixture(t, { media: { transcript: async () => { if (fail) throw Error('本地转写进程中断'); return { text: '完整逐字稿' }; } },
    extraction: { run: async () => { summaries++; return { text: '完整总结', name: '访谈' }; } } });
  f.service.settings = preferences({ extraction: { mode: 'auto' } }, f.service.settings);
  await f.service.create({ input: 'https://example.com/article' }); await idle(f.service);
  const job = [...f.service.jobs.values()][0]; assert.equal(summaries, 0); assert.equal(job.extraction.stage, 'transcript');
  const downloads = f.calls.filter(call => call.startsWith('download:')).length;
  fail = false; f.service.retry(job.id); await idle(f.service);
  assert.equal(job.status, 'completed'); assert.equal(summaries, 1);
  assert.equal(f.calls.filter(call => call.startsWith('download:')).length, downloads);
});

test('a music-only video completes collection and uses the frames for its summary', async t => {
  const document = normalizeDocument({ title: '纯音乐视频', url: 'https://example.com/music',
    nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const node = document.nodes[0];
  const f = fixture(t, { document, extraction: { run: async job => {
    const { transcript, vision } = job.analyses[node.id];
    assert.equal(transcript.text, '');
    assert.equal(transcript.note, '未识别到清晰语音。');
    assert.equal(transcript.operator.complete, true);
    assert.equal(vision.text, '画面识别结果');
    return { text: '基于画面的总结' };
  } } });
  const media = new CollectionMedia({ operator: { transcribeFile: ({ source, language, signal }) => transcribeGpuFile({
    source, language, signal, root: f.root, outputDirectory: path.join(f.root, 'transcription'),
    ffmpeg: process.execPath, runtime: { model: 'large-v3-turbo', pythonExecutable: process.execPath, modelDirectory: f.root },
    executeImpl: async (_file, args) => fs.writeFileSync(args.at(-1), Buffer.alloc(16000 * 2)),
    providerFactory: () => ({ status: () => ({ device: 'cuda' }), retain() {}, probe: async () => {}, close() {},
      request: async (_kind, _fields, _signal, record) => {
        const result = { text: '', segments: [] };
        record(result);
        return result;
      } })
  }) } });
  f.service.media.transcript = media.transcript.bind(media);
  await f.service.create({ input: document.url, options: { extraction: { mode: 'auto' } } });
  await idle(f.service);
  const job = [...f.service.jobs.values()][0];
  assert.equal(job.status, 'completed', job.warnings.join('\n'));
  assert.equal(job.extraction.text, '基于画面的总结');
});

test('upgrading a legacy successful transcript preserves its history but a new operator failure pauses summary', async t => {
  let summaries = 0;
  const document = normalizeDocument({ title: 'Legacy video', url: 'https://example.com/legacy-video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const f = fixture(t, { document, media: { vision: async () => { throw Error('画面未完成'); } }, extraction: { run: async () => { summaries++; return { text: 'summary', name: '访谈' }; } } });
  await f.service.create({ input: document.url }); await idle(f.service);
  const job = [...f.service.jobs.values()][0], analysis = job.analyses[document.nodes[0].id];
  assert.equal(analysis.transcript.text, '原始语音逐字稿'); assert.equal(job.status, 'partial');
  f.service.media.operator = {}; f.service.media.transcript = async () => { throw Error('独立 GPU 转写未完成'); };
  f.service.media.vision = async () => ({ text: 'frames' }); job.options.extraction.mode = 'auto';
  f.service.retry(job.id); await idle(f.service);
  assert.equal(summaries, 0); assert.equal(analysis.transcript, undefined);
  assert.equal(analysis.transcriptHistory[0].result.text, '原始语音逐字稿'); assert.equal(job.extraction.stage, 'transcript');
});

test('restoring an old failed video task suppresses its metadata-only summary classification', async t => {
  const f = fixture(t, { media: { acquire: async () => { throw Error('媒体下载未完成，请在收集浏览器中登录并确认原始内容可播放。'); } } });
  await f.service.create({ input: 'https://example.com/article' }); await idle(f.service);
  const job = [...f.service.jobs.values()][0]; job.options.extraction.mode = 'auto';
  job.extraction = { name: '通用总结', text: '没有实际内容的旧总结' }; job.classification = { type: '通用', title: '资料内容概览' }; f.service.save(job);
  const restored = new CollectionService({ root: f.root, binaries: { status: () => ({}) }, browser: {}, media: {}, notion: {} }); t.after(() => restored.close());
  const recovered = restored.jobs.get(job.id); assert.equal(recovered.extraction.deferred, true); assert.equal(recovered.extraction.text, undefined);
  assert.equal(recovered.classification, undefined); assert.doesNotMatch(recovered.message, /登录/);
  assert.ok(recovered.warnings.every(warning => !warning.includes('登录')));
});

test('account checks are passive by default, require an explicit boolean for live verification, and leave the queue alone', async t => {
  const f = fixture(t), checks = [];
  f.service.browser.accounts = async (_signal, options) => { checks.push(options.verify); return [{ id: 'bilibili', state: options.verify ? 'valid' : 'deferred' }]; };
  assert.equal((await f.service.request('accounts')).result[0].state, 'deferred');
  assert.equal((await f.service.request('accounts', { verify: true })).result[0].state, 'valid');
  assert.equal((await f.service.request('accounts', { verify: 'true' })).ok, false);
  assert.deepEqual(checks, [false, true]); assert.equal(f.service.queue.length, 0);
});

test('deleting a failed task removes its files and journals, preserves other tasks and original sources, and survives restart', async t => {
  const f = fixture(t); f.service.notion.verifyTarget = async () => { throw Error('Notion 暂时离线'); };
  const source = path.join(f.root, '用户原始视频.mp4'); fs.writeFileSync(source, 'original');
  const result = await f.service.create({ input: source }); await idle(f.service); const id = result.jobs[0].id, job = f.service.jobs.get(id);
  assert.equal(job.status,'failed');
  const working = path.join(f.service.location(job),'working','media');fs.mkdirSync(working,{recursive:true});fs.writeFileSync(path.join(working,'partial.mp4.part'),'unfinished');fs.writeFileSync(path.join(working,'transcript.json'),'checkpoint');
  job.resources = { malicious: { asset: { path: source } } };f.service.save(job);
  const journal = path.join(f.root,'write-journal');fs.mkdirSync(journal);
  const own = path.join(journal,'content-'+ 'a'.repeat(64)+'.json'), other = path.join(journal,'content-'+ 'b'.repeat(64)+'.json');
  fs.writeFileSync(own,JSON.stringify({operation_scope:'collection:'+id+':batch:0'}));fs.writeFileSync(other,JSON.stringify({operation_scope:'another-feature'}));
  assert.equal(f.service.status().jobs.find(j=>j.id===id).canDelete,true);
  const deleted = await f.service.request('delete-task',{id});assert.equal(deleted.ok,true);
  assert.equal(f.service.jobs.has(id),false);assert.equal(fs.existsSync(f.service.location(job)),false);assert.equal(fs.existsSync(own),false);assert.equal(fs.existsSync(other),true);assert.equal(fs.readFileSync(source,'utf8'),'original');
  const restored = new CollectionService({root:f.root,binaries:{status:()=>({})},browser:{},media:{},notion:{}});t.after(()=>restored.close());assert.equal(restored.jobs.has(id),false);
});

test('an active task cannot be deleted, and deleting a partial archive preserves its Notion page', async t => {
  const f=fixture(t), result=await f.service.create({input:'https://example.com/article',preview:true});await idle(f.service);
  const id=result.jobs[0].id,job=f.service.jobs.get(id);job.status='downloading';f.service.save(job);
  assert.equal((await f.service.request('delete-task',{id})).ok,false);assert.equal(fs.existsSync(f.service.location(job)),true);
  job.status='partial';job.page={id:randomUUID(),url:'https://www.notion.so/saved'};f.service.save(job);
  const deleted=await f.service.request('delete-task',{id});assert.equal(deleted.ok,true);assert.equal(deleted.result.pageRetained,true);assert.equal(f.calls.includes('write'),false);
});

test('the default local copy uses the native Downloads directory independently of completed task history', async t => {
  const f=fixture(t);f.service.settings=preferences({keepLocal:true,keepHistory:false},f.service.settings);
  const result=await f.service.create({input:'https://example.com/article'});await idle(f.service);
  const job=f.service.jobs.get(result.jobs[0].id), base=path.join(f.root,'Downloads','NotionSwitch');
  assert.equal(f.service.status().defaultDownloadDirectory,base);assert.equal(job.status,'completed');
  const folders=fs.readdirSync(base);assert.equal(folders.length,1);assert.equal(fs.existsSync(path.join(base,folders[0],'content.json')),true);
  assert.equal(folders[0],'一篇混合内容');assert.equal(fs.existsSync(path.join(base,folders[0],'原文.md')),true);
  assert.equal(fs.existsSync(path.join(f.root,'collection/jobs',job.id)),false);assert.equal(preferences().keepLocal,false);
});

test('same-title downloads stay in separate visible folders and deleting a partial task removes only its own folder', async t => {
  const f=fixture(t,{media:{vision:async()=>{throw Error('图片识别暂时失败');}}});f.service.settings=preferences({keepLocal:true},f.service.settings);
  const result=await f.service.create({input:'https://example.com/one\nhttps://example.com/two'});await idle(f.service);
  const [a,b]=result.jobs.map(j=>f.service.jobs.get(j.id));assert.equal(a.status,'partial');assert.equal(b.status,'partial');
  assert.equal(path.basename(a.exportDirectory),'一篇混合内容');assert.equal(path.basename(b.exportDirectory),'一篇混合内容 (2)');
  assert.ok(Object.values(a.resources).every(r=>r.asset.path.startsWith(a.exportDirectory+path.sep)));
  assert.equal(fs.existsSync(path.join(a.exportDirectory,'逐字稿.md')),true);assert.equal(fs.existsSync(path.join(a.exportDirectory,'原文.md')),true);
  const deleted=await f.service.request('delete-task',{id:a.id});assert.equal(deleted.ok,true);assert.equal(deleted.result.pageRetained,true);
  assert.equal(fs.existsSync(a.exportDirectory),false);assert.equal(fs.existsSync(b.exportDirectory),true);assert.equal(f.service.jobs.has(b.id),true);
});

test('a changed download ownership marker prevents deleting user files or task recovery data', async t => {
  const f=fixture(t,{media:{vision:async()=>{throw Error('识别暂时失败');}}});f.service.settings=preferences({keepLocal:true},f.service.settings);
  const result=await f.service.create({input:'https://example.com/article'});await idle(f.service);const job=f.service.jobs.get(result.jobs[0].id);
  const marker=path.join(job.exportDirectory,'.switch-notion-task.json');fs.writeFileSync(marker,JSON.stringify({version:1,taskId:randomUUID()}));
  const deleted=await f.service.request('delete-task',{id:job.id});assert.equal(deleted.ok,false);assert.equal(fs.existsSync(job.exportDirectory),true);assert.equal(fs.existsSync(f.service.location(job)),true);
});

test('a busy download folder keeps the failed task and recovery journal available for another delete attempt', async t => {
  const f=fixture(t,{media:{vision:async()=>{throw Error('识别暂时失败');}}});f.service.settings=preferences({keepLocal:true},f.service.settings);
  const result=await f.service.create({input:'https://example.com/article'});await idle(f.service);const job=f.service.jobs.get(result.jobs[0].id);
  const journal=path.join(f.root,'write-journal');fs.mkdirSync(journal);const record=path.join(journal,'content-'+ 'c'.repeat(64)+'.json');fs.writeFileSync(record,JSON.stringify({operation_scope:'collection:'+job.id+':batch:0'}));
  const remove=fs.rmSync;
  try { fs.rmSync=(target,options)=>{if(target===job.exportDirectory)throw Error('下载目录正在使用，请稍后删除。');return remove(target,options);};assert.equal((await f.service.request('delete-task',{id:job.id})).ok,false); }
  finally { fs.rmSync=remove; }
  assert.equal(f.service.jobs.has(job.id),true);assert.equal(fs.existsSync(f.service.location(job)),true);assert.equal(fs.existsSync(record),true);
  assert.equal((await f.service.request('delete-task',{id:job.id})).ok,true);assert.equal(fs.existsSync(job.exportDirectory),false);
});
test('saved extraction preference persists offline and keeps the destination', async t => {
  const f = fixture(t); f.service.notion.verifyTarget = async () => { throw Error('Notion 离线'); };
  await f.service.configure({ extraction: { mode: 'auto', preference: '重点总结主播的口播风格' } });
  const restored = new CollectionService({ root: f.root, binaries: { status: () => ({}) }, browser: {}, media: {}, notion: {} });
  assert.equal(restored.settings.extraction.preference, '重点总结主播的口播风格'); assert.equal(restored.settings.extraction.mode, 'auto');
  assert.deepEqual(restored.settings.destination, f.destination); restored.close();
});
test('successful no-history collection clears only its own records and keeps a session-only Notion receipt', async t => {
  const f = fixture(t); f.service.settings = preferences({ keepHistory: false }, f.service.settings);
  const result = await f.service.create({ input: 'https://example.com/article', preview: true }); await idle(f.service);
  const id = result.jobs[0].id, journal = path.join(f.root, 'write-journal'); fs.mkdirSync(journal);
  const own = path.join(journal, 'content-' + 'a'.repeat(64) + '.json'), other = path.join(journal, 'content-' + 'b'.repeat(64) + '.json');
  fs.writeFileSync(own, JSON.stringify({ operation_scope: 'collection:' + id + ':batch:0' })); fs.writeFileSync(other, JSON.stringify({ operation_scope: 'another-feature' }));
  assert.equal(fs.existsSync(path.join(f.root, 'collection/jobs', id, 'job.json')), true);
  f.service.select(id, { ids: [f.document.nodes[1].id] }); await idle(f.service);
  assert.equal(fs.existsSync(path.join(f.root, 'collection/jobs', id)), false); assert.equal(fs.existsSync(own), false); assert.equal(fs.existsSync(other), true);
  assert.equal(f.service.status().jobs.length, 0); assert.ok(f.service.status().latestCompletion.page.id);
  assert.equal(f.service.jobs.get(id).historyCleared, true);
  const duplicate = await f.service.create({ input: 'https://example.com/article' });
  assert.equal(duplicate.jobs[0].status, 'completed'); assert.equal(duplicate.jobs[0].page.id, f.service.status().latestCompletion.page.id);
  assert.equal(fs.existsSync(path.join(f.root, 'collection/jobs', id)), false);
  const restored = new CollectionService({ root: f.root, binaries: { status: () => ({}) }, browser: {}, media: {}, notion: {} });
  assert.equal(restored.jobs.size, 0); restored.close();
});
test('rereading local media before selection retains the local source and detects replacement', async t => {
  const f = fixture(t), file = path.join(f.root, '原始 视频.mp4'); fs.writeFileSync(file, 'user-owned video');
  const result = await f.service.create({ input: file, preview: true }); await idle(f.service); const id = result.jobs[0].id;
  assert.equal(f.service.jobs.get(id).status, 'awaiting_selection');
  f.service.browser.inspect = async () => { throw Error('local files must never use the browser'); };
  f.service.reread(id); await idle(f.service);
  const job = f.service.jobs.get(id); assert.equal(job.status, 'awaiting_selection'); assert.equal(job.document.sourceKind, 'local');
  fs.writeFileSync(file, 'replacement content'); assert.throws(() => f.service.reread(id), /改变/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement content');
});
test('local paths use the same input queue and extraction retries preserve the original upload', async t => {
  let fail = true, reads = 0;
  const f = fixture(t, { extraction: { run: async job => { if (fail) throw Error('DeepSeek 暂时失败。'); return { text: '## 操作步骤\n- 第一步', name: '音视频提取' }; } }, media: {
    importLocal: async (source, directory) => { reads++; fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'original.wav'); fs.copyFileSync(source.path, file); return { path: file, kind: source.kind, duration: 1, audio: true }; }
  } });
  f.service.settings = preferences({ keepHistory: false, extraction: { mode: 'auto' }, vision: false }, f.service.settings);
  const file = path.join(f.root, '原始 音频.wav'); fs.writeFileSync(file, 'user-owned media');
  const result = await f.service.create({ input: '"' + file + '"' }); await idle(f.service); const id = result.jobs[0].id;
  let job = f.service.jobs.get(id); assert.equal(job.status, 'partial'); assert.equal(fs.existsSync(path.join(f.root, 'collection/jobs', id, 'job.json')), true); const page = job.page.id;
  fail = false; f.service.retry(id); await idle(f.service); job = f.service.jobs.get(id);
  assert.equal(job.status, 'completed'); assert.equal(reads, 1); assert.equal(job.page.id, page);
  assert.equal(fs.readFileSync(file, 'utf8'), 'user-owned media'); assert.equal(fs.existsSync(path.join(f.root, 'collection/jobs', id)), false);
  const blocks = f.saved.at(-1).blocks; assert.ok(blocks.findIndex(b => b.type === 'audio') < blocks.findIndex(b => b.heading_1?.rich_text[0]?.text.content.startsWith('AI 提取结果')));
});
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
  assert.deepEqual(f.document.nodes.map(node => f.saved[0].blocks[f.saved[0].slots[node.id].start].type), ['heading_1', 'paragraph', 'image', 'paragraph', 'video', 'audio']);
  assert.ok(f.saved[0].blocks.findIndex(b => b.type === 'heading_1' && b.heading_1.rich_text[0]?.text.content === '逐字稿与识别结果') > 6);
  const again = await f.service.create({ input: 'https://example.com/article', options: { vision: false } }); assert.equal(again.jobs[0].existing, true); assert.equal(f.calls.filter(c => c === 'write').length, 1);
});
test('preview pauses before downloads and individual selection saves only selected resources in source order', async t => {
  const f = fixture(t), result = await f.service.create({ input: 'https://example.com/article', preview: true }); await idle(f.service);
  const id = result.jobs[0].id; assert.equal(f.service.jobs.get(id).status, 'awaiting_selection'); assert.deepEqual(f.calls, []);
  f.service.select(id, { ids: [f.document.nodes[4].id, f.document.nodes[1].id], options: { vision: false } }); await idle(f.service);
  assert.deepEqual(f.calls.filter(c => c.startsWith('download:')), ['download:video']);
  assert.deepEqual([f.document.nodes[1], f.document.nodes[4]].map(node => f.saved[0].blocks[f.saved[0].slots[node.id].start].type), ['paragraph', 'video']);
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
test('the shared OCR session closes once the collection queue drains', async t => {
  let closed = 0, unloaded = 0;
  const f = fixture(t, { media: { closeOcrSession: async () => { closed++; }, unloadLocalModel: async () => { unloaded++; } } });
  await f.service.create({ input: 'https://example.com/article' }); await idle(f.service);
  assert.equal(closed, 1); assert.equal(unloaded, 1);
});
test('local Qwen engine only analyzes video keyframes and labels the appendix accordingly', async t => {
  const seen = [];
  const f = fixture(t, { media: { vision: async (asset, options) => { seen.push({ kind: asset.kind, engine: options.engine }); return { text: '本地识别', engine: 'local' }; } } });
  await f.service.create({ input: 'https://example.com/article', options: { visionEngine: 'local' } }); await idle(f.service);
  assert.deepEqual(seen, [{ kind: 'video', engine: 'local' }]);
  assert.match(JSON.stringify(f.saved[0]), /本地千问画面分析/);
});
test('downloads pipeline so the next resource downloads while the first is analyzed', async t => {
  const document = normalizeDocument({ title: '多视频', url: 'https://example.com/multi', nodes: [
    { kind: 'video', url: 'https://example.com/one.mp4' }, { kind: 'video', url: 'https://example.com/two.mp4' }] });
  const events = []; let activeDownloads = 0, maxDownloads = 0;
  const f = fixture(t, { document, media: {
    acquire: async (node, directory) => { activeDownloads++; maxDownloads = Math.max(maxDownloads, activeDownloads); events.push('download:start:' + node.url); fs.mkdirSync(directory, { recursive: true }); await sleep(40); activeDownloads--; events.push('download:end:' + node.url); return { path: path.join(directory, 'asset.bin'), kind: node.kind, duration: 1, audio: true, marker: node.url }; },
    transcript: async () => ({ text: '' }),
    vision: async (asset, options) => { events.push('vision:start:' + asset.marker); await sleep(80); events.push('vision:end:' + asset.marker); return { text: '本地画面', engine: options.engine }; },
    prepareUpload: async asset => [{ path: asset.path, kind: asset.kind }]
  } });
  await f.service.create({ input: 'https://example.com/multi', options: { transcribe: false, visionEngine: 'local' } }); await idle(f.service);
  assert.equal(maxDownloads, 1);
  assert.ok(events.indexOf('download:end:https://example.com/one.mp4') < events.indexOf('download:start:https://example.com/two.mp4'));
  assert.ok(events.indexOf('vision:start:https://example.com/one.mp4') < events.indexOf('download:end:https://example.com/two.mp4'));
  assert.equal(events.filter(event => event.startsWith('vision:end:')).length, 2);
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

test('OCR runs for videos even when visual description is disabled', async t => {
  const seen = [];
  const f = fixture(t, { media: {
    ocr: async () => { seen.push('ocr'); return { text: '【关键帧文字】\n视频时间 0.0 秒：屏幕字', note: '基于 1 张关键帧', engine: 'mediaocr', frames: [{ frame: path.join(t.name, 'frame.jpg'), time: 0 }] }; },
    vision: async () => { seen.push('vision'); return { text: '画面描述' }; } } });
  await f.service.create({ input: 'https://example.com/article', options: { vision: false, transcribe: false } }); await idle(f.service);
  const video = f.document.nodes.find(node => node.kind === 'video');
  const job = [...f.service.jobs.values()].find(item => item.status === 'completed');
  assert.deepEqual(seen, ['ocr']); assert.match(job.analyses[video.id].ocr.text, /屏幕字/);
  assert.equal(job.analyses[video.id].vision, undefined);
});
test('an OCR failure leaves the task partial with a visible reason', async t => {
  const f = fixture(t, { media: { ocr: async () => { throw Error('本地文字识别未完成：引擎未准备'); }, vision: async () => ({ text: '画面' }) } });
  await f.service.create({ input: 'https://example.com/article', options: { vision: false, transcribe: false } }); await idle(f.service);
  const job = [...f.service.jobs.values()].find(item => item.status === 'partial');
  assert.ok(job); assert.ok(job.warnings.some(warning => /本地文字识别未完成/.test(warning)));
});
test('a resumed task uses the currently configured vision engine', async t => {
  const engines = [];
  const f = fixture(t, { media: { vision: async (_asset, options) => { engines.push(options.engine); if (options.engine === 'local') throw Error('本地识别失败'); return { text: 'API 画面', engine: 'deepseek' }; } } });
  const result = await f.service.create({ input: 'https://example.com/article', options: { visionEngine: 'local', vision: true, transcribe: false } }); await idle(f.service);
  const id = result.jobs[0].id, job = f.service.jobs.get(id);
  assert.equal(job.status, 'partial'); assert.deepEqual(engines, ['local']);
  f.service.settings = preferences({ visionEngine: 'deepseek' }, f.service.settings);
  f.service.retry(id); await idle(f.service);
  assert.ok(engines.includes('deepseek')); assert.equal(job.options.visionEngine, 'deepseek');
  const video = f.document.nodes.find(node => node.kind === 'video');
  assert.equal(job.analyses[video.id].vision.text, 'API 画面');
});
test('regenerating a type template updates the saved library without touching jobs', async t => {
  const generated = [];
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate(input) { generated.push(input);
    yield JSON.stringify({ title: '宠物护理', template: '# 宠物护理\n## 步骤\n' + '内容'.repeat(200) + '\n## 注意\n' + '注意'.repeat(50) }); } };
  const f = fixture(t, { provider });
  const first = await f.service.request('regenerate-template', { type: '宠物护理', guidance: '步骤要能照着做' });
  assert.equal(first.ok, true); assert.equal(first.result.revision, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'collection', 'summary-templates.json'), 'utf8'));
  assert.equal(saved.types['宠物护理'].title, '宠物护理'); assert.match(generated[0].messages[1].content, /步骤要能照着做/);
  const second = await f.service.request('regenerate-template', { type: '宠物护理' });
  assert.equal(second.ok, true); assert.equal(second.result.revision, 2);
  assert.equal(f.calls.includes('write'), false);
});
test('video-hint detects video input through the request allowlist', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.service.request('video-hint', { input: 'https://b23.tv/abc' }), { ok: true, result: true });
  assert.deepEqual(await f.service.request('video-hint', { input: 'https://example.com/article' }), { ok: true, result: false });
});
test('completed tasks delete working files when local copies are not kept', async t => {
  const f = fixture(t);
  const result = await f.service.create({ input: 'https://example.com/article', options: { keepLocal: false } }); await idle(f.service);
  const job = f.service.jobs.get(result.jobs[0].id);
  assert.equal(job.status, 'completed');
  assert.equal(fs.existsSync(path.join(f.service.location(job), 'working')), false);
});
