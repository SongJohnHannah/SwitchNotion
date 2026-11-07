const { createHash } = require('node:crypto');

const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const roundRate = value => Math.round(value / 1000) * 1000;
function sourceInfo(source) {
  if (!source || ![source.width, source.height, source.duration, source.bytes].every(positive) ||
      !Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height) || !Number.isSafeInteger(source.bytes) || source.width < 2 || source.height < 2) throw TypeError('视频方案需要有效画幅、完整时长和文件大小。');
  return source;
}
function geometry(source, quality) {
  const cap = quality === '1080p' ? [1920, 1080] : quality === '720p' ? [1280, 720] : [Infinity, Infinity];
  if (source.height > source.width) cap.reverse();
  const scale = Math.min(1, cap[0] / source.width, cap[1] / source.height);
  return { width: Math.max(2, Math.floor(source.width * scale / 2) * 2), height: Math.max(2, Math.floor(source.height * scale / 2) * 2) };
}
function buildVideoRatePlan({ source, quality = '1080p', preset = 'p3', hardwareDecode = true, uploadLimitBytes,
  forceKeyframeSeconds, skipIdentityScale = true, interpolation = 'lanczos' } = {}) {
  sourceInfo(source);
  if (!['original', '1080p', '720p'].includes(quality) || !['p1', 'p3', 'p5'].includes(preset) ||
      typeof hardwareDecode !== 'boolean' || typeof skipIdentityScale !== 'boolean' || !['lanczos', 'bilinear'].includes(interpolation)) throw TypeError('视频实验方案参数无效。');
  if (forceKeyframeSeconds !== undefined && (!positive(forceKeyframeSeconds) || forceKeyframeSeconds < .25 || forceKeyframeSeconds > 600)) throw TypeError('关键帧间隔须为0.25到600秒。');
  if (uploadLimitBytes !== undefined && !positive(uploadLimitBytes)) throw TypeError('上传大小限制无效。');
  const target = geometry(source, quality), audioStreams = source.audioCodecs?.length ?? (source.audio === false ? 0 : 1);
  const audioBitratePerStream = 192000, sourceTotalBitrate = source.bytes * 8 / source.duration;
  const sourceAudioBitrate = positive(source.audioBitrate) ? source.audioBitrate : audioStreams * audioBitratePerStream;
  const sourceVideoBitrate = positive(source.videoBitrate) ? source.videoBitrate : Math.max(0, sourceTotalBitrate - sourceAudioBitrate);
  const cap = quality === '720p' ? 900000 : quality === '1080p' ? 1800000 : Math.max(250000, 1800000 * target.width * target.height / (1920 * 1080));
  const videoBitrate = Math.max(160000, Math.floor(Math.min(cap, sourceVideoBitrate * .85) / 1000) * 1000);
  const maxrate = roundRate(videoBitrate * 1.5), bufsize = roundRate(videoBitrate * 2);
  const estimatedOutputBytes = Math.ceil(source.duration * (videoBitrate + audioStreams * audioBitratePerStream) / 8 * 1.01);
  const expectedRatio = estimatedOutputBytes / source.bytes, requiredResize = target.width !== source.width || target.height !== source.height;
  const formatCompatible = ['yuv420p', 'nv12'].includes(source.pixelFormat);
  const scalePolicy = !requiredResize && skipIdentityScale && formatCompatible ? 'identity-bypass' : interpolation;
  let forced = forceKeyframeSeconds ?? null;
  if (forced === null && uploadLimitBytes && estimatedOutputBytes > uploadLimitBytes) {
    // Do not force two-second IDRs when the byte budget permits longer cuts.
    forced = Math.max(.25, Math.min(30, uploadLimitBytes * 8 / (videoBitrate + audioStreams * audioBitratePerStream) * .65));
    forced = Math.floor(forced * 1000) / 1000;
  }
  const plan = { version: 1, status: 'unvalidated-experiment', engine: 'h264_nvenc', quality, preset, tune: 'hq',
    rateControl: 'vbr', videoBitrate, maxrate, bufsize, audioBitratePerStream, audioStreams, multipass: 'disabled', lookahead: 0,
    hardwareDecode, ...target, scalePolicy, forceKeyframeSeconds: forced,
    sourceTotalBitrate, sourceVideoBitrate, sourceAudioBitrate,
    sourceBitrateBasis: positive(source.videoBitrate) ? 'stream-metadata' : 'file-average-minus-audio-estimate',
    estimatedOutputBytes, expectedOutputToSourceRatio: expectedRatio, requiredResize,
    shouldEncodeForCompression: expectedRatio < .92,
    recommendedRoute: requiredResize ? 'nvenc-resize-experiment' : expectedRatio < .92 ? 'nvenc-compression-experiment' : 'keep-original-or-copy-segments',
    visualQualityVerified: false, completeDurationMustBeVerified: true,
    note: '有界VBR不是原CQ19的同等画质；p1/p3与缩放/GOP改动须独立测相同片段，不能承诺免费50%提速。',
    original: structuredClone(source) };
  plan.fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return plan;
}
function plannedNvencEncodingArgs(plan) {
  if (plan?.engine !== 'h264_nvenc' || !['p1', 'p3', 'p5'].includes(plan.preset) || typeof plan.hardwareDecode !== 'boolean' ||
      ![plan.width, plan.height].every(n => Number.isSafeInteger(n) && n >= 2 && n % 2 === 0) ||
      ![plan.videoBitrate, plan.maxrate, plan.bufsize, plan.audioBitratePerStream].every(positive) ||
      plan.maxrate < plan.videoBitrate || plan.bufsize < plan.videoBitrate) throw TypeError('视频实验方案无效。');
  if (plan.forceKeyframeSeconds != null && (!positive(plan.forceKeyframeSeconds) || plan.forceKeyframeSeconds < .25 || plan.forceKeyframeSeconds > 600)) throw TypeError('关键帧间隔须为0.25到600秒。');
  const args = [];
  if (plan.scalePolicy !== 'identity-bypass') {
    if (!['lanczos', 'bilinear'].includes(plan.scalePolicy)) throw TypeError('缩放策略无效。');
    args.push('-vf', plan.hardwareDecode
      ? `scale_cuda=w=${plan.width}:h=${plan.height}:format=nv12:interp_algo=${plan.scalePolicy}:passthrough=0`
      : `scale=w=${plan.width}:h=${plan.height}:flags=${plan.scalePolicy}`);
  }
  args.push('-c:v', 'h264_nvenc', '-preset', plan.preset, '-tune', 'hq', '-rc', 'vbr', '-b:v', String(plan.videoBitrate),
    '-maxrate', String(plan.maxrate), '-bufsize', String(plan.bufsize), '-multipass', 'disabled', '-rc-lookahead', '0',
    '-profile:v', 'high', '-pix_fmt', plan.hardwareDecode ? 'cuda' : 'yuv420p', '-fps_mode', 'passthrough');
  if (plan.forceKeyframeSeconds != null) args.push('-force_key_frames', `expr:gte(t,n_forced*${plan.forceKeyframeSeconds})`, '-forced-idr', '1');
  return args.concat(['-c:a', 'aac', '-b:a', String(plan.audioBitratePerStream)]);
}
function decideVideoCopyRoute({ source, uploadLimitBytes, requireMp4 = false, codecPlaybackVerified = false } = {}) {
  sourceInfo(source);
  if (typeof requireMp4 !== 'boolean' || typeof codecPlaybackVerified !== 'boolean' || (uploadLimitBytes !== undefined && !positive(uploadLimitBytes))) throw TypeError('封装选择方案参数无效。');
  const container = String(source.container || '').toLowerCase().replace(/^\./, '');
  const appAcceptsContainer = ['webm', 'mp4', 'mov'].some(name => container.split(',').includes(name));
  const audio = source.audioCodecs || [];
  const commonAvc = source.videoCodec === 'h264' && audio.every(codec => ['aac', 'mp3'].includes(codec));
  const experimentalRemux = { codec: 'copy', args: ['-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart'],
    noNeuralModelOrGpu: true, requireDurationAndBitstreamAudit: true };
  if (requireMp4 && !container.split(',').includes('mp4')) {
    if (!commonAvc && !codecPlaybackVerified) return { route: 'needs-playback-validation', reason: '应用扩展名/MIME白名单不能证明MP4内VP9/Opus已播放验收。', experimentalRemux };
    return { route: 'remux-copy', ...experimentalRemux, playbackEvidenceRequired: !commonAvc };
  }
  if (!appAcceptsContainer) return { route: 'needs-container-validation', experimentalRemux };
  if (uploadLimitBytes && source.bytes > uploadLimitBytes) return { route: 'copy-segments', codec: 'copy',
    segmentSeconds: Math.max(.5, source.duration * uploadLimitBytes / source.bytes * .65),
    requireAllSegmentsDurationAndAudioBoundaryAudit: true, sourceCodecPreserved: true };
  return { route: 'keep-original', sourceCodecPreserved: true, noTranscodeNeeded: true };
}

module.exports = { buildVideoRatePlan, plannedNvencEncodingArgs, decideVideoCopyRoute };
