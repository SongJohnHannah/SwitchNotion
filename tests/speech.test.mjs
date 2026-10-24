import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import speech from '../src/speech-provider.cjs';
import discovery from '../src/speech/discovery.cjs';
import settings from '../src/speech/settings.cjs';
const { SpeechProvider } = speech;
const root = path.resolve('.notion-switch/test-speech-protocol');
const runtime = { pythonExecutable: path.resolve('python.exe'), modelDirectory: path.resolve('fixture-medium') };
function pcm(seconds = 1) { const b = Buffer.alloc(16000 * 4 * seconds); for (let n = 0; n < b.length; n += 4) b.writeFloatLE(.1, n); return b; }
function fixture(t, customize = () => {}) {
  const children = [], requests = [];
  const spawnImpl = (_exe, _argv, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', 0)); };
    child.stdin = { write: (line, _encoding, callback) => {
      const m = JSON.parse(line); requests.push(m);
      const respond = result => queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: m.id, ok: true, result }) + '\n'));
      if (m.type === 'configure') respond({ protocolVersion: 1, provider: 'faster-whisper', model: 'medium', ...m.runtime, offline: true });
      else if (m.type === 'probe') respond({ ready: true });
      else if (!customize(m, child, respond)) respond({ text: '中英文识别结果' });
      callback?.(); return true;
    } };
    child.environment = options.env; children.push(child); return child;
  };
  const provider = new SpeechProvider({ root, runtime, spawnImpl, idleMs: 10, timeoutMs: 500 });
  t.after(() => provider.close()); return { provider, children, requests };
}
test('offline provider reuses one GPU worker, preserves Unicode, and releases it when idle', async t => {
  const f = fixture(t); f.provider.retain();
  await f.provider.probe(); assert.equal(f.provider.status().loaded, true);
  assert.equal(await f.provider.transcribe({ pcm: pcm(), language: 'zh' }), '中英文识别结果');
  assert.equal(await f.provider.transcribe({ pcm: pcm(), language: 'en' }), '中英文识别结果');
  assert.equal(f.children.length, 1); assert.equal(f.requests.filter(r => r.type === 'configure').length, 1);
  assert.equal(f.children[0].environment.HF_HUB_OFFLINE, '1');
  assert.ok(!Object.keys(f.children[0].environment).some(k => /KEY|TOKEN|SECRET/.test(k)));
  f.provider.release(); await delay(30); assert.equal(f.children[0].killed, true); assert.equal(f.provider.status().loaded, false);
});
test('stopping an in-flight transcript terminates its own worker and a later request can restart', async t => {
  let pending = false;
  const f = fixture(t, () => { if (!pending) { pending = true; return true; } return false; });
  await f.provider.probe(); const abort = new AbortController();
  const task = f.provider.transcribe({ pcm: pcm(), signal: abort.signal });
  await delay(5); abort.abort(Error('fixture cancellation'));
  await assert.rejects(task, /fixture cancellation/); assert.equal(f.children[0].killed, true);
  assert.equal(await f.provider.transcribe({ pcm: pcm() }), '中英文识别结果'); assert.equal(f.children.length, 2);
});
test('invalid PCM and language are rejected before starting a Python process', async t => {
  const f = fixture(t); const invalid = pcm(); invalid.writeFloatLE(NaN, 0);
  await assert.rejects(f.provider.transcribe({ pcm: invalid }), /格式无效/);
  await assert.rejects(f.provider.transcribe({ pcm: pcm(), language: 'not-a-language' }), /请选择/);
  assert.equal(f.children.length, 0);
});
test('native protocol failures never expose raw worker messages or provider credentials', async t => {
  const f = fixture(t, (_m, child) => { queueMicrotask(() => child.stdout.emit('data', 'private parser failure\n')); return true; });
  await f.provider.probe(); await assert.rejects(f.provider.transcribe({ pcm: pcm() }), e => !e.message.includes('private parser failure'));
});
test('worker environment is limited to local execution settings and carries no model service credentials', () => {
  const value = discovery.environment(root); assert.equal(value.HF_HUB_OFFLINE, '1'); assert.equal(value.PYTHONDONTWRITEBYTECODE, '1');
  assert.ok(!Object.keys(value).some(k => /KEY|TOKEN|SECRET/.test(k)));
});
test('settings status does not expose Python/model paths and rejects arbitrary actions', async () => {
  const fake = { status: () => ({ configured: true, offline: true }), runtime, close() {} };
  const service = new settings.SpeechSettings({ root, provider: fake });
  const response = await service.request('speech.status'); assert.equal(response.ok, true);
  assert.ok(!JSON.stringify(response).includes(runtime.pythonExecutable));
  assert.equal((await service.request('speech.status', { apiKey: 'fixture' })).ok, false);
  assert.equal((await service.request('constructor')).ok, false);
});
