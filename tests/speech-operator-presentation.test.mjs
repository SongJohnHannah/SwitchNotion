import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('the initial model selector stays disabled until actual platform state arrives and never claims a loaded Medium model', () => {
  const html = fs.readFileSync(new URL('../src/settings/index.html', import.meta.url), 'utf8');
  assert.match(html.match(/<select id="speech-model"[^>]*>/)?.[0] || '', /disabled/);
  assert.doesNotMatch(html.match(/id="speech-backend"[^>]*>([^<]*)/)[1], /Medium/);
});

test('Windows presentation exposes only Turbo and distinguishes available resources from a loaded GPU model', () => {
  const context = { window: {} }; vm.runInNewContext(fs.readFileSync(new URL('../src/settings/speech-presentation.js', import.meta.url), 'utf8'), context);
  const display = context.window.speechPresentation;
  const available = display({ operatorSession: true, modelLocked: true, configured: true, ready: true, loaded: false, supported: true, device: 'cuda' });
  assert.equal(available.model, 'large-v3-turbo'); assert.equal(available.modelLocked, true);
  assert.deepEqual(Array.from(available.models, model => model.id), ['large-v3-turbo']);
  assert.equal(available.badge, 'GPU 资源已就绪'); assert.match(available.description, /尚未载入/);
  assert.doesNotMatch(available.modelHelp, /下载/); assert.doesNotMatch(available.backend, /beam|Medium|undefined/);
  const loaded = display({ operatorSession: true, modelLocked: true, configured: true, ready: true, loaded: true, supported: true, hardwareLabel: 'NVIDIA GPU' });
  assert.equal(loaded.badge, 'GPU 模型已载入');
  const missing = display({ operatorSession: true, modelLocked: true, configured: false, loaded: false, supported: true, lastFailure: '独立 GPU 算子不存在' });
  assert.match(missing.description, /独立 GPU 算子不存在/); assert.doesNotMatch(missing.description, /自动下载/);
});

test('Mac presentation retains selectable local models and CPU hardware labels', () => {
  const context = { window: {} }; vm.runInNewContext(fs.readFileSync(new URL('../src/settings/speech-presentation.js', import.meta.url), 'utf8'), context);
  const state = context.window.speechPresentation({ model: 'medium', hardwareLabel: 'Apple Silicon CPU', configured: true, supported: true });
  assert.equal(state.modelLocked, false); assert.deepEqual(Array.from(state.models, model => model.id).sort(), ['large-v3-turbo', 'medium']);
  assert.match(state.backend, /Apple Silicon CPU/);
});
