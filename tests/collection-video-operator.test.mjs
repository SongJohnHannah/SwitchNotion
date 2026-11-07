import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { CollectionMedia } = require('../src/collection/media.cjs');

function fixture(t, { sourceBytes = 1000, outputBytes = 400, transcode, run, extension = '.mp4' } = {}) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'collection-video-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, 'original' + extension); fs.writeFileSync(source, Buffer.alloc(sourceBytes, 1));
  const calls = [], processes = [];
  const media = new CollectionMedia({ root, platform: 'win32', binaries: { find: () => '/mock/ffmpeg' }, operator: {
    transcodeVideo: async options => {
      calls.push(options); if (transcode) return transcode(options);
      const recordDirectory = path.join(options.outputDirectory, 'owned-' + calls.length); fs.mkdirSync(recordDirectory, { recursive: true });
      const output = path.join(recordDirectory, 'output.mp4'); fs.writeFileSync(output, Buffer.alloc(outputBytes, 2));
      return { path: output, recordDirectory, engine: 'h264_nvenc', decodeEngine: 'h264_cuvid', complete: true, quality: options.quality,
        nvenc: { forcedIdr: options.forceKeyframeSeconds !== undefined, forceKeyframeSeconds: options.forceKeyframeSeconds ?? null } };
    }
  }, runImpl: async (file, args, options) => { processes.push({ file, args, options }); if (run) return run(file, args, options); assert.fail('software processing must not run'); } });
  media.probe = async () => ({ duration: 60, audio: true, video: true, width: 1920, height: 1080 });
  return { root, source, media, calls, processes, asset: { path: source, kind: 'video', audio: true, duration: 60, bytes: sourceBytes, width: 1920, height: 1080 } };
}

test('Windows compression delegates original dimensions as lossy NVENC with hardware decoding and retains the source', async t => {
  const f = fixture(t), controller = new AbortController(), progress = [];
  const result = await f.media.prepareUpload(f.asset, { compress: true, quality: 'original' }, 5000, { signal: controller.signal, progress: value => progress.push(value) });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].source, f.source); assert.equal(f.calls[0].quality, 'original');
  assert.equal(f.calls[0].hardwareDecode, true); assert.equal(f.calls[0].signal, controller.signal);
  assert.notEqual(result[0].path, f.source); assert.equal(result[0].transcodes[0].engine, 'h264_nvenc');
  assert.ok(progress.some(value => /有损|非无损/.test(value))); assert.equal(fs.statSync(f.source).size, 1000); assert.equal(f.processes.length, 0);
});

test('a larger NVENC result is retained for diagnosis and the original stays the upload choice', async t => {
  const f = fixture(t, { outputBytes: 1200 });
  const result = await f.media.prepareUpload(f.asset, { compress: true, quality: 'original' }, 5000);
  assert.equal(result[0].path, f.source); assert.equal(result[0].transcodes[0].accepted, false);
  assert.ok(fs.existsSync(result[0].transcodes[0].path)); assert.equal(fs.statSync(f.source).size, 1000);
});

test('GPU failures preserve the original and stop instead of running libx264', async t => {
  const failure = Error('NVDEC is not supported'); const f = fixture(t, { transcode: async () => { throw failure; } });
  await assert.rejects(f.media.prepareUpload(f.asset, { compress: true, quality: 'original' }, 5000), error => error === failure);
  assert.equal(f.calls.length, 1); assert.equal(f.processes.length, 0); assert.equal(fs.statSync(f.source).size, 1000);
});

test('uncompressed files and already efficient video bypass the GPU encoder', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.media.prepareUpload(f.asset, { compress: false, quality: '720p' }, 5000), [{ path: f.source, kind: 'video' }]);
  const efficient = { ...f.asset, width: 1280, height: 720 };
  assert.deepEqual(await f.media.prepareUpload(efficient, { compress: true, quality: '720p' }, 5000), [{ path: f.source, kind: 'video' }]);
  assert.equal(f.calls.length, 0); assert.equal(f.processes.length, 0);
});

test('a container-only change keeps stream-copy priority without invoking GPU or software video encoding', async t => {
  const f = fixture(t, { extension: '.mkv', run: async (_file, args) => {
    assert.ok(args.includes('copy')); assert.ok(!args.includes('libx264')); fs.writeFileSync(args.at(-1), Buffer.alloc(1000));
  } });
  const result = await f.media.prepareUpload(f.asset, { compress: false, quality: 'original' }, 5000);
  assert.equal(f.calls.length, 0); assert.equal(f.processes.length, 1); assert.equal(path.extname(result[0].path), '.mp4');
  assert.equal(fs.statSync(f.source).size, 1000);
});

test('Mac compression retains its existing software path and never invokes the Windows-only operator', async t => {
  const f = fixture(t, { run: async (_file, args) => {
    assert.ok(args.includes('libx264')); fs.writeFileSync(args.at(-1), Buffer.alloc(400));
  } }); f.media.platform = 'darwin';
  const result = await f.media.prepareUpload(f.asset, { compress: true, quality: 'original' }, 5000);
  assert.equal(f.calls.length, 0); assert.equal(f.processes.length, 1); assert.notEqual(result[0].path, f.source);
});

test('oversized videos try stream-copy first, then shared GPU keyframes and copy segmentation with no CPU encoder', async t => {
  let segments = 0;
  const f = fixture(t, { outputBytes: 600, run: async (_file, args) => {
    assert.ok(args.includes('copy')); assert.ok(!args.includes('libx264'));
    const pattern = args.at(-1); segments++;
    fs.writeFileSync(pattern.replace('%04d', '0000'), Buffer.alloc(segments === 1 ? 200 : 80));
    if (segments > 1) fs.writeFileSync(pattern.replace('%04d', '0001'), Buffer.alloc(80));
  } });
  f.media.probe = async file => ({ duration: path.basename(file).startsWith('part-') ? 30 : 60, audio: true, video: true });
  const result = await f.media.prepareUpload(f.asset, { compress: false, quality: '720p' }, 100);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].source, f.source); assert.equal(f.calls[0].hardwareDecode, true);
  assert.equal(f.calls[0].quality, 'original');
  assert.ok(f.calls[0].forceKeyframeSeconds >= .25 && f.calls[0].forceKeyframeSeconds <= 2);
  assert.equal(segments, 2); assert.equal(result.length, 2); assert.ok(result.every(item => fs.statSync(item.path).size <= 100));
});

test('an oversized GPU-keyframed copy result fails clearly and preserves source instead of CPU fallback', async t => {
  const f = fixture(t, { outputBytes: 600, run: async (_file, args) => {
    assert.ok(!args.includes('libx264')); fs.writeFileSync(args.at(-1).replace('%04d', '0000'), Buffer.alloc(200));
  } });
  await assert.rejects(f.media.prepareUpload(f.asset, { compress: false, quality: '720p' }, 100), /GPU.*分段|分段.*GPU/);
  assert.equal(f.calls.length, 1); assert.equal(fs.statSync(f.source).size, 1000);
});
