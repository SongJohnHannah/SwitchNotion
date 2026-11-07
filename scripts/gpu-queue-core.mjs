import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadGpuImplementation } from './gpu-runtime-snapshot.mjs';
const require = createRequire(import.meta.url);
let { normalizePlan } = require('../src/speech/gpu-file.cjs');
const { transcriptQualityIssue } = require('../src/speech/transcript-quality.cjs');
const { CollectionBinaries } = require('../src/collection/binaries.cjs');
const now = () => new Date().toISOString();
const hash = text => createHash('sha256').update(text).digest('hex');
function ordered(value) { return Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value; }
export function atomicJson(file, value) { const temp = file + '.' + randomUUID() + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flush: true }); fs.renameSync(temp, file); }
export function planFingerprint(plan) { const { id, ...execution } = normalizePlan(plan); return hash(JSON.stringify(ordered(execution))); }
const readLines = file => {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8'), rows = raw.split('\n'), result = [];
  for (const [index, row] of rows.entries()) {
    if (!row.trim()) continue;
    try { result.push(JSON.parse(row)); } catch (error) { if (index === rows.length - 1 && !raw.endsWith('\n')) break; throw error; }
  }
  return result;
};
function alive(pid) { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
function runtimeReady(root, plan) {
  if (plan.runtimeVariant === 'bundled') return true;
  const directory = path.join(root, 'speech/gpu-v1/variants', plan.runtimeVariant);
  return ['ctranslate2/__init__.py', 'variant.json', 'READY.json'].every(file => fs.existsSync(path.join(directory, file))) &&
    (!plan.runtimeRevision || hash(fs.readFileSync(path.join(directory, 'READY.json'))) === plan.runtimeRevision);
}
export function updateMethodVerification(method) {
  const completeRuns = (method.verifiedRuns || []).filter(run => run.complete && run.passed && !run.deferred && run.assessment?.passed === true && run.assessment?.independent === true);
  method.complete = completeRuns.length > 0;
  method.repeatVerified = new Set(completeRuns.map(run => run.outputDirectory)).size >= 2;
  method.validation = method.repeatVerified ? 'independent-full-video-twice' : method.complete ? 'full-video-once' : 'unverified';
  method.deliveryEligible = method.repeatVerified && method.qualityReview?.status !== 'content-review-needed';
  if (method.qualityReview?.status === 'content-review-needed') method.validation = 'execution-repeat-verified-content-review-needed';
  const performance = method.performance || { status: 'not-measured', cpuReferenceStatus: 'not-measured', note: '完整或重复转写通过，不代表已证明比 CPU 高效。' };
  const measured = performance.fairComparisonVerified === true && performance.sourceIdentity === method.sourceIdentity &&
    performance.planFingerprint === planFingerprint(method.plan) && performance.cpuComplete === true && performance.gpuComplete === true &&
    Number.isFinite(performance.cpuWallSeconds) && performance.cpuWallSeconds > 0 && Number.isFinite(performance.gpuWallSeconds) && performance.gpuWallSeconds > 0;
  method.performanceVerified = method.repeatVerified && measured && performance.gpuWallSeconds < performance.cpuWallSeconds;
  method.performance = { ...performance, status: measured ? !method.repeatVerified ? 'measured-awaiting-repeat' : method.performanceVerified ? 'verified-faster' : 'measured-not-faster' : performance.status === 'not-measured' ? 'not-measured' : 'not-verified' };
  return method;
}
export function externalJobActivity(external) {
  const lockFile = path.join(external.outputDirectory, '.transcription.lock');
  let lockOwner;
  try { lockOwner = JSON.parse(fs.readFileSync(lockFile)).pid; } catch {}
  const eventsFile = path.join(external.outputDirectory, 'raw-results.jsonl');
  const events = readLines(eventsFile), workers = [...new Set(events.map(event => event.workerPid).filter(Number.isInteger))];
  const livePids = [...new Set([external.pid, lockOwner, ...workers].filter(pid => alive(pid)))];
  const resultReady = fs.existsSync(path.join(external.outputDirectory, 'result.json'));
  const recentWrite = fs.existsSync(eventsFile) && Date.now() - fs.statSync(eventsFile).mtimeMs < 30000;
  return { active: livePids.length > 0 || (!resultReady && recentWrite), livePids, lockOwner, recentWrite, resultReady,
    latestIndex: events.filter(event => event.event === 'result').at(-1)?.index };
}
export function runMetrics(run, { directory } = {}) {
  const events = typeof run.outputDirectory === 'string' ? readLines(path.join(run.outputDirectory, 'raw-results.jsonl')) : [];
  let parts = [];
  try { parts = JSON.parse(fs.readFileSync(path.join(run.outputDirectory, 'checkpoint.json'))).parts || []; } catch {}
  const errors = events.filter(event => event.event === 'error'), firstError = errors[0];
  let startedAt = run.startedAt || null, startTimeSource = startedAt ? 'run-record' : null;
  if (!startedAt && directory) {
    for (const name of fs.readdirSync(directory).filter(name => name === 'active-external-job.json' || /^external-accounted-.*\.json$/.test(name))) {
      try { const external = JSON.parse(fs.readFileSync(path.join(directory, name))); if (external.outputDirectory === run.outputDirectory && external.startedAt) { startedAt = external.startedAt; startTimeSource = 'external-job-record'; break; } } catch {}
    }
    if (!startedAt) for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.stdout.log'))) {
      const file = path.join(directory, name); if (fs.statSync(file).size > 4 * 1024 * 1024) continue;
      for (const row of fs.readFileSync(file, 'utf8').split('\n')) {
        try { const event = JSON.parse(row); if (event.stage === 'plan-start' && event.outputDirectory === run.outputDirectory) { startedAt = event.startedAt || event.at; startTimeSource = 'queue-start-log'; break; } } catch {}
      }
      if (startedAt) break;
    }
  }
  if (!startedAt) { startedAt = events.find(event => event.event === 'start')?.at || null; startTimeSource = startedAt ? 'raw-gpu-stage-start' : null; }
  const endedAt = run.at || events.at(-1)?.at || null;
  const seconds = (from, to) => from && to && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to)) ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000) : null;
  const elapsed = events.filter(event => event.event === 'result').map(event => event.result?.elapsedMs).filter(Number.isFinite);
  const gaps = events.slice(1).map((event, i) => seconds(events[i].at, event.at)).filter(Number.isFinite);
  const explicitTdr = [run.error, ...errors.map(event => event.error), ...(run.failureDetails || []).map(item => item.detail)].filter(value => typeof value === 'string' && /\bTDR\b/i.test(value));
  const failed = run.passed === false && !run.active;
  return { startedAt, startTimeSource, endedAt, wallSeconds: seconds(startedAt, endedAt), firstFailureAt: firstError?.at || (failed ? endedAt : null),
    wallToFirstFailureSeconds: seconds(startedAt, firstError?.at || (failed ? endedAt : null)),
    completedAudioSeconds: Math.max(0, ...parts.map(part => ((part.startSample || 0) + (part.samples || 0)) / 16000)),
    failingAudioSeconds: Number.isFinite(firstError?.startSample) ? firstError.startSample / 16000 : null,
    maxChunkElapsedMs: elapsed.length ? Math.max(...elapsed) : null, maxRawEventGapSeconds: gaps.length ? Math.max(...gaps) : null,
    errorCount: errors.length, nativeExitCount: errors.filter(event => event.workerExit?.hexCode).length,
    tdr: explicitTdr.length ? 'explicit-recorded-evidence' : 'not-checked-in-windows-log', tdrEvidence: explicitTdr };
}

export function writeTimeline(directory, runs) {
  const rows = ['# 同一黄仁勋视频的 GPU 方案时间线', '', '音频位置来自检查点/原始返回；墙钟来自实际时间戳。未读取 Windows 事件的轮次不会推断 TDR。', '',
    '| 方案 | 结果 | 已接受音频秒 | 出错音频秒 | 首错前墙钟秒 | 最长识别毫秒 | 原始事件最大间隔秒 |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const run of runs) {
    const metrics = run.metrics || runMetrics(run, { directory }), value = number => number == null ? '未记录' : Number(number.toFixed(3));
    rows.push(`| ${run.plan.id} | ${run.active ? '运行中' : run.deferred || run.testStatus === 'not-tested' ? '未测试（依赖未就绪）' : run.passed ? '单轮完整通过' : run.interrupted ? '已停止' : '失败'} | ${value(metrics.completedAudioSeconds)} | ${value(metrics.failingAudioSeconds)} | ${value(metrics.wallToFirstFailureSeconds)} | ${value(metrics.maxChunkElapsedMs)} | ${value(metrics.maxRawEventGapSeconds)} |`);
  }
  rows.push('', '详细记录、退出码和原始错误保留在 queue-state.json 每轮 metrics / failureDetails，以及各运行目录 raw-results.jsonl。', '');
  const file = path.join(directory, 'TIMELINE.md'), temporary = file + '.' + randomUUID() + '.tmp'; fs.writeFileSync(temporary, rows.join('\n'), { flush: true }); fs.renameSync(temporary, file);
}

export function assessFullResult(result, outputDirectory, { source, expectedDuration } = {}) {
  const issues = []; let parts = [], events = [];
  if (!result?.complete || result.device !== 'cuda') issues.push('不是完整 CUDA 结果');
  if (result?.recoveries !== 0 || result?.nativeExits !== 0) issues.push('存在恢复或原生退出');
  if (!Number.isInteger(result?.totalSamples) || result.totalSamples <= 0 || !Number.isInteger(result.chunks) || result.chunks <= 0) issues.push('样本或段数无效');
  if (!/^[a-f0-9]{64}$/i.test(result?.sourceIdentity || '')) issues.push('来源标识无效');
  try {
    const audioIdentity = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'audio-source.json'))).sourceIdentity;
    if (audioIdentity !== result.sourceIdentity || fs.statSync(path.join(outputDirectory, 'audio.s16le')).size !== result.totalSamples * 2) issues.push('完整预解码音轨与结果不一致');
    if (source) { const stat = fs.statSync(source); if (result.sourceIdentity !== hash(JSON.stringify([fs.realpathSync(source), stat.size, stat.mtimeMs]))) issues.push('结果并非本次输入来源'); }
  } catch (error) { issues.push('完整音轨或来源记录缺失：' + error.message); }
  if (Math.abs(result?.duration - result?.totalSamples / 16000) > 0.001) issues.push('报告时长与样本不一致');
  if (Number.isFinite(expectedDuration) && Math.abs(result?.duration - expectedDuration) > 1) issues.push('并非预期的整段视频时长');
  try { parts = JSON.parse(fs.readFileSync(result.checkpointFile)).parts; events = readLines(result.eventsFile); } catch (error) { issues.push('原始记录或检查点缺失：' + error.message); }
  let sample = 0;
  if (!Array.isArray(parts) || parts.length !== result?.chunks) issues.push('检查点段数不一致');
  else for (const [index, part] of parts.entries()) {
    if (part.index !== index || part.startSample !== sample || !Number.isInteger(part.samples) || part.samples <= 0 || part.device !== 'cuda' || typeof part.text !== 'string') issues.push('分段连续性或设备不一致：' + index);
    sample += part.samples || 0;
  }
  if (sample !== result?.totalSamples) issues.push('未覆盖全部音频样本');
  const text = parts.map(part => part.text?.trim()).filter(Boolean).join('\n');
  if (!text || transcriptQualityIssue(text)) issues.push('文本为空或包含异常重复标点');
  if (result?.text !== text || result?.transcriptSha256 !== hash(text)) issues.push('最终文字与检查点校验不一致');
  try { if (fs.readFileSync(result.transcriptFile, 'utf8').trimEnd() !== text) issues.push('最终文件内容不一致'); } catch { issues.push('最终文件缺失'); }
  if (events.some(event => ['error', 'failed'].includes(event.event) || event.device && event.device !== 'cuda')) issues.push('原始记录含错误或非 CUDA 设备');
  const accepted = events.filter(event => event.event === 'result');
  for (const part of parts) if (!accepted.some(event => event.index === part.index && event.device === 'cuda' && event.result?.text === part.text)) issues.push('分段原始返回值缺失：' + part.index);
  const resumed = events.some(event => event.event === 'start' && event.resumedChunks > 0);
  if (resumed) issues.push('此轮复用旧转写进度，不算独立完整重跑');
  return { passed: !issues.length, issues: [...new Set(issues)], checkedAt: now(), outputDirectory, independent: !resumed, samples: { expected: result?.totalSamples, actual: sample } };
}

export function revisedPlan(plan) {
  if (plan.beamSize !== 1) return { ...plan, id: (plan.id.slice(0, 60) + '-greedy-sync'), computeType: 'float32', allocator: 'cub_caching', fp16Gemm: false, beamSize: 1, launchBlocking: true };
  if (!plan.launchBlocking) return { ...plan, id: plan.id.slice(0, 70) + '-sync', launchBlocking: true };
  if ((plan.runtimeVariant || 'bundled') === 'bundled') return { ...plan, id: plan.id.slice(0, 70) + '-pinned', runtimeVariant: 'pinned-cudnn' };
  if (plan.runtimeVariant === 'pinned-cudnn') return { ...plan, id: plan.id.slice(0, 70) + '-sm75', runtimeVariant: 'sm75-native' };
  return null;
}

export async function runGpuQueue({ inputFile, root = path.resolve(import.meta.dirname, '../.notion-switch'), transcribe,
  ffmpeg, log = event => console.log(JSON.stringify({ at: now(), ...event })), waitMs = 250, signal, stopWhenVerified = false } = {}) {
  const input = JSON.parse(fs.readFileSync(inputFile)), directory = path.dirname(inputFile), inbox = path.join(directory, 'inbox');
  const stateFile = path.join(directory, 'queue-state.json'), registryFile = path.join(directory, 'verified-methods.json'), mistakes = path.join(directory, 'FAILURES.md');
  const lockFile = path.join(directory, '.queue.lock'); fs.mkdirSync(inbox, { recursive: true });
  const migrationLock = path.join(directory, '.queue-migration.lock');
  if (fs.existsSync(migrationLock) && alive(JSON.parse(fs.readFileSync(migrationLock)).pid)) throw Error('队列记录正在安全迁移，请等待迁移完成再启动。');
  let handle;
  try { handle = fs.openSync(lockFile, 'wx'); } catch (error) { if (error.code !== 'EEXIST') throw error; const owner = JSON.parse(fs.readFileSync(lockFile)); if (alive(owner.pid)) throw Error('GPU 队列已经在运行。'); fs.unlinkSync(lockFile); handle = fs.openSync(lockFile, 'wx'); }
  fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: now() })); fs.closeSync(handle);
  const controller = new AbortController(), abort = () => controller.abort(signal?.reason || Error('队列已停止，进度已保留。'));
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : { version: 2, queue: (input.plans || []).map(normalizePlan), runs: [], current: null };
  state.version = 2; state.commands ||= []; state.pendingRevisions ||= [];
  for (const run of state.runs) run.metrics ||= runMetrics(run, { directory });
  writeTimeline(directory, state.runs);
  const unfinishedAtStartup = state.current;
  state.current = null;
  const registry = fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile)) : { version: 2, methods: [] };
  for (const method of registry.methods) updateMethodVerification(method);
  registry.version = 3; registry.performanceReference ||= { status: 'not-measured' };
  atomicJson(registryFile, registry);
  const save = () => { state.updatedAt = now(); atomicJson(stateFile, state); };
  const note = text => fs.appendFileSync(mistakes, text + '\n', { flush: true });
  const latestImplementation = () => { const runtime = loadGpuImplementation({ root }); normalizePlan = runtime.normalizePlan; return runtime; };
  if (!fs.existsSync(mistakes)) note('# GPU 转写错题与调整记录\n\n短测、单轮完整和双轮独立验收分别记录。');
  const failed = plan => state.runs.some(run => !run.passed && !run.interrupted && !run.deferred && run.testStatus !== 'not-tested' && planFingerprint(run.plan) === planFingerprint(plan));
  const occupied = plan => state.queue.some(item => planFingerprint(item) === planFingerprint(plan)) || state.current && planFingerprint(state.current.plan) === planFingerprint(plan);
  function enqueue(plan, reason, repeat = false) {
    if (!transcribe) latestImplementation();
    plan = normalizePlan(plan);
    if (failed(plan)) return { accepted: false, reason: '完全相同的执行配置已经失败，不原样重排。' };
    if (occupied(plan)) return { accepted: false, reason: '相同执行配置已在运行或排队。' };
    if (!repeat && registry.methods.some(method => method.repeatVerified && planFingerprint(method.plan) === planFingerprint(plan))) return { accepted: false, reason: '相同方案已独立重跑通过。' };
    state.queue.push(plan); note(`\n${now()} 入队 ${plan.id}\n\n依据：${reason || '提交新的执行路径'}\n\n配置：${JSON.stringify(plan)}\n`); return { accepted: true };
  }
  function ingest() {
    for (const name of fs.readdirSync(inbox).filter(name => /^[a-f0-9-]+\.json$/i.test(name)).sort()) {
      const file = path.join(inbox, name), id = path.basename(name, '.json'); let receipt = state.commands.find(item => item.id === id);
      if (!receipt) {
        try {
          const command = JSON.parse(fs.readFileSync(file));
          if (command.version !== 1 || command.id && command.id !== id || !['submit', 'revise', 'prioritize', 'stop'].includes(command.action)) throw Error('命令格式无效。');
          if (command.action === 'stop') { controller.abort(Error('用户已停止 GPU 队列，记录与检查点已保留。')); receipt = { accepted: true }; }
          else if (command.action === 'prioritize') {
            const index = state.queue.findIndex(plan => plan.id === command.planId);
            if (index < 0) receipt = { accepted: false, reason: state.current?.plan.id === command.planId ? '方案正在运行，保持当前任务不动。' : '方案不在待运行队列中。' };
            else { const [prioritized] = state.queue.splice(index, 1); state.queue.unshift(prioritized); note(`\n${now()} 优先 ${command.planId}：${command.reason || '优先复验'}；仅调整待运行队列，当前任务不动。\n`); receipt = { accepted: true, prioritized: command.planId }; }
          }
          else {
            if (!transcribe) latestImplementation();
            const plan = normalizePlan(command.plan); // Validate before replacing the queued draft.
            const previous = state.queue;
            if (command.action === 'revise') state.queue = state.queue.filter(item => item.id !== command.replaces);
            receipt = enqueue(plan, command.reason);
            if (!receipt.accepted) state.queue = previous;
          }
        } catch (error) { receipt = { accepted: false, reason: error.message }; }
        receipt = { ...receipt, id, processedAt: now() }; state.commands.push(receipt); save(); log({ stage: 'command-processed', receipt });
      }
      const archive = path.join(inbox, receipt.accepted ? 'processed' : 'rejected'); fs.mkdirSync(archive, { recursive: true }); fs.renameSync(file, path.join(archive, name));
    }
    // Prepared revisions become executable as soon as their Agent publishes the module.
    state.pendingRevisions = state.pendingRevisions.filter(item => {
      if (!runtimeReady(root, item.plan)) return true;
      enqueue(item.plan, item.reason); return false;
    });
  }
  async function account(run) {
    run.metrics = runMetrics(run, { directory });
    state.runs.push(run); state.current = null;
    note(`\n## ${run.at} · ${run.plan.id}\n\n配置：${JSON.stringify(run.plan)}\n\n结果：${run.passed ? '单轮完整 CUDA 通过，等待独立重跑。' : run.error || run.assessment?.issues.join('；')}\n\n底层错误：${JSON.stringify(run.failureDetails || [])}\n\n原始记录目录：${run.outputDirectory}\n`);
    if (run.passed) {
      let method = registry.methods.find(method => planFingerprint(method.plan) === planFingerprint(run.plan) && method.sourceIdentity === run.sourceIdentity);
      if (!method) { method = { plan: run.plan, sourceIdentity: run.sourceIdentity, verifiedRuns: [] }; registry.methods.push(method); }
      if (!method.verifiedRuns.some(item => item.outputDirectory === run.outputDirectory)) method.verifiedRuns.push(run);
      updateMethodVerification(method);
      atomicJson(registryFile, registry); atomicJson(path.join(directory, run.plan.id + '.json'), run.plan);
      if (!method.repeatVerified) enqueue(run.plan, '单轮整段通过，使用新目录进行独立完整重跑。', true);
    } else if (!run.interrupted) {
      const revised = revisedPlan(run.plan);
      if (revised) { const receipt = enqueue(revised, '根据本轮非法地址/原生退出等证据，改变 greedy/sync 或独立运行库路径；不原样重复仅改精度或重启的已失败方向。'); if (!receipt.accepted) note(`\n修订未入队：${receipt.reason}\n`); }
    }
    writeTimeline(directory, state.runs); save(); log({ stage: 'plan-finished', run, queued: state.queue.map(plan => plan.id) });
    try { const { updateGpuLeaderboard } = await import('./gpu-leaderboard.mjs'); await updateGpuLeaderboard({ inputFile }); }
    catch (error) { log({ stage: 'leaderboard-update-failed', error: error.message }); }
  }
  function successfulRun(plan, outputDirectory, result) {
    const assessment = assessFullResult(result, outputDirectory, { source: input.source, expectedDuration: input.expectedDuration }); atomicJson(path.join(outputDirectory, 'queue-audit.json'), assessment);
    return { plan, fingerprint: planFingerprint(plan), outputDirectory, complete: result.complete, passed: assessment.passed, assessment,
      validation: assessment.passed ? 'full-video-once' : 'rejected', sourceIdentity: result.sourceIdentity, policy: result.policy,
      duration: result.duration, chunks: result.chunks, recoveries: result.recoveries, nativeExits: result.nativeExits,
      transcriptFile: result.transcriptFile, transcriptSha256: result.transcriptSha256, at: now() };
  }
  const tick = setInterval(() => { if (fs.existsSync(path.join(directory, 'STOP'))) abort(); try { ingest(); } catch (error) { log({ stage: 'inbox-error', error: error.message }); } }, waitMs);
  const pause = () => new Promise(resolve => setTimeout(resolve, waitMs));
  try {
    if (unfinishedAtStartup) {
      const completedFile = path.join(unfinishedAtStartup.outputDirectory, 'result.json');
      const completed = fs.existsSync(completedFile) && readLines(path.join(unfinishedAtStartup.outputDirectory, 'raw-results.jsonl')).some(event => event.event === 'complete');
      if (completed && !state.runs.some(run => run.outputDirectory === unfinishedAtStartup.outputDirectory)) {
        // A boundary stop can land after raw complete but before account().
        // Adopt its evidence without re-opening or appending to the finished run.
        await account({ ...successfulRun(unfinishedAtStartup.plan, unfinishedAtStartup.outputDirectory, JSON.parse(fs.readFileSync(completedFile))),
          startedAt: unfinishedAtStartup.startedAt, ...(unfinishedAtStartup.implementation ? { implementation: unfinishedAtStartup.implementation } : {}) });
      } else if (!completed) state.queue.unshift(unfinishedAtStartup.plan);
      save();
    }
    while (!controller.signal.aborted) {
      ingest();
      const externalFile = path.join(directory, 'active-external-job.json');
      if (fs.existsSync(externalFile)) {
        const external = JSON.parse(fs.readFileSync(externalFile));
        const activity = externalJobActivity(external);
        if (activity.active) { state.stage = 'waiting-for-external-gpu-job'; state.external = { ...external, activity }; save(); await pause(); continue; }
        const externalPlan = normalizePlan(typeof external.plan === 'object' ? external.plan : JSON.parse(fs.readFileSync(path.join(directory, external.plan + '.json'))));
        if (!state.runs.some(run => run.outputDirectory === external.outputDirectory)) {
          const resultFile = path.join(external.outputDirectory, 'result.json');
          if (fs.existsSync(resultFile)) await account({ ...successfulRun(externalPlan, external.outputDirectory, JSON.parse(fs.readFileSync(resultFile))), startedAt: external.startedAt });
          else {
            const failureDetails = readLines(path.join(root, 'speech/worker-failures.jsonl')).filter(item => item.at >= external.startedAt).slice(-3);
            await account({ plan: externalPlan, fingerprint: planFingerprint(externalPlan), outputDirectory: external.outputDirectory, startedAt: external.startedAt, complete: false, passed: false, error: '外部 GPU 任务退出且未生成完整结果。', failureDetails, at: now() });
          }
        }
        delete state.external; fs.renameSync(externalFile, path.join(directory, 'external-accounted-' + randomUUID() + '.json')); save();
      }
      if (!state.queue.length) {
        const stage = registry.methods.some(method => method.repeatVerified) ? 'verified-waiting-for-plan' : state.pendingRevisions.length ? 'waiting-for-runtime' : 'waiting-for-plan';
        if (state.stage !== stage) { state.stage = stage; save(); log({ stage }); }
        if (stopWhenVerified && registry.methods.some(method => method.repeatVerified)) break;
        await pause(); continue;
      }
      const runtime = !transcribe ? latestImplementation() : null;
      const plan = normalizePlan(state.queue.shift());
      if (failed(plan)) { note(`\n${now()} 跳过已经失败的相同配置 ${plan.id}。\n`); save(); continue; }
      if (!runtimeReady(root, plan)) {
        if (!state.pendingRevisions.some(item => planFingerprint(item.plan) === planFingerprint(plan))) state.pendingRevisions.push({ plan, reason: '等待 Agent 发布新的独立运行库', createdAt: now() });
        save(); continue;
      }
      const prior = state.runs.filter(run => run.plan.id === plan.id), outputDirectory = path.join(directory, 'runs', plan.id + '-' + (prior.length + 1));
      const implementation = runtime ? { revision: runtime.revision, snapshotDirectory: runtime.snapshotDirectory, manifestFile: runtime.manifestFile } : null;
      state.current = { plan, outputDirectory, startedAt: now(), ...(implementation ? { implementation } : {}) }; state.stage = 'running'; save(); log({ stage: 'plan-start', ...state.current });
      if (runtime) { fs.mkdirSync(outputDirectory, { recursive: true }); atomicJson(path.join(outputDirectory, 'implementation.json'), runtime.manifest); }
      let run;
      try {
        const result = await (transcribe || runtime.transcribeGpuFile)({ root, source: input.source, outputDirectory, ffmpeg: ffmpeg || new CollectionBinaries({ root }).find('ffmpeg'), plan, language: input.language || 'auto', signal: controller.signal,
          onProgress: progress => { state.current.progress = progress; ingest(); save(); if (progress.index === undefined || progress.index % 6 === 0) log(progress); } });
        run = { ...successfulRun(plan, outputDirectory, result), startedAt: state.current.startedAt };
      } catch (error) {
        const failureDetails = readLines(path.join(root, 'speech/worker-failures.jsonl')).filter(item => item.at >= state.current.startedAt).slice(-3);
        run = { plan, fingerprint: planFingerprint(plan), outputDirectory, startedAt: state.current.startedAt, complete: false, passed: false, error: error.message, failureDetails, interrupted: controller.signal.aborted, at: now() };
      }
      if (implementation) run.implementation = implementation;
      await account(run); ingest(); save();
    }
  } finally { clearInterval(tick); signal?.removeEventListener('abort', abort); state.stage = controller.signal.aborted ? 'stopped' : 'verified'; save(); try { fs.unlinkSync(lockFile); } catch {} }
  return { state, registry };
}
