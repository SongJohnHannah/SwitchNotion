import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkStagedSecrets } from '../scripts/check-staged-secrets.mjs';

test('vendored dist source remains scanned while root build output stays private', t => {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-git-vendor-dist-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' }); git(['init', '-q']);
  const source = 'src/vendor/unpdf/dist/pdfjs.mjs'; fs.mkdirSync(path.dirname(path.join(root, source)), { recursive: true }); fs.writeFileSync(path.join(root, source), 'export const synthetic = true;'); git(['add', source]);
  assert.equal(checkStagedSecrets(root).privateFilesFound, false);
  fs.mkdirSync(path.join(root, 'dist')); fs.writeFileSync(path.join(root, 'dist/private.txt'), 'private fixture'); git(['add', '-f', 'dist/private.txt']);
  assert.throws(() => checkStagedSecrets(root), /停止提交/); git(['rm', '--cached', '-q', 'dist/private.txt']);
  fs.mkdirSync(path.join(root, '.notion-switch')); const key = 'fixture-vendor-key-must-stay-private'; fs.writeFileSync(path.join(root, '.notion-switch/deepseek-api-key.txt'), key);
  fs.writeFileSync(path.join(root, source), `export const fixture = '${key}';`); git(['add', source]);
  assert.throws(() => checkStagedSecrets(root), error => !error.message.includes(key) && error.message.includes('停止提交'));
});

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

test('recordings and login databases are rejected even when force-added or renamed without their usual extension', t => {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-git-private-media-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git(['init', '-q']);
  for (const [file, contents] of [
    ['meeting.WAV', 'fixture'], ['meeting.webm', 'fixture'], ['session.sqlite-wal', 'fixture'],
    ['Login Data', 'fixture'], ['profiles/session', 'fixture'],
    ['renamed-audio.bin', Buffer.from('RIFF0000WAVEfmt ')],
    ['renamed-recording.bin', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
    ['renamed-login.bin', Buffer.from('SQLite format 3\0')]
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), contents);
    git(['add', '-f', '--', file]);
    assert.throws(() => checkStagedSecrets(root), /停止提交/, file);
    git(['rm', '--cached', '-q', '--', file]);
  }
  fs.writeFileSync(path.join(root, 'adapter.cjs'), 'module.exports = {};'); git(['add', 'adapter.cjs']);
  assert.equal(checkStagedSecrets(root).privateFilesFound, false);
});
