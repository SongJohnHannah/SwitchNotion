const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const { writeAtomicJson } = require('./atomic-json.cjs');
const { acquireGpuLease } = require('./gpu-lease.cjs');

const sha = value => createHash('sha256').update(value).digest('hex');
const renameDelays = [10, 20, 40, 80, 160, 250];
async function renameComplete(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= renameDelays.length) throw error;
      await pause(renameDelays[attempt]);
    }
  }
}
async function hashFile(file, signal) {
  const handle = await fs.open(file, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(128 * 1024);
  try { for (;;) { signal?.throwIfAborted(); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); } }
  finally { await handle.close(); }
  return hash.digest('hex');
}

/** Decode the first audio stream once, while a CUDA consumer reads complete
 * PCM16 blocks from a disk spool. No video frame decoder is requested.
 *
 * for-await automatically closes the cache lease. If no iteration is started,
 * the caller must await close() in finally. completion reports AUDIO decoding,
 * never a successful transcript. A valid complete cache survives ASR cancellation.
 */
async function openPcmPipeline({ source, cacheFile, markerFile = cacheFile && cacheFile + '.source.json', sourceIdentity,
  ffmpeg, chunkSamples = 480000, maxAudioBytes = 32 * 1024 ** 3, timeoutMs = 240000,
  signal, onProgress = () => {}, spawnImpl = spawn } = {}) {
  if (![source, cacheFile, markerFile, ffmpeg].every(value => typeof value === 'string' && path.isAbsolute(value)) ||
      !Number.isSafeInteger(chunkSamples) || chunkSamples < 1 || chunkSamples > 16000 * 240 ||
      !Number.isSafeInteger(maxAudioBytes) || maxAudioBytes < 2 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || typeof spawnImpl !== 'function') throw TypeError('Invalid PCM pipeline options');
  signal?.throwIfAborted();
  const sourceStat = await fs.stat(source);
  if (!sourceStat.isFile() || !sourceStat.size) throw Error('输入音视频文件无效。');
  sourceIdentity ??= sha(JSON.stringify([await fs.realpath(source), sourceStat.size, sourceStat.mtimeMs]));
  if (typeof sourceIdentity !== 'string' || !sourceIdentity) throw TypeError('Invalid audio source identity');
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.mkdir(path.dirname(markerFile), { recursive: true });
  // This lease serializes this cache only; its independent root never occupies
  // the shared CUDA lease or prevents audio preparation beside GPU inference.
  const cacheLease = await acquireGpuLease({ root: cacheFile + '.lockspace', signal });
  const controller = new AbortController(), abort = () => controller.abort(signal.reason || Error('音频准备已取消。'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const startedAt = new Date().toISOString(), waiters = new Set();
  let child, failure, decoded = false, bytesWritten = 0, readTarget, iteratorStarted = false, consumed = false, released = false;
  let diskQueue = Promise.resolve(), temporary, timer, closed, stderr = '';
  const changed = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  const disk = action => { const next = diskQueue.then(action); diskQueue = next.catch(() => {}); return next; };
  const cancelled = () => { child?.kill(); changed(); };
  controller.signal.addEventListener('abort', cancelled, { once: true });
  async function release() { if (released) return; released = true; signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', cancelled); await cacheLease.release(); }
  async function existing() {
    try {
      const marker = JSON.parse(await fs.readFile(markerFile, 'utf8')), stat = await fs.stat(cacheFile);
      if (marker.version !== 1 || marker.complete !== true || marker.sourceIdentity !== sourceIdentity || marker.sampleRate !== 16000 ||
          marker.channels !== 1 || marker.sampleFormat !== 's16le' || marker.bytes !== stat.size || !stat.size || stat.size % 2 ||
          marker.pcmSha256 !== await hashFile(cacheFile, controller.signal)) return null;
      return { ...marker, cacheFile, markerFile, cacheReused: true };
    } catch (error) { controller.signal.throwIfAborted(); if (['ENOENT', 'ENOTDIR'].includes(error.code) || error instanceof SyntaxError) return null; throw error; }
  }
  const completion = (async () => {
    let writer;
    try {
      const saved = await existing();
      if (saved) { bytesWritten = saved.bytes; readTarget = cacheFile; decoded = true; changed(); return saved; }
      controller.signal.throwIfAborted();
      temporary = cacheFile + '.' + randomUUID() + '.partial'; readTarget = temporary;
      writer = await fs.open(temporary, 'wx');
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', source, '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'];
      child = spawnImpl(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal })); });
      closed.catch(() => {});
      child.stderr.on('data', value => { stderr = (stderr + value.toString()).slice(-8192); });
      timer = setTimeout(() => controller.abort(Error('音频准备超时。')), timeoutMs);
      const hash = createHash('sha256');
      for await (const value of child.stdout) {
        controller.signal.throwIfAborted();
        if (bytesWritten + value.length > maxAudioBytes) throw Error('解码音轨超过缓存上限，已停止。');
        let written = 0;
        while (written < value.length) {
          const result = await writer.write(value, written, value.length - written, bytesWritten + written);
          if (!result.bytesWritten) throw Error('音频缓存写入中断。');
          written += result.bytesWritten;
        }
        hash.update(value); bytesWritten += value.length; changed();
        onProgress({ stage: 'audio-decoding', bytesWritten, availableSamples: Math.floor(bytesWritten / 2) });
      }
      const exit = await closed;
      controller.signal.throwIfAborted();
      if (exit.code !== 0) throw Error('音频解码失败：' + (stderr.trim().slice(-2000) || `FFmpeg退出${exit.code}/${exit.signal}`));
      if (!bytesWritten || bytesWritten % 2) throw Error('解码后的音频样本不完整。');
      const finalStat = await fs.stat(source);
      if (finalStat.size !== sourceStat.size || finalStat.mtimeMs !== sourceStat.mtimeMs) throw Error('解码过程中原文件已改变，未发布缓存。');
      await writer.sync(); await writer.close(); writer = null;
      const marker = { version: 1, complete: true, sourceIdentity, bytes: bytesWritten, totalSamples: bytesWritten / 2,
        sampleRate: 16000, channels: 1, sampleFormat: 's16le', pcmSha256: hash.digest('hex'), startedAt, completedAt: new Date().toISOString() };
      await disk(async () => { await renameComplete(temporary, cacheFile); readTarget = cacheFile; await writeAtomicJson(markerFile, marker); });
      decoded = true; changed();
      return { ...marker, cacheFile, markerFile, cacheReused: false };
    } catch (error) {
      failure = controller.signal.aborted ? controller.signal.reason : error;
      child?.kill(); await closed?.catch(() => {}); changed(); throw failure;
    } finally { clearTimeout(timer); await writer?.close().catch(() => {}); }
  })();
  // A caller can start the GPU warmup before awaiting the first PCM block.
  // Keep producer failures observable without creating an unhandled rejection.
  completion.catch(() => {});
  async function close() {
    if (!consumed && !controller.signal.aborted) controller.abort(Error('音频消费者已结束，未完成转写。'));
    await completion.catch(() => {}); await release();
  }
  return {
    completion,
    cancel: reason => controller.abort(reason || Error('音频准备已取消。')),
    close,
    status: () => ({ decoded, bytesWritten, bufferedChunks: 0, partialFile: temporary || null, cacheFile, sourceIdentity }),
    [Symbol.asyncIterator]: async function* () {
      if (iteratorStarted) throw Error('音频流水线只能消费一次。');
      iteratorStarted = true; let at = 0, index = 0;
      try {
        for (;;) {
          controller.signal.throwIfAborted();
          while (bytesWritten - at < chunkSamples * 2 && !decoded && !failure) {
            await new Promise(resolve => { waiters.add(resolve); }); controller.signal.throwIfAborted();
          }
          if (failure) throw failure;
          const remaining = bytesWritten - at;
          if (!remaining && decoded) break;
          const bytes = Math.min(chunkSamples * 2, remaining);
          if (!bytes || bytes % 2) throw Error('音频尾段样本不完整。');
          const pcm16 = await disk(async () => {
            const result = Buffer.alloc(bytes), input = await fs.open(readTarget, 'r');
            try {
              let position = 0;
              while (position < bytes) { const item = await input.read(result, position, bytes - position, at + position); if (!item.bytesRead) throw Error('音频缓存读取不完整。'); position += item.bytesRead; }
              return result;
            } finally { await input.close(); }
          });
          controller.signal.throwIfAborted(); if (failure) throw failure;
          yield { index: index++, startSample: at / 2, samples: bytes / 2, pcm16 };
          at += bytes;
        }
        await completion; consumed = true;
      } finally { await close(); }
    },
  };
}

module.exports = { openPcmPipeline };
