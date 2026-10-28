import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

test('bundled HTML dependencies match the reviewed source manifest and include their full licenses', () => {
  const root = path.resolve('src/vendor'), manifest = JSON.parse(fs.readFileSync(path.join(root, 'web-parser.manifest.json'), 'utf8'));
  assert.deepEqual(manifest.map(value => [value.name, value.version, value.license]), [['entities', '4.5.0', 'BSD-2-Clause'], ['parse5', '7.2.1', 'MIT']]);
  for (const item of manifest) {
    assert.ok(item.files.some(value => value.file === 'LICENSE')); assert.match(fs.readFileSync(path.join(root, item.name, 'LICENSE'), 'utf8'), /copyright/i);
    for (const value of item.files) {
      assert.ok(!value.file.includes('..')); const file = path.join(root, item.name, value.file);
      assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), value.sha256, item.name + '/' + value.file);
    }
  }
});
