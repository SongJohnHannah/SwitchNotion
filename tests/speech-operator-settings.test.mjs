import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { SpeechSettings } = require('../src/speech/settings.cjs');
const { SpeechProvider } = require('../src/speech/provider.cjs');
const { createSpeechPlatform } = require('../src/speech/platform.cjs');

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'speech-operator-settings-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function session() {
  const calls = []; let loaded = false;
  const provider = { runtime: { model: 'large-v3-turbo', pythonExecutable: 'bundle-python', modelDirectory: 'bundle-model' }, leases: 0, calls,
    status: () => ({ model: 'large-v3-turbo', device: 'cuda', hardwareLabel: 'NVIDIA GPU', supported: true, configured: true, ready: loaded, loaded, busy: false }),
    configure: async options => { calls.push(['configure', options]); }, probe: async options => { calls.push(['probe', options]); loaded = true; },
    close: () => { calls.push(['close']); loaded = false; }, retain() { this.leases++; }, release() { this.leases--; },
    transcribeRecording: async ({ signal }) => { signal.throwIfAborted(); calls.push(['recording']); return 'GPU test'; } };
  return provider;
}

test('Windows default uses the standalone session and ignores old Medium runtime without constructing the legacy provider', async t => {
  const root = fixture(t), provider = session(); fs.writeFileSync(path.join(root, 'speech.local.json'), JSON.stringify({ model: 'medium', runtime: { pythonExecutable: 'old-cuda' } }));
  let created = 0;
  const service = new SpeechSettings({ root, platform: 'win32', operatorSessionFactory: () => { created++; return provider; },
    legacyProviderFactory: () => assert.fail('legacy SpeechProvider must not be constructed'), installImpl: () => assert.fail('old environment must not be installed') });
  assert.equal(service.provider, provider); assert.equal(created, 1); assert.equal(service.status().modelLocked, true);
  assert.equal(service.status().engineName, '本项目内置 GPU 算子');
  assert.equal(service.status().model, 'large-v3-turbo'); assert.equal(service.status().loaded, false);
  assert.deepEqual(service.status().modelOptions.map(option => option.id), ['large-v3-turbo']);
  assert.equal((await service.request('speech.prepare')).ok, true); assert.deepEqual(provider.calls.map(call => call[0]), ['configure', 'probe']);
  assert.ok(provider.calls.every(call => call[1].signal instanceof AbortSignal));
  const rejectedModel = await service.request('speech.save', { enabled: false, model: 'medium' });
  assert.equal(rejectedModel.ok, false); assert.match(rejectedModel.error, /本项目内置 GPU 算子.*Large-v3 Turbo/);
});

test('a missing standalone session fails explicitly without installation, CPU fallback or repeated legacy repair', async t => {
  const root = fixture(t), provider = session(), failure = Object.assign(Error('独立 GPU 算子不存在'), { code: 'GPU_OPERATOR_UNAVAILABLE' });
  provider.runtime = null; provider.configure = async () => { provider.calls.push(['configure']); throw failure; };
  const service = new SpeechSettings({ root, platform: 'win32', operatorSessionFactory: () => provider,
    legacyProviderFactory: () => assert.fail('missing Windows operator must not construct a CPU/legacy provider'),
    installImpl: () => assert.fail('no legacy installer'), runtimeExists: () => assert.fail('no legacy runtime check') });
  const result = await service.request('speech.prepare'); assert.equal(result.ok, false); assert.match(result.error, /独立 GPU 算子不存在/);
  assert.deepEqual(provider.calls.map(call => call[0]), ['configure']); assert.match(service.status().lastError, /独立 GPU/);
});

// Exercises the original provider protocol using a fake child, not Python,
// Mac hardware or any Windows operator. Platform paths remain POSIX on Windows.
function macProvider(options, calls, discoverImpl) {
  const platform = createSpeechPlatform({ id: 'darwin', arch: 'arm64', model: options.model, home: '/Users/fixture', env: {} });
  return new SpeechProvider({ ...options, platform, discoverImpl, spawnImpl: (executable, args, spawnOptions) => {
    calls.push({ executable, args, env: spawnOptions.env });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); };
    child.stdin = { write(line, _encoding, callback) {
      const request = JSON.parse(line); calls.push({ request });
      const result = request.type === 'configure' ? { ...platform.profile, ...request.runtime, protocolVersion: 1 }
        : request.type === 'probe' ? { ready: true } : { text: 'Mac 中文 English', language: 'en' };
      queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: request.id, ok: true, result }) + '\n')); callback?.();
    } };
    return child;
  } });
}

test('Darwin keeps the saved Medium CPU runtime and original provider through prepare, transcription and save without loading a Windows operator', async t => {
  const root = fixture(t), calls = [];
  const runtime = { model: 'medium', platform: 'darwin', architecture: 'arm64', device: 'cpu', computeType: 'int8',
    pythonExecutable: '/Users/fixture/chosen-asr/bin/python3', modelDirectory: '/Users/fixture/chosen-models/medium' };
  fs.writeFileSync(path.join(root, 'speech.local.json'), JSON.stringify({ model: 'medium', runtime }));
  const service = new SpeechSettings({ root, platform: 'darwin',
    operatorSessionFactory: () => assert.fail('Darwin must never load or prepare the Windows operator'),
    legacyProviderFactory: options => { assert.deepEqual(options.runtime, runtime); assert.equal(options.model, 'medium'); return macProvider(options, calls, () => assert.fail('existing Mac runtime must be reused')); },
    runtimeExists: selected => { assert.equal(selected.pythonExecutable, runtime.pythonExecutable); return true; },
    installImpl: () => assert.fail('existing Mac runtime must not install Windows or Mac dependencies') });
  t.after(() => service.close());
  const before = service.status();
  assert.equal(before.model, 'medium'); assert.equal(before.device, 'cpu'); assert.equal(before.computeType, 'int8');
  assert.equal(before.modelLocked, false); assert.equal(before.engineName, 'faster-whisper');
  assert.equal(before.loaded, false); assert.equal(calls.length, 0);
  assert.deepEqual(before.modelOptions.map(option => option.id).sort(), ['large-v3-turbo', 'medium']);
  const prepared = await service.request('speech.prepare'); assert.equal(prepared.ok, true, prepared.error);
  assert.match(prepared.result.message, /Medium.*Apple Silicon CPU/);
  assert.equal(await service.provider.transcribe({ pcm: Buffer.alloc(64000), language: 'auto' }), 'Mac 中文 English');
  const saved = await service.request('speech.save', { enabled: true, model: 'medium' }); assert.equal(saved.ok, true, saved.error);
  const disk = JSON.parse(fs.readFileSync(path.join(root, 'speech.local.json'), 'utf8'));
  assert.equal(disk.runtime.pythonExecutable, runtime.pythonExecutable); assert.equal(disk.runtime.modelDirectory, runtime.modelDirectory);
  assert.equal(disk.platform, 'darwin'); assert.equal(disk.device, 'cpu'); assert.equal(disk.model, 'medium');
  assert.equal(calls[0].executable, runtime.pythonExecutable);
  for (const key of ['CUDA_PATH', 'CUDA_CACHE_PATH', 'CT2_CUDA_TRUE_FP16_GEMM', 'NOTION_SWITCH_CT2_MODULE_PATH']) assert.equal(calls[0].env[key], undefined);
  assert.equal(calls.find(call => call.request?.type === 'transcribe').request.language, 'auto');
});

test('Darwin model selection still discovers or installs the selected Mac model and persists its Mac paths without GPU preparation', async t => {
  const root = fixture(t), calls = []; let installs = 0;
  const service = new SpeechSettings({ root, platform: 'darwin',
    operatorSessionFactory: () => assert.fail('Darwin model changes must not invoke the Windows loader'),
    legacyProviderFactory: options => macProvider(options, calls, async (_root, { platform }) => {
      assert.equal(platform.profile.platform, 'darwin'); assert.equal(platform.profile.device, 'cpu');
      throw Object.assign(Error('Mac runtime missing'), { code: 'SPEECH_RUNTIME_NOT_FOUND' });
    }), runtimeExists: () => true,
    installImpl: async ({ root: selectedRoot, platform, signal, onProgress }) => {
      installs++; assert.equal(selectedRoot, root); assert.equal(signal.aborted, false);
      assert.equal(platform.profile.platform, 'darwin'); assert.equal(platform.profile.device, 'cpu');
      assert.equal(platform.profile.computeType, 'int8'); assert.equal(platform.profile.model, 'large-v3-turbo');
      onProgress({ message: 'Mac fixture installation' });
      return { ...platform.profile, pythonExecutable: '/Users/fixture/asr/bin/python3', modelDirectory: '/Users/fixture/models/large-v3-turbo' };
    } });
  t.after(() => service.close());
  const result = await service.request('speech.save', { enabled: true, model: 'large-v3-turbo' });
  assert.equal(result.ok, true, result.error); assert.equal(installs, 1);
  assert.equal(service.status().modelLocked, false); assert.equal(service.status().model, 'large-v3-turbo');
  const disk = JSON.parse(fs.readFileSync(path.join(root, 'speech.local.json'), 'utf8'));
  assert.equal(disk.device, 'cpu'); assert.equal(disk.architecture, 'arm64'); assert.equal(disk.model, 'large-v3-turbo');
  assert.equal(disk.runtime.pythonExecutable, '/Users/fixture/asr/bin/python3');
  assert.equal(disk.runtime.modelDirectory, '/Users/fixture/models/large-v3-turbo');
});

test('Mac default and injected providers retain their previous model selection and preparation behavior', t => {
  const root = fixture(t), provider = session(); let legacy = 0;
  const service = new SpeechSettings({ root, platform: 'darwin', operatorSessionFactory: () => assert.fail('not the Windows session'),
    legacyProviderFactory: options => { legacy++; assert.equal(options.model, 'medium'); return provider; } });
  assert.equal(service.provider, provider); assert.equal(legacy, 1); assert.equal(service.status().modelLocked, false);
  const injected = new SpeechSettings({ root, platform: 'win32', provider, operatorSessionFactory: () => assert.fail('injection must be honored') });
  assert.equal(injected.provider, provider); assert.equal(injected.status().modelLocked, false);
});

test('closing during operator preparation aborts warmup rather than continuing into a background GPU session', async t => {
  const root = fixture(t), provider = session(); let warmSignal;
  provider.probe = ({ signal }) => { warmSignal = signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const service = new SpeechSettings({ root, platform: 'win32', operatorSessionFactory: () => provider });
  const prepared = service.prepare(); const rejected = assert.rejects(prepared, error => error.name === 'AbortError');
  await Promise.resolve(); service.close(); await rejected;
  assert.equal(warmSignal.aborted, true); assert.equal(service.preparing, false); assert.ok(provider.calls.some(call => call[0] === 'close'));
});

test('release waits for the shared session cleanup before reporting that GPU resources were released', async t => {
  const root = fixture(t), provider = session(); let finishClose, done = false;
  provider.close = () => new Promise(resolve => { finishClose = resolve; });
  const service = new SpeechSettings({ root, platform: 'win32', operatorSessionFactory: () => provider });
  const released = service.request('speech.release').then(result => { done = true; return result; });
  await Promise.resolve(); assert.equal(done, false); finishClose(); assert.equal((await released).ok, true);
});
