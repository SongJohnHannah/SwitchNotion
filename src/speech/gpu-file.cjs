const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { SpeechProvider } = require('./provider.cjs');
const { createSpeechPlatform } = require('./platform.cjs');
const { validatePcm } = require('./wav.cjs');
const { transcriptQualityIssue } = require('./transcript-quality.cjs');
const { writeAtomicJson } = require('./atomic-json.cjs');
const { acquireGpuLease } = require('./gpu-lease.cjs');

const policy = 'stable-gpu-v1';
const allocatorCacheConfigs = Object.freeze({ default: '4,3,12,209715200', large: '4,3,14,1073741824', compact: '2,6,28,1073741824' });
function allocatorConfigFor(plan) {
  const mode = plan.allocatorCache ?? 'default';
  if (typeof mode !== 'string' || !Object.hasOwn(allocatorCacheConfigs, mode)) throw Error('GPU 缓存配置无效。');
  return allocatorCacheConfigs[mode];
}
const defaultPlan = Object.freeze({ id: 'gpu-pinned-en-30s-v1-sm75', computeType: 'float16', allocator: 'cub_caching', fp16Gemm: false, chunkSeconds: 30, resetEveryChunks: 0,
  runtimeVariant: 'sm75-native', launchBlocking: true, beamSize: 1, runtimeRevision: '', languageOverride: 'en', batchSize: 1, batchClipSeconds: 0, encoderMicrobatchSize: 0, timestampedBatch: false, nativeWholeWindow: false, gpuEncoderBridge: false, shortEncoder: false, windowMode: 'legacy', allocatorCache: 'default' });
const hash = value => createHash('sha256').update(value).digest('hex');
function normalizePlan(value = defaultPlan) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(defaultPlan, key))) throw Error('GPU 转写方案无效。');
  const plan = { ...defaultPlan, ...value };
  if (!/^[a-z0-9-]{1,80}$/.test(plan.id) || !['float16', 'float32', 'int8_float16'].includes(plan.computeType) ||
      !['cub_caching', 'cuda_malloc_async'].includes(plan.allocator) || typeof plan.fp16Gemm !== 'boolean' ||
      !['bundled', 'pinned-cudnn', 'sm75-native', 'sm75-native-gpuops', 'sm75-native-fp16-accum-v1'].includes(plan.runtimeVariant) || typeof plan.launchBlocking !== 'boolean' || ![1, 5].includes(plan.beamSize) ||
      typeof plan.runtimeRevision !== 'string' || !/^(?:[a-f0-9]{64})?$/.test(plan.runtimeRevision) ||
      ![null, 'en', 'zh'].includes(plan.languageOverride) ||
      ![1, 2, 3, 4, 8].includes(plan.batchSize) || ![0, 15, 30].includes(plan.batchClipSeconds) ||
      ![0, 1, 2].includes(plan.encoderMicrobatchSize) || (plan.encoderMicrobatchSize > 0 && ![4, 8].includes(plan.batchSize)) ||
      typeof plan.timestampedBatch !== 'boolean' || (plan.timestampedBatch && (![2, 4].includes(plan.batchSize) || plan.encoderMicrobatchSize !== 0)) ||
      typeof plan.gpuEncoderBridge !== 'boolean' || (plan.runtimeVariant === 'sm75-native-gpuops') !== plan.gpuEncoderBridge ||
      (plan.runtimeVariant === 'sm75-native-fp16-accum-v1' && (!plan.runtimeRevision || plan.computeType !== 'float16' ||
        plan.allocator !== 'cub_caching' || plan.allocatorCache !== 'default' || !plan.launchBlocking || plan.beamSize !== 1 ||
        plan.batchSize !== 1 || plan.chunkSeconds !== 30 || plan.batchClipSeconds !== 0 || plan.encoderMicrobatchSize !== 0 ||
        plan.timestampedBatch || plan.nativeWholeWindow || plan.shortEncoder || plan.gpuEncoderBridge || plan.resetEveryChunks !== 0 || plan.windowMode !== 'legacy')) ||
      (plan.gpuEncoderBridge && (!plan.timestampedBatch || ![2, 4].includes(plan.batchSize) ||
        plan.computeType !== 'float16' || !plan.launchBlocking || plan.beamSize !== 1 || plan.fp16Gemm ||
        plan.allocator !== 'cub_caching' || plan.resetEveryChunks !== 0 || plan.encoderMicrobatchSize !== 0 || plan.nativeWholeWindow)) ||
      typeof plan.shortEncoder !== 'boolean' || (plan.shortEncoder && (plan.runtimeVariant !== 'sm75-native' ||
        plan.computeType !== 'float16' || plan.allocator !== 'cub_caching' || plan.fp16Gemm || !plan.launchBlocking ||
        plan.beamSize !== 1 || plan.batchSize !== 1 || plan.batchClipSeconds !== 0 || plan.encoderMicrobatchSize !== 0 ||
        plan.timestampedBatch || plan.nativeWholeWindow || plan.gpuEncoderBridge || plan.chunkSeconds !== 30 || plan.resetEveryChunks !== 0)) ||
      typeof plan.nativeWholeWindow !== 'boolean' || (plan.nativeWholeWindow && (plan.batchSize !== 1 || plan.runtimeVariant !== 'sm75-native' ||
        plan.computeType !== 'float16' || !plan.launchBlocking || plan.beamSize !== 1 || ![30, 60, 120, 240].includes(plan.chunkSeconds))) ||
      !['legacy', 'coverage-clips30', 'coverage-no-ts', 'stable30'].includes(plan.windowMode) ||
      (plan.windowMode !== 'legacy' && (!plan.nativeWholeWindow || plan.chunkSeconds !== 120 || plan.resetEveryChunks !== 0 ||
        plan.fp16Gemm || plan.allocator !== 'cub_caching')) ||
      (typeof plan.allocatorCache !== 'string' || !Object.hasOwn(allocatorCacheConfigs, plan.allocatorCache)) ||
      (plan.allocatorCache !== 'default' && (plan.allocator !== 'cub_caching' || plan.runtimeVariant !== 'sm75-native' ||
        plan.computeType !== 'float16' || !plan.launchBlocking || plan.fp16Gemm || plan.beamSize !== 1 ||
        plan.batchSize !== 1 || plan.chunkSeconds !== 30 || plan.nativeWholeWindow || plan.windowMode !== 'legacy' ||
        plan.shortEncoder || plan.gpuEncoderBridge || plan.resetEveryChunks !== 0)) ||
      (plan.batchSize > 1 && (![60, 90, 120, 240].includes(plan.chunkSeconds) || !['float16', 'int8_float16'].includes(plan.computeType))) ||
      (plan.batchSize === 1 && !plan.nativeWholeWindow && plan.chunkSeconds > 60) ||
      ![10, 20, 30, 60, 90, 120, 240].includes(plan.chunkSeconds) || !Number.isInteger(plan.resetEveryChunks) || plan.resetEveryChunks < 0 || plan.resetEveryChunks > 300) throw Error('GPU 转写方案无效。');
  return plan;
}
function execute(file, args, { signal, timeout = 240000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', failure;
    const stop = () => { failure = signal?.reason || Error('GPU 转写已停止。'); child.kill(); };
    const timer = setTimeout(() => { failure = Error('音频准备超时。'); child.kill(); }, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    child.stderr.on('data', value => { stderr = (stderr + value).slice(-4096); });
    child.once('error', finish); child.once('close', code => finish(failure || (code ? Error('音频准备失败：' + stderr.slice(-500)) : null)));
    let ended = false;
    function finish(error) { if (ended) return; ended = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); error ? reject(error) : resolve(); }
  });
}
function providerFor({ root, runtime, plan, spawnImpl = spawn }) {
  if (plan.runtimeVariant !== 'bundled') {
    const ready = path.join(root, 'speech/gpu-v1/variants', plan.runtimeVariant, 'READY.json');
    if (!fs.existsSync(ready)) throw Error('GPU 运行库变体尚未完整准备，不能开始验收。');
    if (plan.runtimeRevision && hash(fs.readFileSync(ready)) !== plan.runtimeRevision) throw Error('GPU 运行库版本与方案不一致，请使用对应的冻结变体。');
  }
  const platform = createSpeechPlatform({ model: runtime.model, computeType: plan.computeType });
  if (platform.profile.device !== 'cuda') throw Error('此方法要求 Windows NVIDIA GPU，不支持 CPU 回退。');
  return new SpeechProvider({ root, runtime: { ...runtime, device: 'cuda', computeType: plan.computeType }, platform, timeoutMs: 120000,
    spawnImpl: (file, args, options) => spawnImpl(file, args, { ...options, windowsHide: true, env: { ...options.env,
      CT2_CUDA_ALLOCATOR: plan.allocator, CT2_CUDA_TRUE_FP16_GEMM: plan.fp16Gemm ? '1' : '0',
      CT2_CUDA_CACHING_ALLOCATOR_CONFIG: allocatorConfigFor(plan),
      CUDA_LAUNCH_BLOCKING: plan.launchBlocking ? '1' : '0',
      NOTION_SWITCH_SPEECH_CUDA_MEMINFO: '1',
      ...(plan.runtimeVariant !== 'bundled' ? { NOTION_SWITCH_CT2_MODULE_PATH: path.join(root, 'speech/gpu-v1/variants', plan.runtimeVariant),
        NOTION_SWITCH_SPEECH_PRELOAD_DLLS: plan.runtimeVariant === 'pinned-cudnn' ? '1' : '0' } : {}) } }) });
}

/** GPU-only file transcription, with a dedicated worker and durable raw records.
 * Does not require Notion, a browser, a desktop window, or a cloud service.
 */
async function transcribeGpuFile({ source, outputDirectory, root, ffmpeg, runtime, plan: requestedPlan,
  language = 'auto', signal, onProgress = () => {}, providerFactory = providerFor, executeImpl = execute } = {}) {
  if (![source, outputDirectory, root, ffmpeg].every(value => typeof value === 'string' && path.isAbsolute(value))) throw Error('输入、输出、运行环境和 FFmpeg 必须使用绝对路径。');
  const plan = normalizePlan(requestedPlan);
  if (plan.languageOverride && language === 'auto') language = plan.languageOverride;
  if (!['auto', 'en', 'zh'].includes(language)) throw Error('转写语言无效。');
  const decodingPolicy = plan.windowMode !== 'legacy' ? policy + '-complete-window' : plan.shortEncoder ? policy + '-short-encoder' : plan.nativeWholeWindow ? policy + '-native-window' : plan.batchSize > 1 ? policy + (plan.timestampedBatch ? '-batched-timestamps' : '-batched') : plan.beamSize === 1 ? policy + '-greedy' : policy;
  const stat = fs.statSync(source);
  if (!stat.isFile() || !stat.size) throw Error('输入音视频文件无效。');
  const selectedRuntime = runtime || JSON.parse(fs.readFileSync(path.join(root, 'speech.local.json'))).runtime;
  if (!selectedRuntime?.pythonExecutable || !selectedRuntime.modelDirectory) throw Error('本机 GPU 语音运行路径未配置。');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const lock = path.join(outputDirectory, '.transcription.lock');
  let descriptor;
  try { descriptor = fs.openSync(lock, 'wx'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; const owner = JSON.parse(fs.readFileSync(lock));
    try { process.kill(owner.pid, 0); throw Error('此输出目录已有转写任务运行。'); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; fs.unlinkSync(lock); descriptor = fs.openSync(lock, 'wx'); }
  }
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fs.closeSync(descriptor);
  const sourceIdentity = hash(JSON.stringify([fs.realpathSync(source), stat.size, stat.mtimeMs]));
    const identity = hash(JSON.stringify([sourceIdentity, plan, selectedRuntime.model, decodingPolicy, language]));
  const checkpointFile = path.join(outputDirectory, 'checkpoint.json');
  const eventsFile = path.join(outputDirectory, 'raw-results.jsonl');
  const record = event => fs.appendFileSync(eventsFile, JSON.stringify({ at: new Date().toISOString(), plan: plan.id, ...event }) + '\n', { flush: true });
  let speech, gpuLease, checkpoint = { version: 1, identity, sourceIdentity, plan, policy: decodingPolicy, language, parts: [] };
  try {
    if (fs.existsSync(checkpointFile)) {
      const saved = JSON.parse(fs.readFileSync(checkpointFile));
      if (saved.identity !== identity) throw Error('已有检查点属于其他文件或方案，请选择独立输出目录。');
      checkpoint = saved;
    }
    const pcmFile = path.join(outputDirectory, 'audio.s16le'), pcmIdentity = path.join(outputDirectory, 'audio-source.json');
    if (!fs.existsSync(pcmFile) || !fs.existsSync(pcmIdentity) || JSON.parse(fs.readFileSync(pcmIdentity)).sourceIdentity !== sourceIdentity) {
      onProgress({ stage: 'preparing', plan: plan.id });
      const temporary = pcmFile + '.partial';
      await executeImpl(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', source, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', '-y', temporary], { signal });
      if (!fs.statSync(temporary).size || fs.statSync(temporary).size % 2) throw Error('解码后的音频不完整。');
      fs.renameSync(temporary, pcmFile); await writeAtomicJson(pcmIdentity, { sourceIdentity });
    }
    const audioBytes = fs.statSync(pcmFile).size, totalSamples = audioBytes / 2, chunkSamples = plan.chunkSeconds * 16000;
    const totalChunks = Math.ceil(totalSamples / chunkSamples);
    gpuLease = await acquireGpuLease({ root, signal, onWait: owner => onProgress({ stage: 'waiting-gpu', plan: plan.id, ownerPid: owner.pid }) });
    speech = providerFactory({ root, runtime: selectedRuntime, plan });
    if (speech.status().device !== 'cuda') throw Error('GPU 转写拒绝使用 CPU。');
    speech.retain(); await speech.probe({ signal });
    record({ event: 'start', sourceIdentity, device: 'cuda', computeType: plan.computeType, allocator: plan.allocator,
      allocatorCache: plan.allocatorCache, allocatorConfig: allocatorConfigFor(plan), fp16Gemm: plan.fp16Gemm,
      runtimeVariant: plan.runtimeVariant, runtimeRevision: plan.runtimeRevision,
      runtime: { pythonExecutable: selectedRuntime.pythonExecutable, modelDirectory: selectedRuntime.modelDirectory, dllDirectory: selectedRuntime.dllDirectory, dllDirectories: selectedRuntime.dllDirectories },
      totalSamples, totalChunks, resumedChunks: checkpoint.parts.length });
    const input = fs.openSync(pcmFile, 'r');
    try {
      for (let index = 0; index < totalChunks; index++) {
        signal?.throwIfAborted();
        const startSample = index * chunkSamples, samples = Math.min(chunkSamples, totalSamples - startSample);
        const saved = checkpoint.parts[index];
        if (saved && saved.index === index && saved.startSample === startSample && saved.samples === samples && typeof saved.text === 'string' && !transcriptQualityIssue(saved.text)) continue;
        if (plan.resetEveryChunks && index && index % plan.resetEveryChunks === 0) await speech.close();
        const bytes = Buffer.alloc(samples * 2);
        if (fs.readSync(input, bytes, 0, bytes.length, startSample * 2) !== bytes.length) throw Error('音频样本读取不完整。');
        const pcm = Buffer.alloc(samples * 4);
        for (let i = 0; i < samples; i++) pcm.writeFloatLE(bytes.readInt16LE(i * 2) / 32768, i * 4);
        validatePcm(pcm, plan.batchSize > 1 || plan.nativeWholeWindow ? plan.chunkSeconds : 60);
        onProgress({ stage: 'transcribing', plan: plan.id, index, totalChunks, seconds: startSample / 16000, totalSeconds: totalSamples / 16000 });
        let accepted;
        for (let attempt = 1; attempt <= 1; attempt++) {
          try {
            accepted = await speech.request('transcribe', { audio: pcm.toString('base64'), language, context: '', decodingPolicy,
              ...(plan.nativeWholeWindow ? { nativeWindowSeconds: plan.chunkSeconds,
                ...(plan.windowMode !== 'legacy' ? { windowMode: plan.windowMode } : {}) } : {}),
              ...(plan.batchSize > 1 ? { batchSize: plan.batchSize, ...(plan.batchClipSeconds ? { clipSeconds: plan.batchClipSeconds } : {}),
                ...(plan.encoderMicrobatchSize ? { encoderMicrobatchSize: plan.encoderMicrobatchSize } : {}),
                ...(plan.gpuEncoderBridge ? { gpuEncoderBridge: true } : {}) } : {}) }, signal,
              result => record({ event: 'result', index, startSample, samples, attempt,
                launcherPid: speech.child?.pid || null, workerPid: Number.isInteger(result.workerPid) ? result.workerPid : null,
                pcmSha256: hash(pcm), device: 'cuda', result }));
            if (typeof accepted?.text !== 'string') throw Error('GPU 未返回逐字稿文本。');
            const issue = transcriptQualityIssue(accepted.text);
            if (issue) throw Object.assign(Error(issue), { code: 'SPEECH_UNRELIABLE' });
            break;
          } catch (error) {
            signal?.throwIfAborted();
            record({ event: 'error', index, startSample, attempt, error: error.message, code: error.code || null,
              workerExit: speech.status().lastWorkerExit || null, workerStderr: speech.stderrTail?.slice(-8192) || '' });
            await speech.close();
            throw error;
          }
        }
        checkpoint.parts[index] = { index, startSample, samples, text: accepted.text,
          segments: (accepted.segments || []).map(segment => ({ ...segment, start: segment.start + startSample / 16000, end: segment.end + startSample / 16000 })), device: 'cuda' };
        checkpoint.totalSamples = totalSamples; checkpoint.totalChunks = totalChunks;
        const persisted = await writeAtomicJson(checkpointFile, checkpoint);
        if (persisted.renameAttempts > 1) record({ event: 'persistence-retry', target: 'checkpoint.json', renameAttempts: persisted.renameAttempts });
      }
    } finally { fs.closeSync(input); }
    if (checkpoint.parts.length !== totalChunks || checkpoint.parts.reduce((n, part) => n + part.samples, 0) !== totalSamples) throw Error('逐字稿未覆盖全部音频样本。');
    const text = checkpoint.parts.map(part => part.text.trim()).filter(Boolean).join('\n');
    // A fully processed track can contain no speech, for example when it is music-only.
    if (transcriptQualityIssue(text)) throw Error('完整逐字稿未通过内容检查。');
    const transcriptFile = path.join(outputDirectory, 'transcript.txt');
    fs.writeFileSync(transcriptFile, text + '\n', { flush: true });
    const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse);
    const errors = events.filter(event => event.event === 'error');
    const result = { version: 1, policy: decodingPolicy, plan, sourceIdentity, device: 'cuda', complete: true,
      recoveries: errors.length, nativeExits: errors.filter(event => event.workerExit?.hexCode === '0xc0000409' && event.code !== 'SPEECH_UNRELIABLE').length,
      totalSamples, duration: totalSamples / 16000, chunks: totalChunks, characters: text.length,
      transcriptFile, eventsFile, checkpointFile, transcriptSha256: hash(text), text };
    await writeAtomicJson(path.join(outputDirectory, 'result.json'), result);
    record({ event: 'complete', duration: result.duration, totalSamples, totalChunks, transcriptSha256: result.transcriptSha256 });
    onProgress({ stage: 'completed', plan: plan.id, totalChunks });
    return result;
  } catch (error) { record({ event: 'failed', error: error.message,
    ...(error.tempPath ? { category: 'persistence', tempPath: error.tempPath, targetPath: error.targetPath, renameAttempts: error.renameAttempts } : {}) }); throw error; }
  finally {
    try { await speech?.close(); }
    finally { try { await gpuLease?.release(); } finally { try { fs.unlinkSync(lock); } catch {} } }
  }
}
module.exports = { transcribeGpuFile, defaultPlan, normalizePlan, execute, providerFor, allocatorConfigFor };
