import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildVideoRatePlan, plannedNvencEncodingArgs, decideVideoCopyRoute } = require('../src/speech/video-transcode-plan.cjs');
const source = { width: 1920, height: 1080, duration: 2806.061, bytes: 1175308951, videoCodec: 'vp9', audioCodecs: ['opus'],
  pixelFormat: 'yuv420p', container: 'webm' };
test('VBR plans bound bitrate and expected bytes rather than repeating unbounded CQ19 output', () => {
  const plan = buildVideoRatePlan({ source, quality: '1080p', preset: 'p3' });
  assert.equal(plan.videoBitrate, 1800000); assert.equal(plan.audioBitratePerStream, 192000);
  assert.equal(plan.maxrate, 2700000); assert.equal(plan.bufsize, 3600000);
  assert.ok(plan.estimatedOutputBytes < source.bytes); assert.equal(plan.shouldEncodeForCompression, true);
  const args = plannedNvencEncodingArgs(plan);
  assert.equal(args[args.indexOf('-b:v') + 1], '1800000'); assert.equal(args.includes('-cq'), false);
  assert.equal(args[args.indexOf('-preset') + 1], 'p3');
});
test('identity frames bypass redundant scale while 720p plans retain an explicit GPU resize', () => {
  const full = buildVideoRatePlan({ source, quality: '1080p', preset: 'p1' });
  assert.equal(full.scalePolicy, 'identity-bypass'); assert.equal(plannedNvencEncodingArgs(full).includes('-vf'), false);
  const smaller = buildVideoRatePlan({ source, quality: '720p', preset: 'p3' });
  assert.equal(smaller.width, 1280); assert.equal(smaller.height, 720); assert.equal(smaller.videoBitrate, 900000);
  assert.ok(plannedNvencEncodingArgs(smaller).some(value => value.includes('scale_cuda=')));
});
test('GOP forcing is optional and constrained by the requested upload segment budget', () => {
  const ordinary = buildVideoRatePlan({ source, quality: '1080p' });
  assert.equal(ordinary.forceKeyframeSeconds, null); assert.equal(plannedNvencEncodingArgs(ordinary).includes('-force_key_frames'), false);
  const segmented = buildVideoRatePlan({ source, quality: '720p', uploadLimitBytes: 5 * 1024 ** 2 });
  assert.ok(segmented.forceKeyframeSeconds > 2); assert.ok(segmented.forceKeyframeSeconds <= 30);
  assert.ok(plannedNvencEncodingArgs(segmented).includes('-forced-idr'));
});
test('efficient low-bitrate sources do not get a recommendation to encode a larger lossy copy', () => {
  const low = { ...source, bytes: 100000000 };
  const plan = buildVideoRatePlan({ source: low, quality: '1080p' });
  assert.equal(plan.shouldEncodeForCompression, false); assert.equal(plan.recommendedRoute, 'keep-original-or-copy-segments');
});
test('existing WebM routes preserve payloads; MP4 VP9/Opus remux needs explicit playback validation', () => {
  assert.equal(decideVideoCopyRoute({ source }).route, 'keep-original');
  assert.equal(decideVideoCopyRoute({ source, uploadLimitBytes: 5 * 1024 ** 2 }).route, 'copy-segments');
  const mp4 = decideVideoCopyRoute({ source, requireMp4: true });
  assert.equal(mp4.route, 'needs-playback-validation'); assert.equal(mp4.experimentalRemux.codec, 'copy');
  assert.equal(decideVideoCopyRoute({ source, requireMp4: true, codecPlaybackVerified: true }).route, 'remux-copy');
});
test('plans retain original source/rate assumptions and reject unsupported plan knobs', () => {
  const plan = buildVideoRatePlan({ source, quality: '720p' });
  assert.deepEqual(plan.original, source); assert.ok(plan.sourceTotalBitrate > 3000000); assert.equal(plan.visualQualityVerified, false);
  assert.throws(() => buildVideoRatePlan({ source, preset: 'p9' }), /方案/);
  assert.throws(() => buildVideoRatePlan({ source, forceKeyframeSeconds: .1 }), /关键帧/);
  assert.throws(() => plannedNvencEncodingArgs({ ...plan, maxrate: 1 }), /方案/);
  assert.throws(() => plannedNvencEncodingArgs({ ...plan, width: '1280:injected' }), /方案/);
  assert.throws(() => decideVideoCopyRoute({ source, uploadLimitBytes: -1 }), /参数/);
});
