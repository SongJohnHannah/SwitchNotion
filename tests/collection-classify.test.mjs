import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyContent, generateTemplate, parseJson } = require('../src/collection/classify.cjs');

const provider = text => ({ async *generate() { yield text; } });
test('classification parses fenced JSON and falls back to a generic type on bad output', async () => {
  const parsed = await classifyContent({ provider: provider('```json\n{"type":"教程","title":"分步教程","tone":"耐心讲解"}\n```'), config: {}, material: '资料', types: ['教程'] });
  assert.deepEqual(parsed, { type: '教程', title: '分步教程', tone: '耐心讲解', degraded: false });
  const fallback = await classifyContent({ provider: provider('not json'), config: {}, material: '资料', types: ['教程'] });
  assert.equal(fallback.type, '通用'); assert.equal(fallback.degraded, true);
});
test('template generation validates markdown length and headings', async () => {
  const good = JSON.stringify({ title: '美食', template: '# 美食\n## 配料\n' + '内容'.repeat(200) + '\n## 步骤\n' + '步骤'.repeat(50) });
  assert.equal((await generateTemplate({ provider: provider(good), config: {}, type: '美食制作' })).title, '美食');
  assert.equal(await generateTemplate({ provider: provider('{"title":"x","template":"太短"}'), config: {}, type: '美食制作' }), null);
  assert.equal(parseJson('prefix {"a":1} suffix').a, 1);
});
