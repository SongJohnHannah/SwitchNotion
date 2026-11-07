const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { acquireGpuLease } = require('./gpu-lease.cjs');
const { writeAtomicJson } = require('./atomic-json.cjs');

const now = () => new Date().toISOString();
const cudaDecoders = Object.freeze({ h264: 'h264_cuvid', hevc: 'hevc_cuvid', vp9: 'vp9_cuvid', av1: 'av1_cuvid', vp8: 'vp8_cuvid', mpeg2video: 'mpeg2_cuvid' });
function nvencEncodingArgs({ width, height, hardwareDecode = false, forceKeyframeSeconds } = {}) {
  if (![width, height].every(n => Number.isSafeInteger(n) && n >= 2 && n % 2 === 0)) throw Error('NVENC画幅必须是正偶数尺寸。');
  const filter = hardwareDecode
    ? `scale_cuda=w=${width}:h=${height}:format=nv12:interp_algo=lanczos:passthrough=0`
    : `scale=w=${width}:h=${height}:flags=lanczos`;
  const args = ['-vf', filter, '-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '19',
    '-b:v', '0', '-profile:v', 'high', '-rc-lookahead', '0', '-pix_fmt', hardwareDecode ? 'cuda' : 'yuv420p', '-fps_mode', 'passthrough'];
  if (forceKeyframeSeconds !== undefined) {
    if (!Number.isFinite(forceKeyframeSeconds) || forceKeyframeSeconds < .25 || forceKeyframeSeconds > 600) throw Error('分段关键帧间隔须为0.25到600秒。');
    args.push('-force_key_frames', `expr:gte(t,n_forced*${forceKeyframeSeconds})`, '-forced-idr', '1');
  }
  return args.concat(['-c:a', 'aac', '-b:a', '192k']);
}
function duration(value) {
  const number = Number(value); if (Number.isFinite(number) && number > 0) return number;
  const clock = typeof value === 'string' && value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  return clock ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : null;
}
function summarizeProbe(data) {
  if (!Array.isArray(data.streams)) throw Error('视频探测结果缺少流。');
  const video = data.streams.find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
  if (!video || ![video.width, video.height].every(n => Number.isSafeInteger(n) && n >= 2)) throw Error('未找到有效主视频画幅。');
  const audioStreams = data.streams.filter(stream => stream.codec_type === 'audio');
  const mainDuration = duration(data.format?.duration) || duration(video.duration) || duration(video.tags?.DURATION);
  if (!mainDuration) throw Error('未找到有效视频时长。');
  const rotation = Number(video.side_data_list?.find(item => item.rotation !== undefined)?.rotation || video.tags?.rotate || 0);
  const rotated = Math.abs(rotation % 180) === 90;
  const sarParts = String(video.sample_aspect_ratio || '1:1').split(/[:/]/).map(Number);
  const sar = sarParts.length === 2 && sarParts[0] > 0 && sarParts[1] > 0 ? sarParts[0] / sarParts[1] : 1;
  const ratio = video.width * sar / video.height;
  return { video, audioStreams, duration: mainDuration, audio: audioStreams.length > 0, rotation,
    formatName: data.format?.format_name || '',
    width: rotated ? video.height : video.width, height: rotated ? video.width : video.height,
    displayRatio: rotated ? 1 / ratio : ratio };
}
function dimensions(info, quality) {
  const cap = quality === '1080p' ? [1920, 1080] : quality === '720p' ? [1280, 720] : [Infinity, Infinity];
  if (info.height > info.width) cap.reverse();
  const scale = Math.min(1, cap[0] / info.width, cap[1] / info.height);
  return { width: Math.max(2, Math.floor(info.width * scale / 2) * 2), height: Math.max(2, Math.floor(info.height * scale / 2) * 2) };
}
function terminateOwned(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform !== 'win32') { child.kill('SIGKILL'); return Promise.resolve(); }
  return new Promise(resolve => execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
    ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); resolve();
    }));
}
function runProcess(file, args, { signal, timeoutMs = 4 * 3600000, stdoutFile, stderrFile, onStdout, captureAll = false } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let out, err;
    try { out = fs.openSync(stdoutFile, 'wx'); err = fs.openSync(stderrFile, 'wx'); }
    catch (error) { if (out !== undefined) fs.closeSync(out); reject(error); return; }
    let child, stdout = '', stderr = '', failure, terminating = Promise.resolve(), ended = false;
    try { child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { fs.closeSync(out); fs.closeSync(err); reject(error); return; }
    const stop = reason => { failure ||= reason; terminating = terminateOwned(child); };
    const abort = () => stop(signal.reason || Error('GPU视频转码已取消。'));
    const timer = setTimeout(() => stop(Error('GPU视频转码超时。')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.stdout.on('data', bytes => {
      try {
        fs.writeSync(out, bytes); stdout += bytes.toString('utf8');
        if (captureAll && stdout.length > 32 * 1024 ** 2) throw Error('视频探测结果过大。');
        if (!captureAll) stdout = stdout.slice(-8192);
        onStdout?.(bytes.toString('utf8'));
      } catch (error) { stop(error); }
    });
    child.stderr.on('data', bytes => { try { fs.writeSync(err, bytes); stderr = (stderr + bytes.toString('utf8')).slice(-8192); } catch (error) { stop(error); } });
    child.once('error', error => { failure ||= error; });
    child.once('close', async (code, exitSignal) => {
      if (ended) return; ended = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      await terminating; fs.closeSync(out); fs.closeSync(err);
      if (failure) { Object.assign(failure, { stdout, stderr, code }); reject(failure); }
      else resolve({ code, signal: exitSignal, stdout, stderr, pid: child.pid });
    });
  });
}

/** Lossy video recompression only. 'original' keeps coded dimensions; it is not
 * stream-copy or a promise of original visual quality. The original is untouched.
 */
async function transcodeVideo({ source, outputDirectory, quality = 'original', root, ffmpeg, ffprobe,
  hardwareDecode = false, signal, onProgress = () => {}, runImpl = runProcess, leaseFactory = acquireGpuLease,
  timeoutMs = 4 * 3600000, forceKeyframeSeconds } = {}) {
  if (![source, outputDirectory, root, ffmpeg, ffprobe].every(value => typeof value === 'string' && path.isAbsolute(value)) ||
      !['original', '1080p', '720p'].includes(quality) || typeof hardwareDecode !== 'boolean' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      (forceKeyframeSeconds !== undefined && (!Number.isFinite(forceKeyframeSeconds) || forceKeyframeSeconds < .25 || forceKeyframeSeconds > 600))) throw TypeError('GPU视频转码参数无效，关键帧间隔须为0.25到600秒。');
  signal?.throwIfAborted();
  const initial = fs.statSync(source); if (!initial.isFile() || !initial.size) throw Error('输入视频无效。');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const recordDirectory = path.join(outputDirectory, 'video-transcode-' + now().replace(/[:.]/g, '-') + '-' + randomUUID());
  fs.mkdirSync(recordDirectory);
  const temporary = path.join(recordDirectory, 'encoding-' + randomUUID() + '.partial.mp4'), output = path.join(recordDirectory, 'output.mp4');
  const timing = { coldStarted: now() }; let lease, encodeExit, commandIndex = 0, result;
  const record = value => fs.appendFileSync(path.join(recordDirectory, 'commands.jsonl'), JSON.stringify({ at: now(), ...value }) + '\n', { flush: true });
  async function command(file, args, kind, onStdout) {
    const index = ++commandIndex, prefix = path.join(recordDirectory, String(index).padStart(2, '0') + '-' + kind);
    const options = { kind, signal, timeoutMs: kind === 'encode' ? timeoutMs : 30000,
      stdoutFile: prefix + '.stdout.log', stderrFile: prefix + '.stderr.log', captureAll: kind !== 'encode', onStdout };
    record({ event: 'command', index, file, args, kind });
    try {
      const response = await runImpl(file, args, options);
      if (!fs.existsSync(options.stdoutFile)) fs.writeFileSync(options.stdoutFile, response.stdout || '');
      if (!fs.existsSync(options.stderrFile)) fs.writeFileSync(options.stderrFile, response.stderr || '');
      record({ event: 'exit', index, kind, code: response.code ?? response.exitCode ?? 0, pid: response.pid || null });
      signal?.throwIfAborted();
      if ((response.code ?? response.exitCode ?? 0) !== 0) throw Error((kind === 'encode' ? 'NVENC转码失败：' : '视频探测失败：') + (response.stderr || `退出码${response.code}`).slice(-2000));
      return response;
    } catch (error) { record({ event: 'command-failed', index, kind, error: error.message, code: error.code || null }); throw error; }
  }
  async function probe(file, kind) {
    const response = await command(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], kind);
    let data; try { data = JSON.parse(response.stdout); } catch { throw Error('视频探测JSON无效。'); }
    await writeAtomicJson(path.join(recordDirectory, kind === 'probe-source' ? 'source-probe.json' : 'output-probe.json'), data);
    return summarizeProbe(data);
  }
  try {
    const original = await probe(source, 'probe-source'), target = dimensions(original, quality);
    if (['smpte2084', 'arib-std-b67'].includes(original.video.color_transfer)) throw Error('此视频为HDR，当前GPU压缩方案未验证其色彩转换，原片已保留。');
    if (hardwareDecode && original.rotation % 360) throw Error('此视频带旋转，当前NVDEC路径未验证旋转处理，原片已保留。');
    const decoder = hardwareDecode && cudaDecoders[original.video.codec_name];
    if (hardwareDecode && !decoder) throw Error('此视频编码没有当前显式NVDEC路径，未自动改用CPU解码。');
    timing.queued = now();
    lease = await leaseFactory({ root, signal, onWait: owner => onProgress({ stage: 'waiting-gpu', ownerPid: owner.pid, engine: 'h264_nvenc' }) });
    timing.gpuAcquired = now();
    const decodeArgs = hardwareDecode ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', `-c:${original.video.index}`, decoder] : ['-hwaccel', 'none'];
    const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', ...decodeArgs, '-i', source,
      '-map', `0:${original.video.index}`, '-map', '0:a?', ...nvencEncodingArgs({ ...target, hardwareDecode, forceKeyframeSeconds }),
      '-metadata:s:v:0', 'rotate=0', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-y', temporary];
    let carry = '', snapshot = {};
    const progress = text => {
      carry += text; const lines = carry.split(/\r?\n/); carry = lines.pop();
      for (const line of lines) {
        const at = line.indexOf('='); if (at < 0) continue; snapshot[line.slice(0, at)] = line.slice(at + 1);
        if (line.startsWith('progress=')) {
          const time = Number(snapshot.out_time_us ?? snapshot.out_time_ms) / 1000000;
          onProgress({ stage: 'transcoding', engine: 'h264_nvenc', frame: Number(snapshot.frame) || 0,
            seconds: Number.isFinite(time) ? time : 0, totalSeconds: original.duration,
            fraction: Number.isFinite(time) ? Math.max(0, Math.min(1, time / original.duration)) : 0, speed: snapshot.speed || null });
        }
      }
    };
    timing.encodeStarted = now(); encodeExit = await command(ffmpeg, args, 'encode', progress); timing.encodeExited = now();
    const outputInfo = await probe(temporary, 'probe-output'); timing.probeCompleted = now();
    const finalSource = fs.statSync(source);
    if (finalSource.size !== initial.size || finalSource.mtimeMs !== initial.mtimeMs) throw Error('转码过程中原片已改变，完整性核验失败。');
    const problems = [];
    if (Math.abs(outputInfo.duration - original.duration) > .5) problems.push('整片时长');
    if (outputInfo.width !== target.width || outputInfo.height !== target.height || outputInfo.width % 2 || outputInfo.height % 2) problems.push('所选画幅');
    if (Math.abs(outputInfo.displayRatio / original.displayRatio - 1) > .01) problems.push('显示宽高比');
    if (outputInfo.video.codec_name !== 'h264') problems.push('目标视频编码');
    if (!outputInfo.formatName.split(',').includes('mp4')) problems.push('目标容器');
    if (outputInfo.audioStreams.length !== original.audioStreams.length) problems.push('音轨数量');
    if (outputInfo.audioStreams.some(stream => stream.codec_name !== 'aac')) problems.push('目标音频编码');
    for (let i = 0; i < original.audioStreams.length; i++) {
      const before = duration(original.audioStreams[i].duration) || duration(original.audioStreams[i].tags?.DURATION);
      const after = duration(outputInfo.audioStreams[i]?.duration) || duration(outputInfo.audioStreams[i]?.tags?.DURATION);
      if (before && after && Math.abs(before - after) > .5) problems.push('音轨时长' + i);
    }
    if (!fs.statSync(temporary).size) problems.push('输出文件大小');
    if (problems.length) throw Error('GPU转码完整性核验未通过：' + problems.join('、') + '；原片与临时输出已保留。');
    await fsp.rename(temporary, output); timing.completed = now();
    result = { path: output, kind: 'video', duration: outputInfo.duration, width: outputInfo.width, height: outputInfo.height,
      bytes: fs.statSync(output).size, audio: outputInfo.audio, engine: 'h264_nvenc', decodeEngine: hardwareDecode ? decoder : 'software',
      quality, recordDirectory, complete: true, sourceBytes: initial.size, outputToSourceRatio: fs.statSync(output).size / initial.size,
      verification: { durationDeltaSeconds: outputInfo.duration - original.duration, audioStreams: outputInfo.audioStreams.length,
        width: target.width, height: target.height, displayRatioChecked: true, sourceUnchanged: true, container: 'mp4' },
      nvenc: { preset: 'p5', tune: 'hq', rateControl: 'vbr', cq: 19, lookahead: 0,
        forceKeyframeSeconds: forceKeyframeSeconds ?? null, forcedIdr: forceKeyframeSeconds !== undefined,
        note: 'NVENC CQ不是libx264 CRF的同等画质标尺；original表示保持尺寸，非无损。' }, timing };
    await writeAtomicJson(path.join(recordDirectory, 'result.json'), result);
    onProgress({ stage: 'completed', engine: 'h264_nvenc', path: output }); return result;
  } catch (error) {
    timing.failed = now(); timing.error = error.message;
    await writeAtomicJson(path.join(recordDirectory, 'failure.json'), { at: now(), error: error.message, source, temporary,
      engine: 'h264_nvenc', noCpuEncoderFallback: true, encoderExit: encodeExit?.code ?? null });
    throw error;
  } finally {
    try { await lease?.release(); }
    finally {
      timing.resourcesReleased = now();
      timing.endToEndSeconds = (Date.parse(timing.resourcesReleased) - Date.parse(timing.coldStarted)) / 1000;
      timing.waitQueueSeconds = timing.gpuAcquired ? (Date.parse(timing.gpuAcquired) - Date.parse(timing.queued)) / 1000 : null;
      await writeAtomicJson(path.join(recordDirectory, 'timing.json'), timing);
    }
  }
}

module.exports = { transcodeVideo, nvencEncodingArgs, runProcess };
