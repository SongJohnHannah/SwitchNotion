import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { stageSpeech } from '../scripts/package-speech.mjs';
const project = path.resolve(import.meta.dirname, '..');
function destination(t) {
  const dist = path.join(project, 'dist'); fs.mkdirSync(dist, { recursive: true });
  const container = fs.mkdtempSync(path.join(dist, 'test-speech-package-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(container)), fs.realpathSync(dist)); fs.rmSync(container, { recursive: true, force: true }); });
  return path.join(container, 'module');
}
test('standalone speech package loads without Electron, Notion, native bridge or user state', t => {
  const target = destination(t), result = stageSpeech({ destination: target });
  assert.equal(result.includesUserData, false); assert.equal(result.includesModels, false);
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'package-manifest.json'), 'utf8'));
  for (const file of manifest.files) assert.ok(!/native\.cjs|settings\.cjs|\.notion-switch|research|model\.bin|Notion\.exe/.test(file.file));
  const require = createRequire(import.meta.url), { SpeechProvider } = require(target);
  const provider = new SpeechProvider({ root: path.resolve('.notion-switch') });
  try { assert.equal(provider.status().provider, 'faster-whisper'); assert.equal(provider.status().offline, true); }
  finally { provider.close(); }
  assert.ok(fs.existsSync(path.join(target, 'src/speech/faster_backend.py')));
  assert.ok(fs.existsSync(path.join(target, 'src/speech-provider.d.cts')));
  assert.ok(fs.existsSync(path.join(target, 'src/speech/requirements.txt')));
});
test('speech packaging refuses existing or out-of-project destinations', t => {
  const target = destination(t); fs.mkdirSync(target);
  assert.throws(() => stageSpeech({ destination: target }), /新目录/);
  assert.throws(() => stageSpeech({ destination: path.resolve('speech-output') }), /dist/);
});
