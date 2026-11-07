import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { GpuOperatorClient } = require('../src/speech/operator-client.cjs');

function fixture(t, transcode) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'operator-video-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, 'source.mp4'); fs.writeFileSync(source, 'original'); const calls = [];
  const client = new GpuOperatorClient({ root, directory: path.join(root, 'bundle'), loader: () => ({ transcribeFile() {}, transcodeVideo: async options => {
    calls.push(options); if (transcode) return transcode(options);
    const recordDirectory = path.join(options.outputDirectory, 'owned-' + calls.length); fs.mkdirSync(recordDirectory, { recursive: true });
    const output = path.join(recordDirectory, 'output.mp4'); fs.writeFileSync(output, 'nvenc-result');
    return { path: output, recordDirectory, engine: 'h264_nvenc', decodeEngine: options.hardwareDecode ? 'vp9_cuvid' : 'software', complete: true,
      nvenc: { forcedIdr: options.forceKeyframeSeconds !== undefined, forceKeyframeSeconds: options.forceKeyframeSeconds ?? null } };
  } }) });
  return { root, source, client, calls };
}

test('video adapter forwards to the same package with NVDEC default, explicit decoder override, keyframes and abort signal', async t => {
  const { root, source, client, calls } = fixture(t), controller = new AbortController(), onProgress = () => {};
  const result = await client.transcodeVideo({ source, quality: '1080p', forceKeyframeSeconds: 2, signal: controller.signal, onProgress });
  assert.equal(calls[0].source, source); assert.equal(calls[0].hardwareDecode, true); assert.equal(calls[0].quality, '1080p');
  assert.equal(calls[0].forceKeyframeSeconds, 2); assert.equal(calls[0].signal, controller.signal); assert.equal(calls[0].onProgress, onProgress);
  assert.equal(result.engine, 'h264_nvenc'); assert.ok(result.outputDirectory.startsWith(path.join(root, 'collection', 'video-transcodes')));
  await client.transcodeVideo({ source, hardwareDecode: false }); assert.equal(calls[1].hardwareDecode, false);
  assert.equal(fs.readFileSync(source, 'utf8'), 'original');
});

test('a silent CPU encoder or decoder fallback is rejected instead of returning a successful video', async t => {
  for (const result of [{ complete: true, engine: 'libx264', decodeEngine: 'vp9_cuvid' }, { complete: true, engine: 'h264_nvenc', decodeEngine: 'software' }]) {
    const { source, client, calls } = fixture(t, async () => result);
    await assert.rejects(client.transcodeVideo({ source }), /NVENC\/NVDEC.*未改用 CPU/); assert.equal(calls.length, 1);
  }
});

test('requested keyframes need exact execution metadata instead of being assumed from request parameters', async t => {
  for (const nvenc of [undefined, { forcedIdr: false, forceKeyframeSeconds: 2 }, { forcedIdr: true, forceKeyframeSeconds: 1 }]) {
    const { source, client } = fixture(t, async () => ({ complete: true, engine: 'h264_nvenc', decodeEngine: 'vp9_cuvid', nvenc }));
    await assert.rejects(client.transcodeVideo({ source, forceKeyframeSeconds: 2 }), /关键帧间隔/);
  }
});

test('video operator errors and aborts propagate without retries and invalid keyframe parameters never reach the operator', async t => {
  const failure = Error('NVDEC hardware unavailable'); const { source, client, calls } = fixture(t, async () => { throw failure; });
  await assert.rejects(client.transcodeVideo({ source }), error => error === failure); assert.equal(calls.length, 1);
  for (const forceKeyframeSeconds of [0, .2, 601, NaN, '1']) await assert.rejects(client.transcodeVideo({ source, forceKeyframeSeconds }), /参数无效/);
  assert.equal(calls.length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.transcodeVideo({ source, signal: controller.signal }), error => error.name === 'AbortError'); assert.equal(calls.length, 1);
});

test('output outside the owned archive is rejected even when the engine metadata claims NVENC success', async t => {
  let sourcePath;
  const { source, client } = fixture(t, async options => {
    fs.mkdirSync(options.outputDirectory, { recursive: true }); const recordDirectory = path.join(options.outputDirectory, 'records'); fs.mkdirSync(recordDirectory);
    return { path: sourcePath, recordDirectory, complete: true, engine: 'h264_nvenc', decodeEngine: 'vp9_cuvid' };
  }); sourcePath = source;
  await assert.rejects(client.transcodeVideo({ source }), /不在本次归档目录|与原片重合/);
});
