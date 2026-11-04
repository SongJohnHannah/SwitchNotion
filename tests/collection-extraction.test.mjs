import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseInputs, describeLocal, checkLocal } = require('../src/collection/local-media.cjs');
const { preferences, normalizeDocument, layoutNodes } = require('../src/collection/model.cjs');
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
test('extraction settings accept legacy templates, keep one preference and bound input', () => {
  const defaults = preferences();
  assert.deepEqual(defaults.extraction, { mode: 'auto', preference: '' });
  const migrated = preferences({ extraction: { mode: 'video', article: '旧模板', video: '旧模板' } });
  assert.deepEqual(migrated.extraction, { mode: 'auto', preference: '' });
  const edited = preferences({ extraction: { mode: 'off', preference: '重点总结口播风格' } });
  assert.deepEqual(edited.extraction, { mode: 'off', preference: '重点总结口播风格' });
  assert.throws(() => preferences({ extraction: { preference: 'x'.repeat(4001) } }));
  assert.throws(() => preferences({ extraction: { apiKey: 'forbidden' } }));
});
test('article text and images keep their order, original audio/video precedes the separate AI section', () => {
  const doc = normalizeDocument({ url: 'https://example.com/article', nodes: [{ kind: 'paragraph', text: '第一段' }, { kind: 'video', url: 'https://example.com/a.mp4' }, { kind: 'image', url: 'https://example.com/a.jpg' }, { kind: 'paragraph', text: '末段' }, { kind: 'audio', url: 'https://example.com/a.mp3' }] });
  const ordered = layoutNodes(doc.nodes, 'media-at-end'); assert.deepEqual(ordered.map(node => node.kind), ['paragraph', 'image', 'paragraph', 'video', 'audio']);
  const resources = Object.fromEntries(ordered.filter(node => ['video', 'audio', 'image'].includes(node.kind)).map(node => [node.id, { uploads: [{ id: 'fixture', uploaded: true }] }]));
  const plan = renderDocument(doc, ordered, resources, {}, [], { name: '文章精读', text: '## 核心结论\n独立输出' });
  const ai = plan.blocks.findIndex(block => block.heading_1?.rich_text[0]?.text.content.startsWith('AI 提取结果'));
  assert.ok(plan.slots[doc.nodes[3].id].start < plan.slots[doc.nodes[1].id].start); assert.ok(plan.slots[doc.nodes[4].id].start < ai);
});
test('extraction classifies the material, reuses a built-in type template and checkpoints all chunks', async () => {
  const calls = [], provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate(input) {
    calls.push(input);
    if (input.messages[0].content.includes('判断资料')) yield '{"type":"知识学习","title":"知识学习","tone":"讲解型"}';
    else yield '## 核心观点\n- 有证据的结论';
  } };
  const doc = normalizeDocument({ title: '原文', url: 'https://example.com/a', nodes: [{ kind: 'paragraph', text: '完整原文'.repeat(9000) }, { kind: 'paragraph', text: '未选择的私人段落' }] });
  const job = { options: preferences({ extraction: { preference: '保留数字和步骤' } }), document: doc, analyses: { [doc.nodes[0].id]: { ocr: { text: '关键帧文字样本' } } } };
  const engine = new CollectionExtraction({ provider, library: { version: 1, types: {} }, saveLibrary: () => assert.fail('内置类型不应生成新模板') });
  const result = await engine.run(job, [doc.nodes[0]], { signal: new AbortController().signal });
  assert.equal(calls.length, 4); assert.equal(calls[0].messages[0].content.includes('判断资料'), true);
  assert.equal(calls.slice(1).every(call => call.messages[1].content.includes('保留数字和步骤')), true);
  assert.equal(calls.slice(1).some(call => call.messages.at(-1).content.includes('关键帧文字样本')), true);
  assert.equal(calls.some(call => JSON.stringify(call.messages).includes('未选择的私人段落')), false);
  assert.equal(result.type, '知识学习'); assert.equal(result.name, '知识学习');
  job.extraction = result; await engine.run(job, [doc.nodes[0]], { signal: new AbortController().signal });
  assert.equal(calls.length, 4);
  const plan = renderDocument(doc, [doc.nodes[0]], {}, {}, [], result);
  const ai = plan.blocks.findIndex(b => b.heading_1?.rich_text[0]?.text.content.startsWith('AI 提取结果'));
  assert.ok(ai > plan.slots[doc.nodes[0].id].start + plan.slots[doc.nodes[0].id].count - 1);
});
test('a new content type generates and stores one template for later reuse', async () => {
  const calls = [], provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate(input) {
    calls.push(input);
    const system = input.messages[0].content;
    if (system.includes('判断资料')) yield '{"type":"宠物护理","title":"宠物护理","tone":"经验分享"}';
    else if (system.includes('设计可复用')) yield JSON.stringify({ title: '宠物护理', template: '# 宠物护理\n## 适用前提\n' + '内容'.repeat(150) + '\n## 操作步骤\n' + '步骤'.repeat(150) });
    else yield '## 结果\n完成';
  } };
  const doc = normalizeDocument({ title: '养猫', url: 'https://example.com/pet', nodes: [{ kind: 'paragraph', text: '养猫经验'.repeat(200) }] });
  const library = { version: 1, types: {} }, engine = new CollectionExtraction({ provider, library, saveLibrary: () => {} });
  const job = { options: preferences(), document: doc, analyses: {} };
  const result = await engine.run(job, [doc.nodes[0]], { signal: new AbortController().signal });
  assert.equal(result.type, '宠物护理'); assert.equal(result.name, '宠物护理');
  assert.equal(library.types['宠物护理'].source, 'deepseek'); assert.equal(library.types['宠物护理'].revision, 1);
  const before = calls.length, second = { options: preferences(), document: doc, analyses: {} };
  await engine.run(second, [doc.nodes[0]], { signal: new AbortController().signal });
  assert.equal(calls.length, before + 2);
  assert.equal(calls.slice(before).some(call => call.messages[0].content.includes('设计可复用')), false);
});
test('classification failures fall back to the generic template without blocking extraction', async () => {
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate(input) {
    if (input.messages[0].content.includes('判断资料')) yield 'not json'; else yield '## 总结\n可以执行';
  } };
  const doc = normalizeDocument({ title: '未分类', url: 'https://example.com/x', nodes: [{ kind: 'paragraph', text: '一段内容' }] });
  const job = { options: preferences(), document: doc, analyses: {} };
  const result = await new CollectionExtraction({ provider, library: { version: 1, types: {} }, saveLibrary: () => {} }).run(job, [doc.nodes[0]], { signal: new AbortController().signal });
  assert.equal(result.type, '通用'); assert.equal(job.classification.degraded, true);
});
