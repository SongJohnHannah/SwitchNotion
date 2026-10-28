import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

test('document parser runtime and offline PDF resources match the pinned manifest with full licenses', () => {
  const root = path.resolve('src/vendor'), manifest = JSON.parse(fs.readFileSync(path.join(root, 'document-parser.manifest.json'), 'utf8'));
  assert.deepEqual(manifest.map(value => [value.name, value.version, value.license]), [
    ['xmlchars', '2.2.0', 'MIT'], ['saxes', '6.0.0', 'ISC'], ['unpdf', '1.9.1', 'MIT'], ['pdfjs-dist', '6.4.299', 'Apache-2.0']
  ]);
  for (const item of manifest) {
    assert.ok(item.files.some(value => value.file === 'LICENSE'));
    assert.match(fs.readFileSync(path.join(root, item.name, 'LICENSE'), 'utf8'), /copyright/i);
    for (const value of item.files) {
      assert.ok(!value.file.includes('..'));
      assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, item.name, value.file))).digest('hex'), value.sha256, item.name + '/' + value.file);
    }
  }
  const saxes = manifest.find(value => value.name === 'saxes');
  assert.equal(saxes.supplementalLicense.sha256, saxes.files.find(value => value.file === 'LICENSE').sha256);
  assert.ok(manifest.find(value => value.name === 'pdfjs-dist').files.every(value => /^(?:cmaps\/|standard_fonts\/|package\.json$|LICENSE$)/.test(value.file)));
});
