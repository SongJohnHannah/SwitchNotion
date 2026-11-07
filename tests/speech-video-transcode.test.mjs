import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { transcodeVideo, nvencEncodingArgs, runProcess } = require('../src/speech/video-transcode.cjs');

const probe = (overrides = {}) => ({ format: { duration: '60', format_name: 'matroska,webm' }, streams: [
  { index: 0, codec_type: 'video', codec_name: 'vp9', width: 1920, height: 1080, sample_aspect_ratio: '1:1', duration: '60', ...overrides.video },
  ...Array.from({ length: overrides.audioCount ?? 1 }, (_, n) => ({ index: n + 1, codec_type: 'audio', codec_name: overrides.audioCodec || 'opus', duration: overrides.audioDuration || '60' })),
], ...overrides.extra });
function fixture(t, outputProbe = probe({ video: { codec_name: 'h264', width: 1280, height: 720 }, audioCodec: 'aac', extra: { format: { duration: '60', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } } })) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-nvenc-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const source = path.join(directory, 'original.webm'); fs.writeFileSync(source, 'original-file-preserved');
  const calls = []; let held = false, released = false;
  const runImpl = async (file, args, options) => {
    calls.push({ file, args, held });
    if (options.kind === 'probe-source') return { code: 0, stdout: JSON.stringify(probe()) };
    if (options.kind === 'encode') {
      assert.equal(held, true); fs.writeFileSync(args.at(-1), 'encoded-mp4');
      options.onStdout?.('frame=1800\nout_time_us=60000000\nspeed=12.0x\nprogress=end\n');
      return { code: 0, stdout: '', stderr: '' };
    }
    assert.equal(held, true); return { code: 0, stdout: JSON.stringify(outputProbe) };
  };
  const options = { source, outputDirectory: path.join(directory, 'outputs'), quality: '720p', root: directory,
    ffmpeg: path.join(directory, 'ffmpeg.exe'), ffprobe: path.join(directory, 'ffprobe.exe'), runImpl,
    leaseFactory: async () => { held = true; return { release: async () => { held = false; released = true; } }; } };
  return { directory, source, calls, options, released: () => released };
}
test('NVENC command, verified geometry, all audio tracks, original file and logs are retained', async t => {
  const f = fixture(t), progress = [];
  const result = await transcodeVideo({ ...f.options, onProgress: value => progress.push(value) });
  assert.equal(result.engine, 'h264_nvenc'); assert.equal(result.width, 1280); assert.equal(result.height, 720); assert.equal(result.audio, true);
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'original-file-preserved'); assert.equal(fs.readFileSync(result.path, 'utf8'), 'encoded-mp4');
  assert.ok(f.calls[1].args.includes('h264_nvenc')); assert.ok(f.calls[1].args.includes('0:a?')); assert.equal(f.calls[1].args.includes('libx264'), false);
  assert.equal(f.released(), true); assert.ok(progress.some(value => value.stage === 'transcoding' && value.frame === 1800));
  for (const file of ['commands.jsonl', 'source-probe.json', 'output-probe.json', 'result.json', 'timing.json']) assert.ok(fs.existsSync(path.join(result.recordDirectory, file)));
});
test('NVDEC is explicit and never falls back to a CPU codec on an encoder failure', async t => {
  const f = fixture(t), base = f.options.runImpl;
  f.options.runImpl = async (file, args, options) => {
    if (options.kind === 'encode') { f.calls.push({ file, args }); assert.ok(args.includes('vp9_cuvid')); return { code: 1, stderr: 'NVENC initialization failed' }; }
    return base(file, args, options);
  };
  await assert.rejects(transcodeVideo({ ...f.options, hardwareDecode: true }), /NVENC initialization failed/);
  assert.equal(f.calls.filter(x => x.args.includes('h264_nvenc')).length, 1); assert.equal(f.released(), true);
  const records = fs.readdirSync(f.options.outputDirectory);
  assert.equal(fs.existsSync(path.join(f.options.outputDirectory, records[0], 'result.json')), false);
  assert.ok(fs.existsSync(path.join(f.options.outputDirectory, records[0], 'failure.json')));
});
test('duration, audio and size verification reject incomplete output before publishing it', async t => {
  for (const output of [probe({ extra: { format: { duration: '54' } }, video: { codec_name: 'h264', width: 1280, height: 720 } }),
    probe({ audioCount: 0, video: { codec_name: 'h264', width: 1280, height: 720 } }),
    probe({ video: { codec_name: 'h264', width: 1920, height: 1080 } })]) {
    const f = fixture(t, output);
    await assert.rejects(transcodeVideo(f.options), /核验/); assert.equal(f.released(), true);
  }
});
test('cancellation is passed to the owned runner and releases the GPU lease after it exits', async t => {
  const f = fixture(t), controller = new AbortController(), base = f.options.runImpl; let encoding;
  const ready = new Promise(resolve => { encoding = resolve; });
  let encoderExited = false;
  f.options.runImpl = async (file, args, options) => {
    if (options.kind !== 'encode') return base(file, args, options);
    return new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => { encoderExited = true; reject(options.signal.reason); }, { once: true }); encoding(); });
  };
  f.options.leaseFactory = async () => ({ release: async () => { assert.equal(encoderExited, true); } });
  const task = transcodeVideo({ ...f.options, signal: controller.signal }); await ready; controller.abort(Error('cancel NVENC'));
  await assert.rejects(task, /cancel NVENC/);
});
test('encoding argument builder preserves even dimensions and can force segment keyframes without software encoding', () => {
  const args = nvencEncodingArgs({ width: 1280, height: 720, hardwareDecode: true, forceKeyframeSeconds: 15 });
  assert.ok(args.includes('h264_nvenc')); assert.ok(args.some(value => value.startsWith('scale_cuda=')));
  assert.ok(args.includes('expr:gte(t,n_forced*15)')); assert.equal(args.includes('libx264'), false);
  assert.equal(args[args.indexOf('-forced-idr') + 1], '1');
  assert.throws(() => nvencEncodingArgs({ width: 1279, height: 720 }), /偶数/);
  for (const forceKeyframeSeconds of [0, .24, 601, Infinity, NaN, '15']) assert.throws(() => nvencEncodingArgs({ width: 1280, height: 720, forceKeyframeSeconds }), /0.25到600/);
});

test('transcodeVideo forwards validated keyframe intervals and records forced IDR parameters', async t => {
  const f = fixture(t), result = await transcodeVideo({ ...f.options, forceKeyframeSeconds: 2 });
  assert.ok(f.calls[1].args.includes('expr:gte(t,n_forced*2)'));
  assert.equal(f.calls[1].args[f.calls[1].args.indexOf('-forced-idr') + 1], '1');
  assert.equal(result.nvenc.forceKeyframeSeconds, 2); assert.equal(result.nvenc.forcedIdr, true);
  for (const forceKeyframeSeconds of [0, .1, 601, Infinity, '2']) await assert.rejects(transcodeVideo({ ...f.options, forceKeyframeSeconds }), /参数无效/);
});

test('the real owned-process runner logs output and cancellation waits for child exit', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nvenc-runner-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const controller = new AbortController(); let began;
  const ready = new Promise(resolve => { began = resolve; });
  const running = runProcess(process.execPath, ['-e', "process.stdout.write('owned child started\\n');process.stderr.write('owned stderr\\n');setInterval(()=>{},1000)"], {
    signal: controller.signal, stdoutFile: path.join(directory, 'stdout.log'), stderrFile: path.join(directory, 'stderr.log'), onStdout: began,
  });
  await ready; controller.abort(Error('stop owned encoder')); await assert.rejects(running, /stop owned encoder/);
  assert.match(fs.readFileSync(path.join(directory, 'stdout.log'), 'utf8'), /owned child started/);
  assert.match(fs.readFileSync(path.join(directory, 'stderr.log'), 'utf8'), /owned stderr/);
});
