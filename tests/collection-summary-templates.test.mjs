import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadLibrary, saveLibrary, resolveTemplate, normalizeType, builtinTypes, libraryFile } = require('../src/collection/summary-templates.cjs');

test('template library stores valid types and rejects corrupt or unsafe entries', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-templates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(loadLibrary(root), { version: 1, types: {} });
  const saved = saveLibrary(root, { version: 1, types: {
    '美食制作': { type: '美食制作', title: '美食制作', template: '# 美食\n## 配料\n' + '内容'.repeat(200), revision: 2, source: 'deepseek' },
    '../bad': { type: '../bad', title: 'bad', template: 'x'.repeat(300) },
    '短模板': { type: '短模板', title: '短', template: '太短' }
  } });
  assert.deepEqual(Object.keys(saved.types), ['美食制作']);
  assert.equal(saved.types['美食制作'].revision, 2);
  assert.equal(loadLibrary(root).types['美食制作'].title, '美食制作');
  fs.writeFileSync(libraryFile(root), '{broken');
  assert.deepEqual(loadLibrary(root), { version: 1, types: {} });
});
test('built-in types resolve without a saved library and unknown types return null', () => {
  assert.ok(builtinTypes.includes('教程') && builtinTypes.includes('美食制作'));
  assert.equal(resolveTemplate({ version: 1, types: {} }, '教程').title, '分步教程');
  assert.equal(resolveTemplate({ version: 1, types: {} }, '未知类型'), null);
  assert.equal(normalizeType(' 教程 '), '教程');
  assert.equal(normalizeType('../etc'), '');
});
