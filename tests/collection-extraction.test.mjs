import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseInputs, describeLocal, checkLocal } = require('../src/collection/local-media.cjs');
const { preferences, normalizeDocument, layoutNodes } = require('../src/collection/model.cjs');
const { templateFor, templates } = require('../src/collection/prompts.cjs');
const { CollectionExtraction } = require('../src/collection/extraction.cjs');
const { renderDocument } = require('../src/collection/notion.cjs');
test('one input accepts Windows, Mac and file URLs with spaces, alongside web links', () => {
  assert.deepEqual(parseInputs('"D:\\媒体 资料\\片段.mp4"\nhttps://example.com/article\nfile:///C:/Users/me/My%20Audio.m4a', { platform: 'win32', home: 'C:\\Users\\me' }), [
    { kind: 'local', path: 'D:\\媒体 资料\\片段.mp4' }, { kind: 'web', url: 'https://example.com/article' }, { kind: 'local', path: 'C:\\Users\\me\\My Audio.m4a' }]);
  assert.deepEqual(parseInputs('/Users/me/电影 片段.mov\n~/Downloads/声音.wav\nfile:///Users/me/Audio%20Test.mp3', { platform: 'darwin', home: '/Users/me' }), [
    { kind: 'local', path: '/Users/me/电影 片段.mov' }, { kind: 'local', path: '/Users/me/Downloads/声音.wav' }, { kind: 'local', path: '/Users/me/Audio Test.mp3' }]);
  for (const input of ['file://server/share/audio.mp3', '\\\\server\\share\\audio.mp3', './relative.mp4', '/Users/me/secrets.txt']) assert.throws(() => parseInputs(input, { platform: 'darwin' }));
});
test('local retries reject a replaced source instead of silently processing different media', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-local-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const file = path.join(root, '音频.mp3'); fs.writeFileSync(file, 'original'); const source = describeLocal(file);
  assert.equal(checkLocal(source).kind, 'audio'); fs.writeFileSync(file, 'changed content'); assert.throws(() => checkLocal(source), /改变/);
});
test('template edits are bounded, independent and selected automatically from the selected content', () => {
  const defaults = preferences(), edited = preferences({ extraction: { article: '只提取可执行清单' } }, defaults);
  assert.equal(defaults.extraction.article, templates.article); assert.equal(edited.extraction.video, templates.video);
  assert.equal(templateFor(edited, [{ kind: 'paragraph' }]).prompt, '只提取可执行清单');
  assert.equal(templateFor(edited, [{ kind: 'audio' }]).kind, 'video');
  assert.equal(templateFor(edited, [{ kind: 'paragraph', text: '原文'.repeat(600) }, { kind: 'video' }]).kind, 'article');
  assert.equal(templateFor(preferences({ extraction: { mode: 'off' } }), []), null);
  assert.throws(() => preferences({ extraction: { article: '' } })); assert.throws(() => preferences({ extraction: { apiKey: 'forbidden' } }));
});
test('article text and images keep their order, original audio/video precedes the separate AI section', () => {
  const doc = normalizeDocument({ url: 'https://example.com/article', nodes: [{ kind: 'paragraph', text: '第一段' }, { kind: 'video', url: 'https://example.com/a.mp4' }, { kind: 'image', url: 'https://example.com/a.jpg' }, { kind: 'paragraph', text: '末段' }, { kind: 'audio', url: 'https://example.com/a.mp3' }] });
  const ordered = layoutNodes(doc.nodes, 'media-at-end'); assert.deepEqual(ordered.map(node => node.kind), ['paragraph', 'image', 'paragraph', 'video', 'audio']);
  const resources = Object.fromEntries(ordered.filter(node => ['video', 'audio', 'image'].includes(node.kind)).map(node => [node.id, { uploads: [{ id: 'fixture', uploaded: true }] }]));
  const plan = renderDocument(doc, ordered, resources, {}, [], { name: '文章精读', text: '## 核心结论\n独立输出' });
  const ai = plan.blocks.findIndex(block => block.heading_1?.rich_text[0]?.text.content.startsWith('AI 提取结果'));
  assert.ok(plan.slots[doc.nodes[3].id].start < plan.slots[doc.nodes[1].id].start); assert.ok(plan.slots[doc.nodes[4].id].start < ai);
});
test('extraction uses only selected evidence, checkpoints all chunks and appends after originals', async () => {
  const calls = [], provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate(input) { calls.push(input); yield '## 核心观点\n- 有证据的结论'; } };
  const doc = normalizeDocument({ title: '原文', url: 'https://example.com/a', nodes: [{ kind: 'paragraph', text: '完整原文'.repeat(9000) }, { kind: 'paragraph', text: '未选择的私人段落' }] });
  const job = { options: preferences({ extraction: { article: '保留数字和步骤' } }), document: doc, analyses: {} }, engine = new CollectionExtraction({ provider });
  const result = await engine.run(job, [doc.nodes[0]], { signal: new AbortController().signal });
  assert.equal(calls.length, 3); assert.equal(calls.some(call => JSON.stringify(call.messages).includes('未选择的私人段落')), false);
  assert.equal(calls.every(call => !call.tools && call.messages[1].content.includes('保留数字和步骤')), true);
  assert.equal(calls[0].messages.at(-1).content.includes(doc.nodes[0].text.slice(0, 100)), true);
  job.extraction = result; await engine.run(job, [doc.nodes[0]], { signal: new AbortController().signal }); assert.equal(calls.length, 3);
  const plan = renderDocument(doc, [doc.nodes[0]], {}, {}, [], result);
  const ai = plan.blocks.findIndex(b => b.heading_1?.rich_text[0]?.text.content.startsWith('AI 提取结果'));
  assert.ok(ai > plan.slots[doc.nodes[0].id].start + plan.slots[doc.nodes[0].id].count - 1);
});
