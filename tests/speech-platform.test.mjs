import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import platforms from '../src/speech/platform.cjs';
import discovery from '../src/speech/discovery.cjs';
import speech from '../src/speech-provider.cjs';
import settings from '../src/speech/settings.cjs';
const { createSpeechPlatform } = platforms;
const macRuntime = { platform: 'darwin', architecture: 'arm64', pythonExecutable: '/Users/test/asr/bin/python3',
  modelDirectory: '/Users/test/models/medium', device: 'cpu', computeType: 'int8', cpuThreads: 4 };
const mac = extra => createSpeechPlatform({ id: 'darwin', arch: 'arm64', home: '/Users/test', env: {}, ...extra });

test('Windows GPU and M1 CPU profiles share a multilingual offline interface; Intel Mac and Rosetta are rejected', () => {
  const win = createSpeechPlatform({ id: 'win32', arch: 'x64' });
  assert.equal(win.profile.device, 'cuda'); assert.equal(win.profile.computeType, 'float16');
  assert.equal(mac().profile.device, 'cpu'); assert.equal(mac().profile.computeType, 'int8');
  for (const [id, arch] of [['darwin', 'x64'], ['win32', 'arm64'], ['linux', 'x64']]) {
    const p = createSpeechPlatform({ id, arch }); assert.equal(p.profile.supported, false);
    assert.throws(() => p.requireSupported(), e => e.code === 'SPEECH_PLATFORM_UNSUPPORTED');
  }
});

test('M1 discovery uses native macOS paths and ignores copied Windows settings and credentials', () => {
  const p = mac({ env: { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/test', DEEPSEEK_API_KEY: 'fixture',
    NOTION_TOKEN: 'fixture', CUDA_PATH: 'C:\\cuda', PYTHONPATH: '/untrusted' }, fsImpl: {
    readFileSync: () => JSON.stringify({ runtime: { pythonExecutable: 'C:\\python.exe', modelDirectory: 'C:\\models', dllDirectory: 'C:\\cuda' } }),
    readdirSync: () => ['3.11.15'], existsSync: () => true
  } });
  const candidates = p.candidates('/project/.notion-switch');
  assert.ok(candidates.includes('/project/.notion-switch/speech/python/bin/python3'));
  assert.ok(candidates.includes('/opt/homebrew/bin/python3'));
  assert.ok(candidates.includes('/Users/test/.pyenv/versions/3.11.15/bin/python3'));
  assert.ok(candidates.every(v => v.startsWith('/') && !v.includes('python.exe')));
  const env = p.environment('/project/.notion-switch'); assert.equal(env.HOME, '/Users/test');
  assert.equal(env.HF_HUB_OFFLINE, '1');
  for (const key of ['DEEPSEEK_API_KEY', 'NOTION_TOKEN', 'CUDA_PATH', 'CUDA_CACHE_PATH', 'PYTHONPATH']) assert.equal(env[key], undefined);
});

test('discovery rejects a Rosetta Python report and continues to a native ARM64 runtime', async () => {
  const p = mac({ env: { PATH: '/opt/homebrew/bin:/usr/bin' }, fsImpl: { readFileSync() { throw Error(); }, readdirSync: () => [], existsSync: () => true } });
  const calls = [];
  const result = await discovery.discover('/local', { platform: p, execFileImpl: (exe, args, options, callback) => {
    calls.push({ exe, args, options });
    callback(null, JSON.stringify({ ok: true, runtime: { ...macRuntime, architecture: calls.length === 1 ? 'x64' : 'arm64' } }));
  } });
  assert.equal(result.device, 'cpu'); assert.equal(result.architecture, 'arm64'); assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.args.includes('--discover') && c.options.env.HF_HUB_OFFLINE === '1'));
});

function fixture(t, reply = value => value) {
  const children = [], requests = [], parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-speech-platform-'));
  const provider = new speech.SpeechProvider({ root, runtime: macRuntime, platform: mac(), spawnImpl: (exe, args, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', 0)); };
    child.stdin = { write: (line, _encoding, cb) => {
      const input = JSON.parse(line); requests.push(input);
      const result = input.type === 'configure' ? reply({ protocolVersion: 1, provider: 'faster-whisper', model: 'medium', ...input.runtime })
        : input.type === 'probe' ? { ready: true } : { text: 'M1 中文 English' };
      queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: input.id, ok: true, result }) + '\n')); cb?.();
    } };
    children.push({ exe, args, options, child }); return child;
  } });
  t.after(() => { provider.close(); assert.equal(path.dirname(path.resolve(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return { provider, children, requests, root };
}

test('same provider interface configures a native M1 worker and returns Chinese/English without CUDA assumptions', async t => {
  const f = fixture(t); f.provider.retain(); await f.provider.probe();
  const status = f.provider.status(); assert.equal(status.device, 'cpu'); assert.equal(status.computeType, 'int8');
  assert.equal(status.platform, 'darwin'); assert.equal(status.protocolVersion, 1); assert.equal(status.loaded, true);
  assert.equal(await f.provider.transcribe({ pcm: Buffer.alloc(16000 * 4), language: 'auto' }), 'M1 中文 English');
  assert.equal(f.children.length, 1); assert.equal(f.children[0].exe, macRuntime.pythonExecutable);
  assert.equal(f.requests[0].runtime.dllDirectory, null); assert.equal(f.requests[0].runtime.cpuThreads, 4);
  assert.equal(f.children[0].options.env.CUDA_CACHE_PATH, undefined);
});

test('a worker announcing CUDA or the wrong protocol is stopped before any audio is sent', async t => {
  for (const reply of [value => ({ ...value, device: 'cuda' }), value => ({ ...value, protocolVersion: 2 })]) {
    const f = fixture(t, reply);
    await assert.rejects(f.provider.transcribe({ pcm: Buffer.alloc(64000) }), /版本或平台不匹配/);
    assert.equal(f.children[0].child.killed, true); assert.equal(f.requests.some(r => r.type === 'transcribe'), false);
  }
});

test('copied Windows runtime is discarded and replaced through the platform discovery seam', async () => {
  let detected = 0;
  const provider = new speech.SpeechProvider({ root: path.resolve('.notion-switch'), platform: mac(),
    runtime: { pythonExecutable: 'C:\\python.exe', modelDirectory: 'C:\\model', device: 'cuda' },
    discoverImpl: async (_root, { platform }) => { detected++; assert.equal(platform.profile.device, 'cpu'); return macRuntime; } });
  try { assert.equal(provider.status().configured, false); await provider.configure(); assert.equal(detected, 1); assert.equal(provider.runtime.device, 'cpu'); }
  finally { provider.close(); }
});

test('settings persist only the current platform profile and present M1 CPU status without paths', async t => {
  const f = fixture(t), service = new settings.SpeechSettings({ root: f.root, provider: f.provider });
  const result = await service.request('speech.prepare'); assert.equal(result.ok, true, result.error);
  assert.ok(result.result.message.includes('Apple Silicon CPU'));
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'speech.local.json'), 'utf8'));
  assert.equal(saved.version, 2); assert.equal(saved.device, 'cpu'); assert.equal(saved.architecture, 'arm64');
  assert.equal(saved.computeType, 'int8'); assert.ok(!JSON.stringify(service.status()).includes('/Users/test'));
});
