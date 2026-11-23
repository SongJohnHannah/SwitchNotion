import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { prepareReport } = require('../src/collection/report-markdown.cjs');
const { CollectionExtraction } = require('../src/collection/extraction.cjs');
const { normalizeDocument, preferences } = require('../src/collection/model.cjs');
const opening = '## 专业结论\n- 原文介绍软件操作。\n## 展开细节\n### 详情｜证据链与底层原理\n- 软件入口待核实。';
const invalid = opening + '\n### 详情｜补充核验\n- 文档确认了遮罩路径。 [S1]\n- 工具安装方式没有已读正文支持，仍待核实。';

test('report validation identifies uncited verification items while retaining citation safeguards', () => {
  const options = { visual: false, hasReadableText: true, sourceIds: new Set(['[S1]']) };
  const result = prepareReport(invalid, options);
  assert.equal(result.valid, false);
  assert.ok(result.problems?.some(problem => /补充核验/.test(problem) && /工具安装方式/.test(problem)), 'identify the item that needs repair');
  assert.equal(prepareReport(opening + ' [S1]', options).valid, false, 'external citations still cannot enter original evidence');
  assert.equal(prepareReport(opening + '\n### 详情｜补充核验\n- 文档确认了遮罩路径。 [S9]', options).valid, false, 'invented references remain invalid');
});

test('format retry locates an unverified item and keeps it with original evidence instead of inventing a citation', async () => {
  let finalCalls = 0;
  const document = normalizeDocument({ url: 'https://example.com/article', nodes: [{ kind: 'paragraph', text: '文章介绍软件操作，但没有给出遮罩路径。'.repeat(2500) }] });
  const webSources = { openCollection: () => ({ signal: new AbortController().signal, close() {}, async execute(name) {
    if (name === 'search_web') return { results: [{ url: 'https://example.com/manual', title: '遮罩路径' }] };
    return { url: 'https://example.com/manual', title: '遮罩路径', text: '官方文档说明遮罩路径入口。'.repeat(25) };
  } }) };
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    if (messages[0].content.includes('只输出证据笔记')) { yield '- [正文] 软件操作。 [实操缺口待核实：遮罩路径]'; return; }
    if (messages[0].content.includes('公开搜索词')) { yield '[{"feature":"遮罩路径","query":"遮罩路径 官方文档","must_have_terms":["遮罩路径"]}]'; return; }
    finalCalls++;
    if (finalCalls === 1) { yield invalid; return; }
    assert.match(messages.at(-1).content, /工具安装方式/);
    assert.match(messages.at(-1).content, /不要补造引用/);
    yield opening + '\n- 工具安装方式仍待核实。\n### 详情｜补充核验\n- 文档确认了遮罩路径。 [S1]';
  } };
  const report = await new CollectionExtraction({ provider, webSources }).run({ document, options: preferences(), analyses: {} }, document.nodes);
  assert.equal(finalCalls, 2);
  assert.match(report.text, /查看依据[\s\S]*工具安装方式仍待核实/);
  const verification = report.text.split('### 详情｜补充核验')[1].split('### 详情｜查看依据')[0];
  assert.doesNotMatch(verification, /工具安装方式/);
});
