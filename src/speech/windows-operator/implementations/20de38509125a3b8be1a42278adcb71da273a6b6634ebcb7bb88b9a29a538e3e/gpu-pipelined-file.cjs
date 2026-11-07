const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { defaultPlan: originalDefault, normalizePlan: normalizeOriginal, providerFor } = require('./gpu-file.cjs');
const { openPcmPipeline } = require('./pcm-pipeline.cjs');
const { acquireGpuLease } = require('./gpu-lease.cjs');
const { writeAtomicJson } = require('./atomic-json.cjs');
const { validatePcm } = require('./wav.cjs');
const { transcriptQualityIssue } = require('./transcript-quality.cjs');

const pipelineVersion = 'native30-pcm-spool-v1';
const defaultPlan = Object.freeze({ ...originalDefault, id: 'gpu-native-pipelined-v1' });
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
function normalizePlan(value = defaultPlan) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('流水线方案无效。');
  const plan = normalizeOriginal({ ...defaultPlan, ...value });
  if (plan.batchSize !== 1 || plan.beamSize !== 1 || plan.runtimeVariant !== 'sm75-native' || plan.computeType !== 'float16') throw Error('流水线实验仅支持已验证的Native单路FP16 greedy路径。');
  return plan;
}
const seconds = (from, to) => from && to ? (Date.parse(to) - Date.parse(from)) / 1000 : null;

/** Experimental preparation/inference overlap, retaining Native30 neural math.
 * Its distinct entry file and pipelineVersion must be included in run identity.
 */
async function transcribeGpuFile({ source, outputDirectory, root, ffmpeg, runtime, plan: requestedPlan,
  language = 'auto', signal: externalSignal, onProgress = () => {}, providerFactory = providerFor,
  audioFactory = openPcmPipeline } = {}) {
  const timing = { coldTaskStarted: now(), pipelineVersion, timingScope: 'cold-task-to-complete; GPU-ready scope recorded separately' };
  if (![source, outputDirectory, root, ffmpeg].every(value => typeof value === 'string' && path.isAbsolute(value))) throw Error('输入、输出、运行环境和FFmpeg必须使用绝对路径。');
  const plan = normalizePlan(requestedPlan), decodingPolicy = 'stable-gpu-v1-greedy';
  if (plan.languageOverride && language === 'auto') language = plan.languageOverride;
  if (!['auto', 'en', 'zh'].includes(language)) throw Error('转写语言无效。');
  externalSignal?.throwIfAborted();
  const stat = fs.statSync(source);
  if (!stat.isFile() || !stat.size) throw Error('输入音视频文件无效。');
  const selectedRuntime = runtime || JSON.parse(fs.readFileSync(path.join(root, 'speech.local.json'))).runtime;
  if (!selectedRuntime?.pythonExecutable || !selectedRuntime.modelDirectory) throw Error('本机GPU语音运行路径未配置。');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const lock = path.join(outputDirectory, '.transcription.lock');
  let descriptor;
  try { descriptor = fs.openSync(lock, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = JSON.parse(fs.readFileSync(lock));
    try { process.kill(owner.pid, 0); throw Error('此输出目录已有转写任务运行。'); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; fs.unlinkSync(lock); descriptor = fs.openSync(lock, 'wx'); }
  }
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, at: now(), pipelineVersion })); fs.closeSync(descriptor);
  const controller = new AbortController(), signal = controller.signal;
  const abort = () => controller.abort(externalSignal.reason || Error('GPU转写已停止。'));
  externalSignal?.addEventListener('abort', abort, { once: true }); if (externalSignal?.aborted) abort();
  const sourceIdentity = hash(JSON.stringify([fs.realpathSync(source), stat.size, stat.mtimeMs]));
  const identity = hash(JSON.stringify([pipelineVersion, sourceIdentity, plan, selectedRuntime.model, decodingPolicy, language]));
  const checkpointFile = path.join(outputDirectory, 'checkpoint.json'), eventsFile = path.join(outputDirectory, 'raw-results.jsonl');
  const record = event => fs.appendFileSync(eventsFile, JSON.stringify({ at: now(), plan: plan.id, ...event }) + '\n', { flush: true });
  let checkpoint = { version: 1, identity, sourceIdentity, plan, pipelineVersion, policy: decodingPolicy, language, parts: [] };
  let speech, gpuLease, audio, audioIterator, firstChunk, completedSamples = 0, seenChunks = 0;
  try {
    if (fs.existsSync(checkpointFile)) {
      const saved = JSON.parse(fs.readFileSync(checkpointFile));
      if (saved.identity !== identity || !Array.isArray(saved.parts)) throw Error('已有检查点属于其他文件或执行路径，请选择独立输出目录。');
      checkpoint = saved;
    }
    timing.audioStarted = now(); onProgress({ stage: 'preparing', plan: plan.id });
    audio = await audioFactory({ source, cacheFile: path.join(outputDirectory, 'audio.s16le'), markerFile: path.join(outputDirectory, 'audio-source.json'),
      sourceIdentity, ffmpeg, chunkSamples: plan.chunkSeconds * 16000, signal,
      onProgress: value => onProgress({ ...value, plan: plan.id }) });
    const audioCompletion = audio.completion.then(value => {
      timing.audioComplete = now(); timing.audioCacheCompletedAt = value.completedAt || null;
      timing.audioCacheReused = value.cacheReused === true; return value;
    });
    audioCompletion.catch(error => { if (!signal.aborted) controller.abort(error); });
    audioIterator = audio[Symbol.asyncIterator]();
    firstChunk = audioIterator.next().then(value => { timing.firstChunkReady = now(); return value; });
    firstChunk.catch(error => { if (!signal.aborted) controller.abort(error); });
    timing.gpuQueueStarted = now();
    gpuLease = await acquireGpuLease({ root, signal, onWait: owner => onProgress({ stage: 'waiting-gpu', plan: plan.id, ownerPid: owner.pid }) });
    timing.gpuAcquired = now(); timing.waitQueueSeconds = seconds(timing.gpuQueueStarted, timing.gpuAcquired);
    speech = providerFactory({ root, runtime: selectedRuntime, plan });
    if (speech.status().device !== 'cuda') throw Error('流水线GPU转写拒绝使用CPU。');
    speech.retain();
    await speech.probe({ signal }); timing.modelReady = now();
    let next = await firstChunk; signal.throwIfAborted();
    timing.recognitionStarted = now();
    const known = audio.status();
    record({ event: 'start', pipelineVersion, sourceIdentity, device: 'cuda', computeType: plan.computeType,
      allocator: plan.allocator, runtime: { pythonExecutable: selectedRuntime.pythonExecutable, modelDirectory: selectedRuntime.modelDirectory,
        dllDirectory: selectedRuntime.dllDirectory, dllDirectories: selectedRuntime.dllDirectories },
      totalSamples: known.decoded ? known.bytesWritten / 2 : null,
      totalChunks: known.decoded ? Math.ceil(known.bytesWritten / 2 / (plan.chunkSeconds * 16000)) : null,
      resumedChunks: checkpoint.parts.length });
    while (!next.done) {
      signal.throwIfAborted();
      const part = next.value, { index, startSample, samples, pcm16 } = part;
      if (index !== seenChunks || startSample !== completedSamples || pcm16.length !== samples * 2) throw Error('音频流水线样本不连续。');
      const saved = checkpoint.parts[index];
      if (!(saved && saved.index === index && saved.startSample === startSample && saved.samples === samples && typeof saved.text === 'string' && !transcriptQualityIssue(saved.text))) {
        if (plan.resetEveryChunks && index && index % plan.resetEveryChunks === 0) await speech.close();
        const pcm = Buffer.alloc(samples * 4);
        for (let i = 0; i < samples; i++) pcm.writeFloatLE(pcm16.readInt16LE(i * 2) / 32768, i * 4);
        validatePcm(pcm);
        const state = audio.status(), totalSamples = state.decoded ? state.bytesWritten / 2 : undefined;
        onProgress({ stage: 'transcribing', plan: plan.id, index, seconds: startSample / 16000,
          totalSeconds: totalSamples && totalSamples / 16000, totalChunks: totalSamples && Math.ceil(totalSamples / (plan.chunkSeconds * 16000)) });
        let accepted;
        try {
          accepted = await speech.request('transcribe', { audio: pcm.toString('base64'), language, context: '', decodingPolicy }, signal,
            result => record({ event: 'result', index, startSample, samples, attempt: 1, launcherPid: speech.child?.pid || null,
              workerPid: Number.isInteger(result.workerPid) ? result.workerPid : null, pcmSha256: hash(pcm), device: 'cuda', result }));
          if (typeof accepted?.text !== 'string') throw Error('GPU未返回逐字稿文本。');
          const issue = transcriptQualityIssue(accepted.text);
          if (issue) throw Object.assign(Error(issue), { code: 'SPEECH_UNRELIABLE' });
        } catch (error) {
          signal.throwIfAborted();
          record({ event: 'error', index, startSample, attempt: 1, error: error.message, code: error.code || null,
            workerExit: speech.status().lastWorkerExit || null, workerStderr: speech.stderrTail?.slice(-8192) || '' });
          await speech.close(); throw error;
        }
        checkpoint.parts[index] = { index, startSample, samples, text: accepted.text,
          segments: (accepted.segments || []).map(segment => ({ ...segment, start: segment.start + startSample / 16000, end: segment.end + startSample / 16000 })), device: 'cuda' };
        checkpoint.completedSamples = startSample + samples;
        const persisted = await writeAtomicJson(checkpointFile, checkpoint);
        if (persisted.renameAttempts > 1) record({ event: 'persistence-retry', target: 'checkpoint.json', renameAttempts: persisted.renameAttempts });
      }
      completedSamples += samples; seenChunks++; next = await audioIterator.next();
    }
    const prepared = await audioCompletion; signal.throwIfAborted();
    if (completedSamples !== prepared.totalSamples || checkpoint.parts.length !== seenChunks || checkpoint.parts.reduce((sum, part) => sum + part.samples, 0) !== prepared.totalSamples) throw Error('逐字稿未覆盖整片音频样本。');
    checkpoint.totalSamples = prepared.totalSamples; checkpoint.totalChunks = seenChunks; await writeAtomicJson(checkpointFile, checkpoint);
    const text = checkpoint.parts.map(part => part.text.trim()).filter(Boolean).join('\n');
    if (!text || transcriptQualityIssue(text)) throw Error('完整逐字稿未通过内容检查。');
    const transcriptFile = path.join(outputDirectory, 'transcript.txt'); fs.writeFileSync(transcriptFile, text + '\n', { flush: true });
    const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse), errors = events.filter(event => event.event === 'error');
    timing.completed = now(); timing.endToEndSeconds = seconds(timing.coldTaskStarted, timing.completed);
    timing.recognitionSeconds = seconds(timing.recognitionStarted, timing.completed);
    timing.firstChunkLatencySeconds = seconds(timing.audioStarted, timing.firstChunkReady);
    const result = { version: 1, policy: decodingPolicy, pipelineVersion, plan, sourceIdentity, device: 'cuda', complete: true,
      recoveries: errors.length, nativeExits: errors.filter(event => event.workerExit?.hexCode === '0xc0000409' && event.code !== 'SPEECH_UNRELIABLE').length,
      totalSamples: prepared.totalSamples, duration: prepared.totalSamples / 16000, chunks: seenChunks, characters: text.length,
      transcriptFile, eventsFile, checkpointFile, transcriptSha256: hash(text), text, pcmSha256: prepared.pcmSha256, timing };
    await writeAtomicJson(path.join(outputDirectory, 'result.json'), result);
    record({ event: 'complete', duration: result.duration, totalSamples: result.totalSamples, totalChunks: result.chunks, transcriptSha256: result.transcriptSha256 });
    onProgress({ stage: 'completed', plan: plan.id, totalChunks: result.chunks });
    return result;
  } catch (error) {
    timing.failed = now(); timing.failure = error.message;
    record({ event: 'failed', pipelineVersion, error: error.message,
      ...(error.tempPath ? { category: 'persistence', tempPath: error.tempPath, targetPath: error.targetPath, renameAttempts: error.renameAttempts } : {}) });
    throw error;
  } finally {
    if (!signal.aborted) controller.abort(Error('流水线任务已结束。'));
    try { await speech?.close(); }
    finally {
      try { await audio?.close(); }
      finally {
        try { await gpuLease?.release(); }
        finally {
          externalSignal?.removeEventListener('abort', abort);
          try { fs.unlinkSync(lock); } catch {}
          timing.resourcesReleased = now(); timing.endToEndIncludingCleanupSeconds = seconds(timing.coldTaskStarted, timing.resourcesReleased);
          await writeAtomicJson(path.join(outputDirectory, 'metrics.json'), timing);
        }
      }
    }
  }
}

module.exports = { transcribeGpuFile, normalizePlan, defaultPlan };
