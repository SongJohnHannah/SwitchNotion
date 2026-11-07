import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const now = () => new Date().toISOString();
const elapsed = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;
function seconds(value) {
  const n = Number(value); if (Number.isFinite(n) && n > 0) return n;
  const match = typeof value === 'string' && value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}
function probeInfo(data) {
  const streams = data.streams || [], video = streams.find(row => row.codec_type === 'video' && !row.disposition?.attached_pic);
  const audio = streams.filter(row => row.codec_type === 'audio'), duration = seconds(data.format?.duration) || seconds(video?.duration) || seconds(video?.tags?.DURATION);
  if (!video || !Number.isInteger(video.index) || !duration || ![video.width, video.height].every(n => Number.isSafeInteger(n) && n >= 2)) throw Error('源视频探测缺少有效画幅/时长。');
  return { video, audio, duration, format: data.format?.format_name || '', streams };
}
function hashes(text) {
  const values = text.split(/\r?\n/).map(line => line.trim()).filter(line => /^\d+,[av],SHA256=[a-f\d]{64}$/i.test(line));
  if (!values.length) throw Error('码流或音轨哈希缺失。');
  return values.map(line => line.toLowerCase());
}
function contentError(message) { return Object.assign(Error(message), { code: 'VIDEO_CONTENT_REVIEW' }); }
const decoders = { vp9: 'vp9_cuvid', h264: 'h264_cuvid', hevc: 'hevc_cuvid', av1: 'av1_cuvid', vp8: 'vp8_cuvid' };

/** One isolated candidate per call. No default/validated video helper is edited.
 * Copy/remux shares the lease for timing isolation but never calls a GPU codec.
 */
export async function runVideoOptimizationBenchmark({ source, outputDirectory, candidate,
  bundle = 'D:/迅雷下载/notionSwitch/GPU转写算子', helperDirectory = path.resolve(import.meta.dirname, '../src/speech'),
  ffmpeg, ffprobe, root, planOnly = false, sourceProbe, signal, onProgress = () => {}, runImpl, leaseFactory,
  uploadLimitBytes, forceKeyframeSeconds, baselineSeconds = 384.481 } = {}) {
  if (![source, outputDirectory, bundle, helperDirectory].every(value => typeof value === 'string' && path.isAbsolute(value))) throw TypeError('视频基准路径必须是绝对路径。');
  const nvenc = /^(p[135])-(1080p|720p)$/.exec(candidate || '');
  if (!nvenc && !['copy-original', 'copy-webm', 'remux-mp4'].includes(candidate)) throw TypeError('必须选择单个已命名视频候选。');
  if (fs.existsSync(outputDirectory)) throw Error('独立视频基准输出目录必须不存在，不能复用旧结果。');
  const { buildVideoRatePlan, plannedNvencEncodingArgs, decideVideoCopyRoute } = require(path.join(helperDirectory, 'video-transcode-plan.cjs'));
  const { runProcess } = require(path.join(helperDirectory, 'video-transcode.cjs'));
  const { acquireGpuLease } = require(path.join(helperDirectory, 'gpu-lease.cjs'));
  const { writeAtomicJson } = require(path.join(helperDirectory, 'atomic-json.cjs'));
  runImpl ||= runProcess; leaseFactory ||= acquireGpuLease;
  const machine = JSON.parse(fs.readFileSync(path.join(bundle, 'machine.json')));
  ffmpeg ||= path.resolve(bundle, machine.ffmpeg || 'bin/ffmpeg.exe');
  ffprobe ||= path.resolve(bundle, machine.ffprobe || 'bin/ffprobe.exe');
  root ||= path.resolve(bundle, machine.resourcesRoot || 'resources');
  if (![ffmpeg, ffprobe, root].every(value => path.isAbsolute(value))) throw TypeError('运行库路径必须是绝对路径。');
  signal?.throwIfAborted(); const initial = fs.statSync(source);
  if (!initial.isFile() || !initial.size) throw Error('基准源视频无效。');
  fs.mkdirSync(path.dirname(outputDirectory), { recursive: true }); fs.mkdirSync(outputDirectory);
  const timing = { coldStarted: now() }, gpuUsed = !!nvenc;
  let lease, commandIndex = 0, plan, activeKind, workPath;
  const record = event => fs.appendFileSync(path.join(outputDirectory, 'commands.jsonl'), JSON.stringify({ at: now(), ...event }) + '\n', { flush: true });
  async function command(file, args, kind, onStdout) {
    activeKind = kind; const id = ++commandIndex, prefix = path.join(outputDirectory, String(id).padStart(2, '0') + '-' + kind);
    const opts = { kind, signal, timeoutMs: kind === 'work' ? 4 * 3600000 : 240000,
      captureAll: kind !== 'work', stdoutFile: prefix + '.stdout.log', stderrFile: prefix + '.stderr.log', onStdout };
    record({ event: 'command', id, kind, file, args });
    const value = await runImpl(file, args, opts);
    if (!fs.existsSync(opts.stdoutFile)) fs.writeFileSync(opts.stdoutFile, value.stdout || '');
    if (!fs.existsSync(opts.stderrFile)) fs.writeFileSync(opts.stderrFile, value.stderr || '');
    record({ event: 'exit', id, kind, code: value.code ?? value.exitCode ?? 0 }); signal?.throwIfAborted();
    if ((value.code ?? value.exitCode ?? 0) !== 0) throw Error(kind + '失败：' + (value.stderr || String(value.code)).slice(-2000));
    return value;
  }
  async function probe(file, kind) {
    const data = kind === 'probe-source' && sourceProbe ? sourceProbe : JSON.parse((await command(ffprobe,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], kind)).stdout);
    await writeAtomicJson(path.join(outputDirectory, kind + '.json'), data); return probeInfo(data);
  }
  try {
    const original = await probe(source, 'probe-source');
    const sourceModel = { width: original.video.width, height: original.video.height, duration: original.duration, bytes: initial.size,
      videoCodec: original.video.codec_name, audioCodecs: original.audio.map(row => row.codec_name), pixelFormat: original.video.pix_fmt,
      container: original.format, frameRate: original.video.avg_frame_rate || original.video.r_frame_rate || null,
      ...(Number(original.video.bit_rate) > 0 ? { videoBitrate: Number(original.video.bit_rate) } : {}) };
    const copyRoute = decideVideoCopyRoute({ source: sourceModel, uploadLimitBytes, requireMp4: candidate === 'remux-mp4' });
    plan = nvenc ? buildVideoRatePlan({ source: sourceModel, quality: nvenc[2], preset: nvenc[1], hardwareDecode: true, uploadLimitBytes, forceKeyframeSeconds })
      : { version: 1, candidate, engine: candidate === 'copy-original' ? 'source-reuse' : 'copy', source: sourceModel, copyRoute,
        status: 'unvalidated-experiment', visualQualityVerified: candidate === 'copy-original' };
    await writeAtomicJson(path.join(outputDirectory, 'plan.json'), plan);
    if (planOnly) return { planOnly: true, candidate, plan, outputDirectory, gpuUsed: false };
    timing.queueStarted = now();
    lease = await leaseFactory({ root, signal, onWait: owner => onProgress({ stage: 'waiting-gpu', ownerPid: owner.pid, candidate }) });
    timing.leaseAcquired = now(); timing.waitQueueSeconds = elapsed(timing.queueStarted, timing.leaseAcquired);
    timing.workStarted = now();
    const temporary = path.join(outputDirectory, 'candidate.partial.' + (candidate === 'copy-webm' ? 'webm' : 'mp4'));
    workPath = candidate === 'copy-original' ? source : temporary;
    if (candidate !== 'copy-original') {
      let args = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];
      if (nvenc) {
        const decoder = decoders[original.video.codec_name];
        if (!decoder) throw Error('此源编码没有显式NVDEC候选，未退CPU。');
        if (['smpte2084', 'arib-std-b67'].includes(original.video.color_transfer) || Number(original.video.tags?.rotate || 0) % 360 || original.video.side_data_list?.some(row => row.rotation % 360)) throw Error('此HDR/旋转源不在当前候选验证范围。');
        args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', `-c:${original.video.index}`, decoder, '-extra_hw_frames', '8');
      }
      args.push('-i', source, '-map', `0:${original.video.index}`, '-map', '0:a?');
      if (nvenc) args.push(...plannedNvencEncodingArgs(plan)); else args.push('-c', 'copy');
      if (candidate !== 'copy-webm') args.push('-movflags', '+faststart');
      args.push('-progress', 'pipe:1', '-nostats', '-y', temporary);
      let carry = '', values = {};
      await command(ffmpeg, args, 'work', chunk => {
        carry += chunk; const lines = carry.split(/\r?\n/); carry = lines.pop();
        for (const line of lines) { const at = line.indexOf('='); if (at >= 0) values[line.slice(0, at)] = line.slice(at + 1);
          if (line.startsWith('progress=')) onProgress({ stage: 'transcoding', candidate, frame: Number(values.frame) || 0,
            seconds: Number(values.out_time_us || values.out_time_ms || 0) / 1000000, totalSeconds: original.duration, speed: values.speed }); }
      });
    }
    timing.workExited = now();
    const produced = candidate === 'copy-original' ? original : await probe(workPath, 'probe-output');
    const issues = [];
    if (Math.abs(produced.duration - original.duration) > .5) issues.push('完整时长');
    if (produced.audio.length !== original.audio.length) issues.push('音轨数量');
    if (produced.video.width !== (nvenc ? plan.width : original.video.width) || produced.video.height !== (nvenc ? plan.height : original.video.height)) issues.push('画幅');
    if (produced.video.codec_name !== (nvenc ? 'h264' : original.video.codec_name)) issues.push('视频编码');
    const expectedContainer = candidate === 'copy-webm' ? 'webm' : 'mp4';
    if (candidate !== 'copy-original' && !produced.format.split(',').includes(expectedContainer)) issues.push('目标容器');
    for (let n = 0; n < original.audio.length; n++) {
      if (produced.audio[n]?.codec_name !== (nvenc ? 'aac' : original.audio[n].codec_name)) issues.push('音频编码' + n);
      const a = seconds(original.audio[n].duration) || seconds(original.audio[n].tags?.DURATION), b = seconds(produced.audio[n]?.duration) || seconds(produced.audio[n]?.tags?.DURATION);
      if (a && b && Math.abs(a - b) > .5) issues.push('音轨时长' + n);
    }
    if (candidate !== 'copy-original' && !fs.statSync(workPath).size) issues.push('空文件');
    if (issues.length) throw contentError('完整性核验未通过：' + issues.join('、'));
    let streamPayloadEqual = candidate === 'copy-original' ? true : null, decodedAudioEqual = candidate === 'copy-original' ? true : null;
    if (!nvenc && candidate !== 'copy-original') {
      const copyHashArgs = file => ['-v', 'error', '-nostdin', '-i', file, '-map', `0:${file === source ? original.video.index : produced.video.index}`,
        '-map', '0:a?', '-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', 'pipe:1'];
      const before = hashes((await command(ffmpeg, copyHashArgs(source), 'hash-source')).stdout);
      const after = hashes((await command(ffmpeg, copyHashArgs(workPath), 'hash-output')).stdout);
      streamPayloadEqual = JSON.stringify(before) === JSON.stringify(after);
      if (!streamPayloadEqual) throw contentError('remux码流payload哈希不同，需复核而不能宣称无内容变化。');
      if (original.audio.length) {
        const pcmArgs = file => ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'streamhash', '-hash', 'sha256', 'pipe:1'];
        const a = hashes((await command(ffmpeg, pcmArgs(source), 'audio-source')).stdout);
        const b = hashes((await command(ffmpeg, pcmArgs(workPath), 'audio-output')).stdout);
        decodedAudioEqual = JSON.stringify(a) === JSON.stringify(b);
        if (!decodedAudioEqual) throw contentError('remux解码PCM哈希不同，需复核Opus预滚/时间戳，不能宣称音轨完全一致。');
      } else decodedAudioEqual = true;
    }
    const finalSource = fs.statSync(source);
    if (initial.size !== finalSource.size || initial.mtimeMs !== finalSource.mtimeMs) throw contentError('原片在测试期间改变。');
    const finalPath = candidate === 'copy-original' ? source : path.join(outputDirectory, 'output.' + (candidate === 'copy-webm' ? 'webm' : 'mp4'));
    if (candidate !== 'copy-original') await fs.promises.rename(workPath, finalPath);
    timing.completed = now();
    const result = { version: 1, complete: true, candidate, plan, engine: nvenc ? 'h264_nvenc' : candidate === 'copy-original' ? 'source-reuse' : 'copy', gpuUsed,
      path: finalPath, bytes: fs.statSync(finalPath).size, sourceBytes: initial.size, duration: produced.duration,
      width: produced.video.width, height: produced.video.height, audio: produced.audio.length > 0, streamPayloadEqual, decodedAudioEqual,
      visualQualityVerified: !nvenc && streamPayloadEqual && decodedAudioEqual, promotionEligible: false,
      playbackStatus: candidate === 'remux-mp4' && copyRoute.route === 'needs-playback-validation' ? 'unverified-codec-container-pair' : 'not-tested-here',
      comparableToReencode: !!nvenc, baselineSeconds: nvenc ? baselineSeconds : null,
      observedWorkSeconds: elapsed(timing.workStarted, timing.workExited), observedEndToEndSeconds: elapsed(timing.coldStarted, timing.completed),
      note: nvenc ? '仅结构验证；须另做SSIM/VMAF/实际同片段画质与独立复跑。' : '无重编码准备路线，不作为同画质压缩编码百分比。', timing };
    await writeAtomicJson(path.join(outputDirectory, 'result.json'), result); return result;
  } catch (error) {
    timing.failed = now();
    await writeAtomicJson(path.join(outputDirectory, 'failure.json'), { at: now(), candidate, status: error.code === 'VIDEO_CONTENT_REVIEW' ? 'content-review' : 'execution-failed',
      error: error.message, code: error.code || null, activeKind, gpuUsed, plan: plan || null, preservedFile: workPath || null });
    throw error;
  } finally {
    try { await lease?.release(); }
    finally { timing.resourcesReleased = now(); await writeAtomicJson(path.join(outputDirectory, 'timing.json'), timing); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}, args = process.argv.slice(2);
  const names = { '--source': 'source', '--out': 'outputDirectory', '--bundle': 'bundle', '--helpers': 'helperDirectory',
    '--candidate': 'candidate', '--ffmpeg': 'ffmpeg', '--ffprobe': 'ffprobe', '--root': 'root', '--force-keyframes': 'forceKeyframeSeconds', '--limit-bytes': 'uploadLimitBytes' };
  for (let n = 0; n < args.length; n++) {
    if (args[n] === '--plan-only') options.planOnly = true;
    else if (names[args[n]] && args[n + 1]) { const key = names[args[n]]; options[key] = ['forceKeyframeSeconds', 'uploadLimitBytes'].includes(key) ? Number(args[++n]) : args[++n]; }
    else throw Error('参数无效。必需 --source <绝对路径> --out <全新目录> --candidate copy-original|copy-webm|remux-mp4|p1-1080p|p3-1080p|p1-720p|p3-720p。可加--plan-only。');
  }
  const controller = new AbortController(); process.once('SIGINT', () => controller.abort(Error('已停止候选，原片与记录保留。')));
  const result = await runVideoOptimizationBenchmark({ ...options, signal: controller.signal, onProgress: value => console.log(JSON.stringify(value)) });
  console.log(JSON.stringify(result, null, 2));
}
