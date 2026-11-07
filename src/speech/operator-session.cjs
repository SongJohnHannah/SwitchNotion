'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { acquireGpuLease } = require('./gpu-lease.cjs');
const { createSpeechPlatform } = require('./platform.cjs');
const { decodeWav, validatePcm } = require('./wav.cjs');
const { transcriptQualityIssue } = require('./transcript-quality.cjs');
const { normalizePlan, defaultPlan } = require('./gpu-file.cjs');

const MODEL = 'large-v3-turbo';
const POLICY = 'stable-gpu-v1-greedy';
const digest = value => createHash('sha256').update(value).digest('hex');
function providerFor(options) { return require('./gpu-file.cjs').providerFor(options); }
function checkLanguage(language) {
  if (!['auto', 'en', 'zh'].includes(language)) throw Error('转写语言须为 auto、en 或 zh。');
}

function nativePlan(value) {
  const plan = normalizePlan({ ...(value || defaultPlan), languageOverride: null });
  if (plan.runtimeVariant !== 'sm75-native' || plan.computeType !== 'float16' ||
      plan.allocator !== 'cub_caching' || plan.fp16Gemm !== false || plan.launchBlocking !== true ||
      plan.beamSize !== 1 || plan.batchSize !== 1 || plan.chunkSeconds !== 30 ||
      plan.resetEveryChunks !== 0 || plan.batchClipSeconds !== 0 || plan.encoderMicrobatchSize !== 0 ||
      plan.timestampedBatch === true || plan.nativeWholeWindow === true || plan.gpuEncoderBridge === true || plan.shortEncoder === true || plan.windowMode !== 'legacy' || plan.allocatorCache !== 'default') {
    throw Error('实时会话仅允许冻结的 Native30 CUDA13/sm75、FP16、同步 greedy1 方案。');
  }
  return Object.freeze(plan);
}

class OperatorSpeechSession {
  constructor({ root, runtime, planNative, providerFactory = providerFor,
    acquireLease = acquireGpuLease, onProgress = () => {}, platform } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw Error('独立算子资源须使用绝对目录。');
    if (typeof providerFactory !== 'function' || typeof acquireLease !== 'function') throw TypeError('Invalid session factories');
    this.root = root;
    this.plan = nativePlan(planNative);
    const base = platform || createSpeechPlatform({ model: MODEL, computeType: 'float16' });
    if (base.profile?.model !== MODEL || base.profile?.device !== 'cuda' || base.profile?.computeType !== 'float16') {
      throw Error('独立实时算子要求 Windows NVIDIA CUDA FP16 Turbo，不能回退 CPU。');
    }
    let facade;
    facade = Object.freeze({ ...base, withModel: model => {
      if (model !== MODEL) throw Object.assign(Error('独立实时算子仅支持 large-v3-turbo。'), { code: 'SPEECH_MODEL_UNSUPPORTED' });
      return facade;
    } });
    this.platform = facade;
    this.runtime = this._normalizeRuntime(runtime);
    this.providerFactory = providerFactory; this.acquireLease = acquireLease; this.onProgress = onProgress;
    this.sessionId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID();
    this.recordDirectory = path.join(root, 'speech', 'operator-sessions', this.sessionId);
    this.eventsFile = path.join(this.recordDirectory, 'raw-results.jsonl');
    this.provider = null; this.gpuLease = null; this.leases = 0; this.pending = 0;
    this.sequence = 0; this.epoch = 0; this.checked = false; this.lastFailure = '';
    this.queue = Promise.resolve(); this.shutdown = Promise.resolve(); this.logQueue = Promise.resolve();
    this.controller = new AbortController(); this.stopping = null; this.cleaning = null;
    this.cleanupFailure = null;
  }

  _normalizeRuntime(runtime) {
    if (!runtime || runtime.model !== MODEL || runtime.device !== 'cuda' || runtime.computeType !== 'float16') {
      throw Error('独立实时算子运行配置必须为 large-v3-turbo / CUDA / float16，不能回退 CPU。');
    }
    return this.platform.normalizeRuntime(runtime);
  }

  status() {
    const underlying = this.provider?.status() || {};
    return { ...this.platform.profile, protocolVersion: 1, configured: Boolean(this.runtime),
      ready: this.checked, loaded: Boolean(underlying.loaded || this.provider?.child && underlying.ready),
      busy: this.pending > 0, lastFailure: this.lastFailure || underlying.lastFailure || '',
      lastWorkerExit: underlying.lastWorkerExit || null, languages: ['auto', 'zh', 'en'],
      leases: this.leases, sharedOperator: true, runtimeVariant: 'sm75-native',
      decodingPolicy: POLICY, sessionId: this.sessionId, eventsFile: this.eventsFile };
  }

  _record(event) {
    const line = JSON.stringify({ at: new Date().toISOString(), sessionId: this.sessionId,
      plan: this.plan.id, policy: POLICY, ...event }) + '\n';
    const next = this.logQueue.then(async () => {
      await fsp.mkdir(this.recordDirectory, { recursive: true });
      await fsp.appendFile(this.eventsFile, line, { encoding: 'utf8', flush: true });
    });
    this.logQueue = next.catch(() => {});
    return next;
  }

  async _getProvider() {
    if (this.stopping) await this.stopping;
    if (this.cleanupFailure) throw Error('独立实时进程尚未确认关闭，请先重试 close()：' + this.cleanupFailure.message);
    if (!this.provider) {
      this.runtime = this._normalizeRuntime(this.runtime);
      this.provider = this.providerFactory({ root: this.root, runtime: this.runtime, plan: this.plan });
      this._requireGpu();
      this.provider.retain?.(); // Session lifetime, rather than an idle timer, owns this worker.
    }
    this._requireGpu();
    return this.provider;
  }

  _requireGpu() {
    const status = this.provider?.status();
    if (status?.device !== 'cuda' || status.computeType && status.computeType !== 'float16' ||
        status.model && status.model !== MODEL) throw Error('独立实时算子拒绝 CPU 或非 Native Turbo FP16 provider。');
  }

  async _ensureGpu(signal) {
    if (this.cleaning) await this.cleaning;
    if (!this.gpuLease) {
      this.gpuLease = await this.acquireLease({ root: this.root, signal,
        onWait: owner => this.onProgress({ stage: 'waiting-gpu', ownerPid: owner.pid, sessionId: this.sessionId }) });
    }
    signal.throwIfAborted();
    return this._getProvider();
  }

  _stopProvider() {
    if (this.stopping) return this.stopping;
    const provider = this.provider;
    if (!provider) return Promise.resolve();
    const stopping = Promise.resolve().then(() => provider.close()).then(() => {
      if (this.provider === provider) this.provider = null;
    });
    this.stopping = stopping.finally(() => { this.stopping = null; });
    return this.stopping;
  }

  _cleanupRuntime() {
    if (this.cleaning) return this.cleaning;
    const cleanup = (async () => {
      // A rejected close keeps the lease; uncertain worker termination must not
      // let the next project load another CUDA context over this worker.
      await this._stopProvider();
      if (this.gpuLease) {
        const lease = this.gpuLease;
        await lease.release();
        if (this.gpuLease === lease) this.gpuLease = null;
      }
      this.cleanupFailure = null;
    })();
    this.cleaning = cleanup.catch(error => { this.cleanupFailure = error; throw error; })
      .finally(() => { this.cleaning = null; });
    return this.cleaning;
  }

  _enqueue(task, { signal, gpu = true } = {}) {
    signal?.throwIfAborted();
    const epoch = this.epoch, lifetime = this.controller.signal, barrier = this.shutdown;
    const combined = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
    this.pending++;
    const run = async () => {
      let failure;
      try {
        await barrier; combined.throwIfAborted();
        if (epoch !== this.epoch) throw Error('独立实时会话已停止。');
        const provider = gpu ? await this._ensureGpu(combined) : await this._getProvider();
        combined.throwIfAborted();
        const result = await task(provider, combined);
        combined.throwIfAborted();
        return result;
      } catch (error) { failure = error; this.checked = false; this.lastFailure = error.message; throw error; }
      finally {
        this.pending--;
        if (failure || this.leases === 0) {
          try { await this._cleanupRuntime(); }
          catch (cleanupError) {
            this.lastFailure = cleanupError.message;
            if (failure) failure.cleanupError = cleanupError.message;
            else throw cleanupError;
          }
        }
      }
    };
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }

  configure() {
    return this._enqueue(async provider => {
      for (const [file, directory] of [[this.runtime.pythonExecutable, false], [this.runtime.modelDirectory, true]]) {
        const stat = await fsp.stat(file);
        if (directory ? !stat.isDirectory() : !stat.isFile()) throw Error('独立算子运行资源无效：' + file);
      }
      const configured = await provider.configure();
      this.runtime = this._normalizeRuntime(configured || provider.runtime || this.runtime);
      this._requireGpu();
      await this._record({ event: 'configured', device: 'cuda', model: MODEL, runtimeVariant: this.plan.runtimeVariant });
      return this.runtime;
    }, { gpu: false });
  }

  async probe({ signal } = {}) {
    await this._enqueue(async (provider, combined) => {
      await provider.probe({ signal: combined }); this._requireGpu(); this.checked = true;
      await this._record({ event: 'probe', device: 'cuda', workerPid: provider.child?.pid || null });
    }, { signal });
    return this.status();
  }

  _request(type, fields, metadata, { signal, onResult } = {}) {
    return this._enqueue(async (provider, combined) => {
      const requestId = ++this.sequence;
      await this._record({ event: 'input', requestId, type, ...metadata, language: fields.language, device: 'cuda' });
      let recorded = false;
      const recordResult = async result => {
        if (recorded) return;
        await this._record({ event: 'result', requestId, type, ...metadata,
          workerPid: Number.isInteger(result?.workerPid) ? result.workerPid : provider.child?.pid || null,
          ...(type === 'transcribe_recording' ? { pcmSha256: result?.recordingDecode?.pcmSha256 || null,
            decodedSamples: result?.recordingDecode?.samples ?? null } : {}), result });
        recorded = true;
      };
      try {
        // SpeechProvider invokes this hook before its punctuation quality guard.
        // Thus even an invalid raw return survives the failed request on disk.
        const result = await provider.request(type, fields, combined, recordResult);
        if (!recorded) await recordResult(result);
        combined.throwIfAborted();
        this._requireGpu();
        if (result?.device && result.device !== 'cuda') throw Error('独立实时算子拒绝非 CUDA 返回。');
        if (typeof result?.text !== 'string') throw Error('独立实时算子未返回逐字稿文字。');
        const issue = transcriptQualityIssue(result.text);
        if (issue) throw Object.assign(Error(issue), { code: 'SPEECH_UNRELIABLE' });
        this.checked = true;
        await onResult?.(result);
        return result;
      } catch (error) {
        try { await this._record({ event: 'error', requestId, type, error: error.message,
          code: error.code || null, workerExit: provider.status()?.lastWorkerExit || null,
          workerStderr: provider.stderrTail?.slice(-8192) || '' }); }
        catch (recordError) { error.recordError = recordError.message; }
        throw error;
      }
    }, { signal });
  }

  async transcribeDetailed({ pcm, language = 'auto', context = '', signal, onResult } = {}) {
    validatePcm(pcm); checkLanguage(language);
    if (typeof context !== 'string' || context.length > 400 || /[\u0000-\u0008]/.test(context)) throw Error('音频上下文格式无效。');
    const input = Buffer.from(pcm);
    const result = await this._request('transcribe', { audio: input.toString('base64'), language,
      context: '', decodingPolicy: POLICY }, { pcmSha256: digest(input), inputBytes: input.length,
      inputSamples: input.length / 4, sampleRate: 16000, sampleFormat: 'float32-le-mono' }, { signal, onResult });
    return { text: result.text, context: typeof result.contextText === 'string' ? result.contextText.slice(-120) : '', language: result.language };
  }

  async transcribe(options) { return (await this.transcribeDetailed(options)).text; }

  async transcribeRecording({ audio, language = 'auto', signal, onResult } = {}) {
    checkLanguage(language);
    if (!Buffer.isBuffer(audio) || audio.length < 4 || audio.length > 16 * 1024 * 1024 || audio.readUInt32BE() !== 0x1a45dfa3) throw Error('音频录音格式无效。');
    const input = Buffer.from(audio);
    const result = await this._request('transcribe_recording', { audio: input.toString('base64'), language,
      context: '', decodingPolicy: POLICY }, { encodedSha256: digest(input), inputBytes: input.length,
      inputContainer: 'webm' }, { signal, onResult });
    return result.text;
  }

  async transcribeWav({ wav, language = 'auto', signal, onProgress = () => {}, onResult, chunkSeconds = 30 } = {}) {
    checkLanguage(language);
    if (!Number.isInteger(chunkSeconds) || chunkSeconds < 1 || chunkSeconds > 30) throw Error('语音分段须为 1 到 30 秒。');
    const { pcm } = decodeWav(wav), texts = [], limit = chunkSeconds * 16000 * 4;
    this.retain();
    try {
      for (let at = 0; at < pcm.length; at += limit) {
        const chunk = pcm.subarray(at, Math.min(pcm.length, at + limit));
        texts.push(await this.transcribe({ pcm: chunk, language, signal,
          onResult: onResult && (result => onResult({ ...result, start: at / 64000, duration: chunk.length / 64000 })) }));
        onProgress(Math.min(1, (at + limit) / pcm.length));
      }
      return texts.filter(Boolean).join('\n');
    } finally { await this.release(); }
  }

  retain() { this.leases++; return this.leases; }
  release() {
    this.leases = Math.max(0, this.leases - 1);
    const drain = this.queue.then(() => { if (!this.leases && !this.pending) return this._cleanupRuntime(); });
    drain.catch(error => { this.lastFailure = error.message; }); // Legacy callers need not await release.
    return drain;
  }

  close() {
    const oldQueue = this.queue;
    this.epoch++; this.leases = 0; this.checked = false;
    this.controller.abort(Error('独立实时会话已停止。'));
    this.controller = new AbortController();
    // Stop only our provider immediately. Keep the lease until the active
    // request and its raw-result/error persistence have drained as well.
    const stopped = this._stopProvider();
    const shutdown = (async () => {
      const results = await Promise.allSettled([stopped, oldQueue]);
      await this._cleanupRuntime();
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    this.shutdown = shutdown.catch(error => { this.lastFailure = error.message; });
    shutdown.catch(() => {}); // The compatibility close API may be fire-and-forget.
    return shutdown;
  }
}

function createSpeechSession(options) { return new OperatorSpeechSession(options); }
module.exports = { createSpeechSession, OperatorSpeechSession, POLICY };
