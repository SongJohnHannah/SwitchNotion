import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runVideoOptimizationBenchmark } from '../scripts/benchmark-video-optimization.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-plan-bench-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const bundle = path.join(directory, 'bundle'); fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, 'machine.json'), JSON.stringify({ resourcesRoot: 'resources', ffmpeg: 'bin/ffmpeg.exe', ffprobe: 'bin/ffprobe.exe' }));
  const source = path.join(directory, 'original.webm'); fs.writeFileSync(source, Buffer.alloc(1000000, 7));
  const sourceProbe = { format: { duration: '60', format_name: 'matroska,webm' }, streams: [
    { index: 0, codec_type: 'video', codec_name: 'vp9', width: 1920, height: 1080, pix_fmt: 'yuv420p', sample_aspect_ratio: '1:1' },
    { index: 1, codec_type: 'audio', codec_name: 'opus', duration: '60' },
  ] };
  let held = false, releases = 0; const calls = [];
  const runImpl = async (file, args, options) => {
    calls.push({ file, args, kind: options.kind, held });
    if (options.kind === 'probe-source') return { code: 0, stdout: JSON.stringify(sourceProbe) };
    assert.equal(held, true);
    if (options.kind === 'work') { fs.writeFileSync(args.at(-1), Buffer.alloc(100000)); return { code: 0, stdout: 'frame=1800\nout_time_us=60000000\nprogress=end\n' }; }
    if (options.kind === 'probe-output') {
      const nvenc = calls.find(row => row.kind === 'work').args.includes('h264_nvenc');
      return { code: 0, stdout: JSON.stringify({ format: { duration: '60', format_name: 'mov,mp4' }, streams: [
        { ...sourceProbe.streams[0], codec_name: nvenc ? 'h264' : 'vp9' },
        { ...sourceProbe.streams[1], codec_name: nvenc ? 'aac' : 'opus' },
      ] }) };
    }
    return { code: 0, stdout: '0,v,SHA256=' + 'a'.repeat(64) + '\n1,a,SHA256=' + 'b'.repeat(64) + '\n' };
  };
  const options = { source, bundle, outputDirectory: path.join(directory, 'bench'), candidate: 'p3-1080p', runImpl,
    leaseFactory: async () => { held = true; return { release: async () => { held = false; releases++; } }; } };
  return { directory, source, sourceProbe, options, calls, released: () => releases };
}
test('a single NVENC candidate records bounded VBR parameters and never claims visual validation', async t => {
  const f = fixture(t), result = await runVideoOptimizationBenchmark(f.options);
  const work = f.calls.find(row => row.kind === 'work');
  assert.ok(work.args.includes('h264_nvenc')); assert.equal(work.args.includes('-cq'), false);
  assert.equal(work.args[work.args.indexOf('-preset') + 1], 'p3'); assert.equal(result.engine, 'h264_nvenc');
  assert.equal(result.visualQualityVerified, false); assert.equal(result.promotionEligible, false);
  assert.equal(result.complete, true); assert.equal(f.released(), 1);
  assert.equal(fs.statSync(f.source).size, 1000000);
  assert.ok(fs.existsSync(path.join(f.options.outputDirectory, 'plan.json')));
});
test('copy/remux uses no hardware codec and checks payload plus decoded audio before publishing', async t => {
  const f = fixture(t), result = await runVideoOptimizationBenchmark({ ...f.options, candidate: 'remux-mp4' });
  const work = f.calls.find(row => row.kind === 'work'); assert.ok(work.args.includes('copy'));
  assert.equal(work.args.includes('h264_nvenc'), false); assert.equal(work.args.includes('-hwaccel'), false);
  assert.equal(result.gpuUsed, false); assert.equal(result.streamPayloadEqual, true); assert.equal(result.decodedAudioEqual, true);
  assert.equal(result.playbackStatus, 'unverified-codec-container-pair'); assert.equal(result.promotionEligible, false);
  assert.equal(f.released(), 1);
});
test('a payload mismatch preserves files and failure records but cannot publish success', async t => {
  const f = fixture(t), originalRun = f.options.runImpl;
  f.options.runImpl = async (file, args, options) => options.kind === 'hash-output' ? { code: 0, stdout: '0,v,SHA256=' + 'c'.repeat(64) + '\n' } : originalRun(file, args, options);
  await assert.rejects(runVideoOptimizationBenchmark({ ...f.options, candidate: 'remux-mp4' }), /码流/);
  assert.equal(fs.existsSync(path.join(f.options.outputDirectory, 'result.json')), false);
  assert.ok(fs.existsSync(path.join(f.options.outputDirectory, 'failure.json'))); assert.equal(f.released(), 1);
});
test('plan-only and source-reuse do not start encoding or load GPU models', async t => {
  const f = fixture(t), planned = await runVideoOptimizationBenchmark({ ...f.options, planOnly: true });
  assert.equal(planned.planOnly, true); assert.equal(f.calls.some(row => row.kind === 'work'), false); assert.equal(f.released(), 0);
  const second = fixture(t), reused = await runVideoOptimizationBenchmark({ ...second.options, candidate: 'copy-original' });
  assert.equal(reused.path, second.source); assert.equal(reused.engine, 'source-reuse'); assert.equal(reused.comparableToReencode, false);
  assert.equal(second.calls.some(row => row.kind === 'work'), false);
});
