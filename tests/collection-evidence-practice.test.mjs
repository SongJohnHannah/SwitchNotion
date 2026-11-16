import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reviewContentEvidence } = require('../src/collection/evidence-review.cjs');
const { prepareReport } = require('../src/collection/report-markdown.cjs');
const draft = '## 专业结论\n记录需求后练习。\n## 给 AI 的指令\n请指导我做练习。';
const args = practice => ({ source: '正文：\n作者说先记录需求。', draft,
  prepare: value => prepareReport(value, { visual: false, hasReadableText: true, sourceIds: new Set() }), validSources: () => true,
  generate: async messages => messages[0].content.includes('从原始素材提取证据清单') ? JSON.stringify({ declaredSteps: 0, steps: [] }) : JSON.stringify({ practice, markdown: draft }) });

test('evidence coaching accepts its known supplemental marker at either end and renders it once', async () => {
  for (const practice of ['[补充建议] 换一份素材，记录需求并核对结果。', '换一份素材，记录需求并核对结果。 [补充建议]']) {
    const result = await reviewContentEvidence(args(practice));
    assert.equal(result.text.match(/\[补充建议\]/g)?.length, 1);
    assert.match(result.text, /\[补充建议\] 换一份素材，记录需求并核对结果。/);
  }
});
test('unknown citations and multi-line coaching still fail validation', async () => {
  for (const practice of ['换一份素材。 [S99]', '先操作。\n再核对。']) {
    await assert.rejects(reviewContentEvidence(args(practice)), /终稿证据核对/);
  }
});
