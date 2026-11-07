import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicJson, externalJobActivity, planFingerprint } from './gpu-queue-core.mjs';

export const bootstrapRunIds = Object.freeze(['gpu-native-sm75-fp32-v1', 'gpu-greedy-sync-v1-pinned-sm75']);
export const historicalDefaults = Object.freeze({ runtimeVariant: 'bundled', beamSize: 5, launchBlocking: false, runtimeRevision: '', languageOverride: null });
export function enrichHistoricalPlans(state) {
  const enrichments = [];
  const enrich = (owner, location, observed = {}) => {
    if (!owner.plan || typeof owner.plan !== 'object') return;
    const added = Object.fromEntries(Object.entries(historicalDefaults).filter(([key]) => !Object.hasOwn(owner.plan, key)).map(([key, value]) => [key, Object.hasOwn(observed, key) ? observed[key] : value]));
    if (!Object.keys(added).length) return;
    owner.originalPlan ||= structuredClone(owner.plan); owner.plan = { ...owner.plan, ...added };
    enrichments.push({ location, id: owner.plan.id, added });
  };
  for (const [index, run] of state.runs.entries()) enrich(run, 'runs[' + index + '].plan');
  // Drafts which refer to an already observed run inherit that run's recorded
  // choices, never the public API default which may now be a winning profile.
  for (const [index, item] of (state.pendingRevisions || []).entries()) {
    const observed = state.runs.findLast(run => run.plan?.id === item.plan?.id);
    if (observed) enrich(item, 'pendingRevisions[' + index + '].plan', observed.plan);
  }
  for (const [index, queued] of state.queue.entries()) {
    const observed = state.runs.findLast(run => run.plan?.id === queued.id);
    if (!observed) continue;
    const owner = { plan: queued }; enrich(owner, 'queue[' + index + ']', observed.plan);
    if (owner.originalPlan) {
      state.originalQueuedPlans ||= []; state.originalQueuedPlans.push({ index, originalPlan: owner.originalPlan }); state.queue[index] = owner.plan;
    }
  }
  return enrichments;
}
function alive(pid) { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
function jsonLines(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
function contained(directory, candidate) { const relative = path.relative(path.resolve(directory), path.resolve(candidate)); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); }

export function bootstrapEvidence(run, directory) {
  if (!bootstrapRunIds.includes(run.plan?.id) || run.plan.runtimeVariant !== 'sm75-native') return { eligible: false, reason: '不属于指定的两条半成品记录。' };
  if (run.deferred && run.testStatus === 'not-tested') return { eligible: false, alreadyDeferred: true, reason: '已经校正为未测试。' };
  if (!run.outputDirectory || !contained(path.join(directory, 'runs'), run.outputDirectory)) return { eligible: false, reason: '记录目录不在本队列 runs 内。' };
  let events, parts = [];
  try {
    const raw = path.join(run.outputDirectory, 'raw-results.jsonl');
    if (!fs.existsSync(raw)) return { eligible: false, reason: '缺少原始返回记录，不能证明未运行。' };
    events = jsonLines(raw);
    if (fs.existsSync(path.join(run.outputDirectory, 'checkpoint.json'))) parts = JSON.parse(fs.readFileSync(path.join(run.outputDirectory, 'checkpoint.json'))).parts;
  } catch (error) { return { eligible: false, reason: '证据不可读：' + error.message }; }
  if (!Array.isArray(parts) || parts.length || events.some(event => event.event === 'result') || fs.existsSync(path.join(run.outputDirectory, 'result.json'))) return { eligible: false, reason: '存在识别结果、检查点或完成产物，禁止归为未测试。' };
  const failures = run.failureDetails || [];
  const dependencyPattern = /get_supported_compute_types|Invalid private CTranslate2 module directory|No module named ['"]ctranslate2|(?:runtime|variant|dependency).*(?:not ready|incomplete)/i;
  if (!failures.length || failures.some(item => item.kind !== 'configure') || !failures.some(item => dependencyPattern.test(item.detail || ''))) return { eligible: false, reason: '没有明确的 configure 阶段依赖未就绪证据。' };
  if (failures.some(item => /cudaError|illegal.{0,20}address|\bTDR\b|0xc0000409/i.test(item.detail || ''))) return { eligible: false, reason: '存在真正的 CUDA/驱动错误，不能重分类。' };
  return { eligible: true, gpuResultCount: 0, checkpointParts: 0, failureStage: 'configure', details: failures.map(item => ({ at: item.at, kind: item.kind, errorType: item.errorType, detail: item.detail })) };
}

export function migrateGpuQueue({ inputFile, apply = false, isProcessAlive = alive } = {}) {
  const directory = path.dirname(path.resolve(inputFile)), stateFile = path.join(directory, 'queue-state.json');
  const original = fs.readFileSync(stateFile, 'utf8'), state = JSON.parse(original);
  const blocks = [];
  const queueLock = path.join(directory, '.queue.lock');
  if (fs.existsSync(queueLock)) {
    try { const owner = JSON.parse(fs.readFileSync(queueLock)); if (isProcessAlive(owner.pid)) blocks.push('队列进程仍在运行：' + owner.pid); }
    catch (error) { blocks.push('队列锁无法验证：' + error.message); }
  }
  if (state.current) blocks.push('state.current 仍有任务，禁止修改当前任务。');
  const externalFile = path.join(directory, 'active-external-job.json');
  if (fs.existsSync(externalFile)) {
    try { if (externalJobActivity(JSON.parse(fs.readFileSync(externalFile))).active) blocks.push('外部 GPU 作业仍有活动证据。'); }
    catch (error) { blocks.push('外部作业状态无法验证：' + error.message); }
  }
  const enrichments = enrichHistoricalPlans(state);
  const targets = state.runs.map((run, index) => ({ index, id: run.plan?.id, outputDirectory: run.outputDirectory, evidence: bootstrapEvidence(run, directory) })).filter(item => bootstrapRunIds.includes(item.id));
  const changes = targets.filter(item => item.evidence.eligible);
  const report = { version: 1, dryRun: !apply, canApply: blocks.length === 0, blocks, targets, changed: changes.length, enrichedPlans: enrichments.length, enrichments,
    note: '仅补历史缺失字段并保留 originalPlan；另校正依赖未就绪且零识别结果的两条记录。不删除原始文件，不改真正 GPU 失败的结论或当前任务。' };
  if (!apply) return report;
  if (blocks.length) throw Error('迁移已拒绝：' + blocks.join('；'));
  if (!changes.length && !enrichments.length) return { ...report, applied: false, reason: '没有可校正的新记录。' };
  const migrationLock = path.join(directory, '.queue-migration.lock'), handle = fs.openSync(migrationLock, 'wx');
  fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fs.closeSync(handle);
  try {
    // A new coordinator must refuse the migration lock; recheck the original
    // snapshot to catch a coordinator which was started before that guard.
    if (fs.readFileSync(stateFile, 'utf8') !== original) throw Error('迁移期间队列记录发生变化，已停止，未覆盖。');
    if (fs.existsSync(queueLock) && isProcessAlive(JSON.parse(fs.readFileSync(queueLock)).pid)) throw Error('队列已重新启动，迁移停止。');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(directory, 'migrations', stamp + '-bootstrap-deferred-' + randomUUID()); fs.mkdirSync(backup, { recursive: true });
    fs.copyFileSync(stateFile, path.join(backup, 'queue-state.before.json'), fs.constants.COPYFILE_EXCL);
    atomicJson(path.join(backup, 'migration-evidence.json'), report);
    state.pendingRevisions ||= [];
    const reclassifiedAt = new Date().toISOString();
    for (const target of changes) {
      const run = state.runs[target.index];
      run.deferred = true; run.testStatus = 'not-tested'; run.validation = 'deferred-dependency';
      run.failureStage = 'runtime-setup'; run.gpuTested = false; run.operatorFailure = false;
      run.reclassifiedAt = reclassifiedAt; run.reclassificationBackup = path.join(backup, 'queue-state.before.json');
      run.reclassificationEvidence = target.evidence;
      const fingerprint = planFingerprint(run.plan);
      state.queue = state.queue.filter(plan => planFingerprint(plan) !== fingerprint);
      if (!state.pendingRevisions.some(item => planFingerprint(item.plan) === fingerprint)) state.pendingRevisions.push({ plan: run.plan,
        reason: '依赖/绑定未就绪，原先未执行 GPU 转写；等待完整 READY 发布后测试。', blockedBy: 'runtime-not-ready', testStatus: 'not-tested', originRun: run.outputDirectory, createdAt: reclassifiedAt });
    }
    state.migrations ||= []; state.migrations.push({ kind: 'bootstrap-deferred-v1', at: reclassifiedAt, runIds: changes.map(item => item.id), enrichedPlans: enrichments.length, backup });
    state.updatedAt = reclassifiedAt; atomicJson(stateFile, state);
    fs.appendFileSync(path.join(directory, 'FAILURES.md'), `\n## ${reclassifiedAt} · 历史配置与依赖记录校正\n\n补齐 ${enrichments.length} 条历史计划缺失字段，使用当时的 bundled/beam5、未启用同步、空运行库修订与自动语言默认元数据，不覆盖已有字段，保留 originalPlan；不根据新的公开默认值改写执行史。\n\n${changes.length ? changes.map(item => item.id).join('、') + '：configure 阶段半成品依赖错误，零 GPU 识别段，现记为 deferred / not-tested，移入 pendingRevisions。' : ''}原始错误和产物均保留，不计为 GPU 算子失败。完整原始记录备份：${backup}\n`, { flush: true });
    atomicJson(path.join(backup, 'migration-result.json'), { ...report, applied: true, backup });
    return { ...report, applied: true, backup };
  } finally { fs.unlinkSync(migrationLock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inputFile, ...flags] = process.argv.slice(2);
  if (!inputFile || flags.some(flag => flag !== '--apply')) throw Error('用法：node scripts/migrate-gpu-queue.mjs <queue-input.json> [--apply]；默认只读预览。--apply 仅在队列进程停止且无当前任务时执行。');
  console.log(JSON.stringify(migrateGpuQueue({ inputFile, apply: flags.includes('--apply') }), null, 2));
}
