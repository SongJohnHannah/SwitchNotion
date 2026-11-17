import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { CollectionMedia } = createRequire(import.meta.url)('../src/collection/media.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mac-transcript-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source with spaces.mp4'); fs.writeFileSync(source, 'media');
  const calls = [], commands = []; let leases = 0;
  const speech = { status: () => ({ model: 'medium', device: 'cpu' }), probe: async () => {},
    retain: () => leases++, release: () => leases--,
    transcribeWav: async options => { calls.push(options); return 'Complete speech ' + calls.length; } };
  const ffmpeg = path.join(root, 'ffmpeg');
  const media = new CollectionMedia({ root, platform: 'darwin', speech, binaries: { find: () => ffmpeg },
    operator: { transcribeFile: () => assert.fail('Mac must not invoke the Windows GPU operator') },
    runImpl: async (file, args, options) => { commands.push({ file, args, options }); fs.writeFileSync(args.at(-1), 'wav'); } });
  return { root, media, speech, calls, commands, ffmpeg, leases: () => leases, asset: { path: source, duration: 65, audio: true, kind: 'video' } };
}
test('Mac uses native FFmpeg and its CPU provider, covers the tail and resumes completed chunks', async t => {
  const f = fixture(t), progress = [];
  const result = await f.media.transcript(f.asset, { language: 'en', progress: value => progress.push(value) });
  assert.equal(result.device, 'cpu'); assert.match(result.text, /Complete speech 1\n\nComplete speech 2/);
  assert.equal(f.commands.length, 2); assert.ok(f.commands.every(c => c.file === f.ffmpeg && !c.file.endsWith('.exe')));
  assert.deepEqual(f.commands.map(c => c.args[c.args.indexOf('-t') + 1]), ['60', '5']);
  assert.ok(f.calls.every(c => c.language === 'en' && c.chunkSeconds === 10)); assert.equal(f.leases(), 0);
  assert.ok(progress.every(value => !value.includes('GPU')));
  assert.equal((await f.media.transcript(f.asset, { language: 'en' })).text, result.text);
  assert.equal(f.calls.length, 2);
  await f.media.transcript(f.asset, { language: 'zh' }); assert.equal(f.calls.length, 4);
  assert.ok(!fs.readdirSync(f.root).some(name => name.endsWith('.wav')));
});
test('Mac failures retain accepted chunks and release the provider; abort never returns cached success', async t => {
  const f = fixture(t); let attempts = 0;
  f.speech.transcribeWav = async () => { if (++attempts === 2) throw Error('worker stopped'); return 'Accepted speech'; };
  await assert.rejects(f.media.transcript(f.asset), /worker stopped/); assert.equal(f.leases(), 0);
  const result = await f.media.transcript(f.asset); assert.equal(attempts, 3); assert.equal(result.device, 'cpu');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.media.transcript(f.asset, { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(attempts, 3); assert.equal(f.leases(), 0);
});
test('Mac stops on unreliable text instead of storing it as a completed checkpoint', async t => {
  const f = fixture(t); f.speech.transcribeWav = async () => '!'.repeat(224);
  await assert.rejects(f.media.transcript(f.asset), error => error.code === 'SPEECH_UNRELIABLE');
  assert.equal(fs.existsSync(path.join(f.root, 'mac-transcript-progress.json')), false); assert.equal(f.leases(), 0);
  assert.equal(new CollectionMedia({ platform: 'darwin' }).operator, null);
});
