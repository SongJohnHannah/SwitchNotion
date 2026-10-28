import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollectionNotion } = require('../src/collection/notion.cjs');
const { createSession } = require('../src/notion-blocks.cjs');
test('rotating hosted-file signatures preserve revision checks but changed files and captions still block deletion', async () => {
  for (const change of ['signature','file','caption']) {
    const id=randomUUID(),parent=randomUUID();let mutations=0;
    const block={object:'block',id,parent:{page_id:parent},type:'video',has_children:false,in_trash:false,video:{type:'file',file:{url:'https://file.notion.so/original.mp4?signature=one',expiry_time:'first'},caption:[]}};
    const session=createSession({authorize:async value=>value,request:async()=>structuredClone(block),mutate:async intent=>{mutations++;block.in_trash=true;block.video.file.url=block.video.file.url.replace('signature=two','signature=three');return intent.verify(block)}});
    const read=await session.execute('read_block',{block_id:id});
    block.video.file.url=change==='file'?'https://file.notion.so/changed.mp4?signature=two':'https://file.notion.so/original.mp4?signature=two';block.video.file.expiry_time='second';
    if(change==='caption')block.video.caption=[{type:'text',text:{content:'用户备注'}}];
    if(change==='signature'){const result=await session.execute('trash_block',{block_id:id,block_revision:read.block_revision});assert.equal(result.verified,true);assert.equal(mutations,1)}
    else{await assert.rejects(session.execute('trash_block',{block_id:id,block_revision:read.block_revision}),/已变化/);assert.equal(mutations,0)}
  }
});

test('rich text readback accepts merged text spans while rejecting lost links and formatting', async () => {
  const { matchesBlockContent } = require('../src/notion-blocks.cjs');
  const expected = { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '原文' } }, { type: 'text', text: { content: '内容' } }, { type: 'text', text: { content: '链接', link: { url: 'https://example.com' } }, annotations: { bold: true } }] } };
  const actual = { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '原文内容', link: null } }, { type: 'text', text: { content: '链接', link: { url: 'https://example.com' } }, annotations: { bold: true } }] } };
  assert.equal(matchesBlockContent(actual, expected), true);
  actual.paragraph.rich_text[1].annotations.bold = false; assert.equal(matchesBlockContent(actual, expected), false);
  actual.paragraph.rich_text[1].annotations.bold = true; actual.paragraph.rich_text[1].text.link = null; assert.equal(matchesBlockContent(actual, expected), false);
});
test('uploaded media verification binds a hosted file to the creation response despite rotating signed queries', async () => {
  for (const different of [false, true]) {
    const parent = randomUUID(), id = randomUUID(), uploadId = randomUUID();
    const submitted = { object: 'block', id, type: 'image', parent: { page_id: parent }, image: { type: 'file', file: { url: 'https://file.notion.so/image.jpg?signature=one' }, caption: [] } };
    const read = structuredClone(submitted); read.image.file.url = different ? 'https://file.notion.so/different.jpg?signature=two' : 'https://file.notion.so/image.jpg?signature=two';
    const session = createSession({ authorize: async value => value, request: async () => read, mutate: async intent => intent.verify({ results: [submitted] }) });
    const result = await session.execute('append_blocks', { block_id: parent, blocks: [{ type: 'image', image: { type: 'file_upload', file_upload: { id: uploadId }, caption: [] } }] });
    assert.equal(result.verified, !different);
  }
});
test('large official uploads use bounded multipart requests, resume confirmed parts and independently check completion', async t => {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-collection-upload-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(parent)); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'video.mp4'), handle = fs.openSync(file, 'w'); fs.ftruncateSync(handle, 21 * 1024 ** 2); fs.closeSync(handle);
  const id = randomUUID(), calls = [], parts = [];
  let uploaded = false;
  const notion = new CollectionNotion({ root, fetchImpl: async (url, options) => {
    assert.ok(url.startsWith('https://api.notion.com/v1/file_uploads'));
    assert.equal(options.headers.authorization, 'Bearer synthetic-key'); calls.push({ url, method: options.method });
    if (url.endsWith('/send')) { parts.push({ number: Number(options.body.get('part_number')), bytes: options.body.get('file').size }); return Response.json({ status: 'pending' }); }
    if (url.endsWith('/complete')) { uploaded = true; return Response.json({ id, status: 'uploaded' }); }
    if (options.method === 'POST') { const body = JSON.parse(options.body); assert.equal(body.mode, 'multi_part'); assert.equal(body.number_of_parts, 3); return Response.json({ id, status: 'pending' }); }
    return Response.json({ id, status: uploaded ? 'uploaded' : 'pending' });
  } });
  notion.connect = async () => ({ cfg: { key: 'synthetic-key' } });
  const state = { id, parts: [1] }, job = { id: randomUUID(), options: { destination: {} } };
  await notion.upload({ path: file }, job, state, () => {}, new AbortController().signal);
  assert.deepEqual(parts.map(p => p.number), [2, 3]); assert.deepEqual(parts.map(p => p.bytes), [10 * 1024 ** 2, 1024 ** 2]);
  assert.equal(state.uploaded, true); assert.equal(calls.filter(c => c.url.endsWith('/complete')).length, 1);
  const before = calls.length; await notion.upload({ path: file }, job, state, () => {}, new AbortController().signal);
  assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).method, 'GET');
});
