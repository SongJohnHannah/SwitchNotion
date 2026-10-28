import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertDistributionFiles, localDeepSeekKeys } from '../scripts/package-safety.mjs';
function fixture(t) {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-package-safety-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; };
  return { root, write };
}
test('private configuration and key files are rejected even if placed inside distributable source', t => {
  const f = fixture(t);
  for (const name of ['src/deepseek-api-key.txt', 'src/provider.local.json', 'src/.env', '.notion-switch/log.txt']) {
    const file = f.write(name, 'fixture'); assert.throws(() => assertDistributionFiles(f.root, [file]), /停止打包/);
  }
});
test('embedded credential strings stop packaging without printing the credential', t => {
  const f = fixture(t), key = 'sk-' + 'A'.repeat(32), file = f.write('src/example.cjs', `const key='${key}'`);
  assert.throws(() => assertDistributionFiles(f.root, [file]), error => error.message.includes('停止打包') && !error.message.includes(key));
});
test('the actual locally configured key is checked in UTF-8 and UTF-16 without entering the package', t => {
  const f = fixture(t), key = 'fixture-private-credential';
  f.write('.notion-switch/provider.local.json', JSON.stringify({ apiKeyFile: 'custom-key.txt' })); f.write('.notion-switch/custom-key.txt', key);
  const keys = localDeepSeekKeys(f.root, {}); assert.deepEqual(keys, [key]);
  for (const encoding of ['utf8', 'utf16le']) {
    const file = f.write('src/accidental.bin', Buffer.from('prefix:' + key, encoding));
    assert.throws(() => assertDistributionFiles(f.root, [file], keys), /停止打包/);
  }
  assert.doesNotThrow(() => assertDistributionFiles(f.root, [f.write('src/clean.cjs', 'module.exports={};')], keys));
});

test('a configured Brave search key is excluded and scanned even when it has no DeepSeek key prefix', t => {
  const f = fixture(t), key = 'synthetic-brave-private-value';
  f.write('.notion-switch/web-sources.local.json', JSON.stringify({ version: 1, enabled: true, braveApiKey: key }));
  const keys = localDeepSeekKeys(f.root, {}); assert.deepEqual(keys, [key]);
  assert.throws(() => assertDistributionFiles(f.root, [f.write('src/accidental.cjs', 'value=' + key)], keys), error => /停止打包/.test(error.message) && !error.message.includes(key));
});
