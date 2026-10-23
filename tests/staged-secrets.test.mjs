import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkStagedSecrets } from '../scripts/check-staged-secrets.mjs';

test('the Git guard inspects staged blobs, rejects local key values and blocks forced private files', t => {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-git-secrets-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git(['init', '-q']); fs.mkdirSync(path.join(root, '.notion-switch'));
  const key = 'fixture-local-credential-only'; fs.writeFileSync(path.join(root, '.notion-switch/deepseek-api-key.txt'), key);
  const file = path.join(root, 'app.js'); fs.writeFileSync(file, 'module.exports={};'); git(['add', 'app.js']);
  fs.writeFileSync(file, `module.exports='${key}';`);
  assert.equal(checkStagedSecrets(root).credentialsFound, false);
  git(['add', 'app.js']); fs.writeFileSync(file, 'module.exports={};');
  assert.throws(() => checkStagedSecrets(root), error => error.message.includes('停止提交') && !error.message.includes(key));
  git(['add', 'app.js']); fs.writeFileSync(path.join(root, '.env'), 'CONFIG=fixture'); git(['add', '-f', '.env']);
  assert.throws(() => checkStagedSecrets(root), /停止提交/);
});
