import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import downloads from '../src/speech/download.cjs';
import installer from '../src/speech/install.cjs';
import platforms from '../src/speech/platform.cjs';
import settings from '../src/speech/settings.cjs';
function directory(t) {
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'test-speech-setup-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); }); return root;
}
test('setup downloads only from verified release hosts, checks the digest and removes failed partials', async t => {
  const root = directory(t), body = Buffer.from('fixture verified archive'), sha256 = createHash('sha256').update(body).digest('hex'), file = path.join(root, 'uv.zip');
  await downloads.download({ url: 'https://github.com/astral-sh/uv/releases/download/fixture/uv.zip', file, sha256,
    fetchImpl: async () => new Response(body) }); assert.deepEqual(fs.readFileSync(file), body);
  await assert.rejects(downloads.download({ url: 'https://github.com/fixture', file: file + '.bad', sha256: '0'.repeat(64), fetchImpl: async () => new Response(body) }), /校验失败/);
  assert.equal(fs.existsSync(file + '.bad'), false); assert.equal(fs.existsSync(file + '.bad.partial'), false);
  let calls = 0;
  await assert.rejects(downloads.download({ url: 'https://github.com/fixture', file, sha256,
    fetchImpl: async () => { calls++; return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/private' } }); } }), /发行站点/);
  assert.equal(calls, 1);
});
test('model download progress reports resumed bytes and rejects invalid child output', async () => {
  const received = [];
  const script = `process.stdout.write('SWITCH_NOTION_PRO');
    process.stdout.write('GRESS {"received":40,"total":100,"bytesPerSecond":12}\\n');
    console.log('SWITCH_NOTION_PROGRESS {"received":101,"total":100,"bytesPerSecond":3}');
    console.log('SWITCH_NOTION_PROGRESS not-json');`;
  await installer.run(process.execPath, ['-e', script], { onProgress: value => received.push(value) });
  assert.deepEqual(received, [{ received: 40, total: 100, bytesPerSecond: 12 }]);
});
test('model preparation reports resumed progress and keeps the existing snapshot download', t => {
  const root = directory(t), modules = path.join(root, 'modules');
  fs.mkdirSync(path.join(modules, 'tqdm'), { recursive: true });
  fs.writeFileSync(path.join(modules, 'tqdm', '__init__.py'), '');
  fs.writeFileSync(path.join(modules, 'tqdm', 'auto.py'), `class tqdm:
    def __init__(self, *args, **kwargs): self.n = kwargs.get('initial', 0); self.total = kwargs.get('total')
    def update(self, amount=1): self.n += amount
    def close(self): pass
`);
  fs.writeFileSync(path.join(modules, 'huggingface_hub.py'), `from pathlib import Path
def hf_hub_download(repo, filename, revision, local_dir, token, tqdm_class):
    assert filename == 'model.bin' and not token
    bar = tqdm_class(total=100, initial=40, name='test'); bar.update(60); bar.close()
def snapshot_download(repo, revision, local_dir, allow_patterns, token):
    assert 'model.bin' in allow_patterns and not token
    Path(local_dir).mkdir(parents=True, exist_ok=True)
    (Path(local_dir) / 'snapshot-called').touch()
`);
  const result = spawnSync('python3', [path.resolve('src/speech/managed_prepare.py'), '--root', root], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: modules } });
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line.replace('SWITCH_NOTION_PROGRESS ', '')));
  assert.equal(events[0].received, 40); assert.equal(events.at(-1).received, 100); assert.equal(events.at(-1).total, 100);
  assert.ok(fs.existsSync(path.join(root, 'speech/faster-whisper-medium/snapshot-called')));
});
for (const id of ['win32', 'darwin']) test(`${id} missing environment setup keeps all files local and selects only its own dependencies`, async t => {
  const root = directory(t), calls = [], progress = []; let discoveries = 0;
  const platform = platforms.createSpeechPlatform({ id, arch: id === 'win32' ? 'x64' : 'arm64', env: { PATH: '', DEEPSEEK_API_KEY: 'fixture-secret', NOTION_TOKEN: 'fixture-token' } });
  const selected = installer.UV[id];
  const result = await installer.install({ root, platform, onProgress: p => progress.push(p),
    downloadImpl: async ({ file, sha256 }) => { assert.equal(sha256, selected.digest); fs.writeFileSync(file, 'fixture archive'); },
    runImpl: async (exe, args, { env }) => {
      calls.push({ exe, args, env });
      assert.equal(env.DEEPSEEK_API_KEY, undefined); assert.equal(env.NOTION_TOKEN, undefined);
      assert.ok(env.UV_CACHE_DIR.startsWith(root)); assert.ok(env.HF_HOME.startsWith(root));
      if (exe === 'powershell.exe' || exe === '/usr/bin/tar') {
        const file = path.join(root, 'speech/tools/uv-0.13.5', selected.executable); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture uv');
      }
    }, discoverImpl: async () => { discoveries++; if (id === 'win32' && discoveries === 1) throw Object.assign(Error('missing CUDA'), { code: 'SPEECH_RUNTIME_NOT_FOUND' }); return { configured: true }; } });
  assert.equal(result.configured, true); assert.ok(progress.some(p => p.message.includes('Medium')));
  assert.equal(calls.some(c => c.args.some(a => a.startsWith('nvidia-cudnn'))), id === 'win32');
  assert.equal(calls.some(c => c.exe === 'powershell.exe'), id === 'win32');
});
test('preparing reuses an existing runtime and auto-installs exactly once when discovery reports missing components', async t => {
  const root = directory(t), runtime = { pythonExecutable: path.join(root, 'python.exe'), modelDirectory: path.join(root, 'model') }; let installed = 0;
  const p = { runtime: null, configure: async () => { if (!p.runtime) throw Object.assign(Error('missing'), { code: 'SPEECH_RUNTIME_NOT_FOUND' }); }, probe: async () => {},
    status: () => ({ configured: !!p.runtime, busy: false, device: 'cuda', provider: 'faster-whisper', model: 'medium' }), close() {} };
  const service = new settings.SpeechSettings({ root, provider: p, runtimeExists: () => true,
    installImpl: async ({ onProgress }) => { installed++; onProgress({ message: 'fixture download' }); return runtime; } });
  assert.equal((await service.request('speech.prepare')).ok, true); assert.equal(installed, 1);
  assert.equal((await service.request('speech.prepare')).ok, true); assert.equal(installed, 1);
  assert.equal((await service.request('speech.test')).ok, false);
});
test('a saved interpreter with missing speech packages is rediscovered before one bounded automatic repair', async t => {
  const root = directory(t), runtime = { pythonExecutable: path.join(root, 'python.exe'), modelDirectory: root }; let installed = 0, probes = 0;
  const p = { runtime, close() {}, configure: async () => { if (!p.runtime) throw Object.assign(Error('missing packages'), { code: 'SPEECH_RUNTIME_NOT_FOUND' }); },
    probe: async () => { if (++probes === 1) throw Error('broken saved environment'); }, status: () => ({ busy: false, configured: !!p.runtime }) };
  const service = new settings.SpeechSettings({ root, provider: p, runtimeExists: () => true, installImpl: async () => { installed++; return runtime; } });
  assert.equal((await service.request('speech.prepare')).ok, true); assert.equal(installed, 1); assert.equal(probes, 2);
});
