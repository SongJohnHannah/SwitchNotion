import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const now = () => new Date().toISOString();
export const baselinePlanId = 'gpu-pinned-fp16-greedy-v1-sync';
// These are recorded historical choices, not the current public API defaults.
const legacy = { runtimeVariant: 'bundled', beamSize: 5, launchBlocking: false, runtimeRevision: '', languageOverride: null, batchSize: 1 };
function normalizedRecordedPlan(plan) { return { ...legacy, ...plan }; }
function execution(plan) { const { id, ...parameters } = normalizedRecordedPlan(plan); return parameters; }
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8'), rows = text.split('\n'), events = [];
  for (const [index, row] of rows.entries()) { if (!row.trim()) continue; try { events.push(JSON.parse(row)); } catch (error) { if (index === rows.length - 1 && !text.endsWith('\n')) break; throw error; } }
  return events;
}
function atomic(file, value) { const temp = file + '.' + randomUUID() + '.tmp'; fs.writeFileSync(temp, value, { flush: true }); fs.renameSync(temp, file); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
function ownedArtifact(directory, file) { try { return path.dirname(fs.realpathSync(file)) === fs.realpathSync(directory); } catch { return false; } }
const medianTwo = runs => (runs[0].seconds + runs[1].seconds) / 2;
const failureAt = run => run.errorEvents?.[0]?.at || run.rawFailedAt || run.recordedAt || run.lastEventAt || now();

export async function auditLeaderboardRun({ outputDirectory, recorded = {}, input, machine = {}, assess }) {
  const result = readJson(path.join(outputDirectory, 'result.json')), checkpoint = readJson(path.join(outputDirectory, 'checkpoint.json'));
  let events = [], rawParseError;
  try { events = readEvents(path.join(outputDirectory, 'raw-results.jsonl')); } catch (error) { rawParseError = error; }
  const starts = events.filter(event => event.event === 'start'), completes = events.filter(event => event.event === 'complete');
  const start = starts[0], complete = completes[0], rawResults = events.filter(event => event.event === 'result');
  const errorEvents = events.filter(event => event.event === 'error'), rawFailed = events.filter(event => event.event === 'failed');
  const plan = normalizedRecordedPlan(result?.plan || checkpoint?.plan || recorded.plan || {});
  const sourceIdentity = result?.sourceIdentity || checkpoint?.sourceIdentity || start?.sourceIdentity || readJson(path.join(outputDirectory, 'audio-source.json'))?.sourceIdentity || null;
  const modelDirectory = start?.runtime?.modelDirectory || machine.runtime?.modelDirectory || null;
  const policy = result?.policy || checkpoint?.policy || (plan.beamSize === 1 ? 'stable-gpu-v1-greedy' : 'stable-gpu-v1');
  const groupKey = hash(JSON.stringify(canonical({ sourceIdentity, modelDirectory: process.platform === 'win32' ? modelDirectory?.toLowerCase() : modelDirectory, policy, language: checkpoint?.language || input.language || 'auto', parameters: execution(plan) })));
  const setupFailure = recorded.deferred || recorded.testStatus === 'not-tested' || !rawResults.length && recorded.failureDetails?.length && recorded.failureDetails.every(item => item.kind === 'configure') && recorded.failureDetails.some(item => /get_supported_compute_types|Invalid private CTranslate2 module directory|No module named ['"]ctranslate2/i.test(item.detail || ''));
  const base = { outputDirectory, groupKey, plan, sourceIdentity, model: { id: modelDirectory ? path.basename(modelDirectory) : null, directory: modelDirectory }, policy,
    implementation: readJson(path.join(outputDirectory, 'implementation.json'))?.revision ? { revision: readJson(path.join(outputDirectory, 'implementation.json')).revision, file: path.join(outputDirectory, 'implementation.json') } : null,
    runtimePaths: start?.runtime || null, errorEvents, recordedAt: recorded.at, lastEventAt: events.at(-1)?.at,
    rawFailedAt: rawFailed[0]?.at, failureDetails: recorded.failureDetails || [], recordedError: recorded.error,
    acceptedAudioSeconds: checkpoint?.parts?.length ? Math.max(...checkpoint.parts.map(part => (part.startSample + part.samples) / 16000)) : 0,
    failingAudioSeconds: Number.isFinite(errorEvents[0]?.startSample) ? errorEvents[0].startSample / 16000 : null };
  if (setupFailure) return { ...base, status: 'not-tested', issues: ['依赖未就绪，未执行 GPU 转写。'] };
  if (recorded.interrupted) return { ...base, status: 'interrupted', issues: [recorded.error || '任务被主动停止。'] };
  if (rawParseError) return { ...base, status: 'invalid', issues: ['原始记录 JSON 无效：' + rawParseError.message] };
  if (complete && !result) return { ...base, status: 'invalid', issues: ['完成事件存在，但最终结果文件缺失或无效。'] };
  if (!result || !complete) {
    const failed = errorEvents.length > 0 || recorded.passed === false && !recorded.interrupted;
    return { ...base, status: failed ? 'failed' : rawResults.length || start ? 'running' : 'prepared', issues: failed ? [recorded.error || errorEvents[0]?.error || '未生成完整结果。'] : [] };
  }
  const audit = assess(result, outputDirectory, { source: input.source, expectedDuration: input.expectedDuration });
  const issues = [...audit.issues];
  if (starts.length !== 1 || completes.length !== 1 || start.resumedChunks !== 0) issues.push('不是新目录中的单次独立完整执行。');
  if (errorEvents.length || rawFailed.length) issues.push('原始记录存在错误或失败。');
  if (complete.totalSamples !== result.totalSamples || complete.totalChunks !== result.chunks || complete.transcriptSha256 !== result.transcriptSha256) issues.push('完成事件与最终产物不一致。');
  if (![result.transcriptFile, result.eventsFile, result.checkpointFile].every(file => ownedArtifact(outputDirectory, file))) issues.push('产物指向其他运行目录，不能作为独立轮次。');
  const invalidRaw = rawResults.some(event => /[!！?？。.…]{16,}/u.test(event.result?.text || '') || event.result?.quality?.valid === false);
  if (invalidRaw) issues.push('原始返回存在重复标点等异常。');
  const seconds = (Date.parse(complete.at) - Date.parse(start.at)) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) issues.push('引擎就绪至完成的计时无效。');
  if (recorded.assessment?.passed === false) issues.push(...(recorded.assessment.issues || ['队列质量验收未通过。']));
  const qualityReview = readJson(path.join(outputDirectory, 'quality-review.json'));
  const contentReviewNeeded = qualityReview?.status === 'content-review-needed';
  if (contentReviewNeeded) issues.push(...(qualityReview.issues || ['局部内容需要复核，不能仅凭音频样本覆盖登记为完整逐字稿。']));
  return { ...base, status: contentReviewNeeded ? 'content-review-needed' : issues.length ? 'invalid' : 'valid', qualityReview, issues: [...new Set(issues)], seconds, startAt: start.at, completeAt: complete.at,
    characters: result.text?.length || 0, wordCount: (result.text?.match(/[\p{L}\p{N}]+/gu) || []).length,
    totalSamples: result.totalSamples, audioSeconds: result.duration, chunks: result.chunks, transcriptSha256: result.transcriptSha256,
    evidenceId: hash(JSON.stringify([sourceIdentity, start.at, complete.at, result.transcriptSha256])),
    artifacts: { transcriptFile: result.transcriptFile, eventsFile: result.eventsFile, checkpointFile: result.checkpointFile } };
}

export function buildSpeedLeaderboard(runs, { baselineId = baselinePlanId, minimumReduction = 0.07, previousHistory = [] } = {}) {
  const baselineRun = runs.filter(run => run.status === 'valid' && run.plan.id === baselineId).sort((a, b) => a.completeAt.localeCompare(b.completeAt))[0];
  if (!baselineRun) return { version: 1, updatedAt: now(), minimumReduction, status: 'waiting-for-valid-baseline', baseline: null, champion: null, championHistory: previousHistory, methods: [], runs };
  const relevant = runs.filter(run => run.sourceIdentity === baselineRun.sourceIdentity).map(run => {
    if (run.status !== 'valid') return run;
    if (run.totalSamples !== baselineRun.totalSamples || Math.abs(run.audioSeconds - baselineRun.audioSeconds) > 0.001) return { ...run, status: 'invalid', issues: [...(run.issues || []), '音轨样本/时长与基准不一致。'] };
    const characterRatio = baselineRun.characters > 0 ? run.characters / baselineRun.characters : null;
    const wordRatio = baselineRun.wordCount > 0 ? run.wordCount / baselineRun.wordCount : null;
    return characterRatio !== null && characterRatio < 0.85 || wordRatio !== null && wordRatio < 0.85
      ? { ...run, artifactStatus: 'valid', status: 'content-review-needed', contentCompleteness: { characterRatio, wordRatio }, issues: [...(run.issues || []), '文字量显著低于基准 85%，需核对有无漏段；不把细微 ASR 差异判为错误。'] } : run;
  }), groups = new Map();
  for (const run of relevant) {
    let method = groups.get(run.groupKey);
    if (!method) { method = { key: run.groupKey, plan: run.plan, aliases: [], model: run.model, policy: run.policy, sourceIdentity: run.sourceIdentity, validRuns: [], failures: [], qualityReviews: [], otherRuns: [], status: 'unverified' }; groups.set(run.groupKey, method); }
    if (!method.aliases.includes(run.plan.id)) method.aliases.push(run.plan.id);
    method.otherRuns.push(run);
  }
  const timeline = relevant.filter(run => ['valid', 'failed', 'invalid', 'content-review-needed'].includes(run.status)).map(run => ({ run, at: ['valid', 'content-review-needed'].includes(run.status) ? run.completeAt : failureAt(run) })).sort((a, b) => a.at.localeCompare(b.at) || a.run.outputDirectory.localeCompare(b.run.outputDirectory));
  const anchor = { id: baselineId, key: baselineRun.groupKey, seconds: baselineRun.seconds, initialPromotionThresholdSeconds: baselineRun.seconds * (1 - minimumReduction),
    sourceIdentity: baselineRun.sourceIdentity, totalSamples: baselineRun.totalSamples, audioSeconds: baselineRun.audioSeconds, characters: baselineRun.characters, wordCount: baselineRun.wordCount, run: baselineRun.outputDirectory, startAt: baselineRun.startAt, completeAt: baselineRun.completeAt };
  let champion = null; const history = [];
  const stamp = (type, at, details) => { const event = { type, at, ...details }; event.id = hash(JSON.stringify(canonical(event))); history.push(event); };
  const eligible = method => method.validRuns.length >= 2 && !method.failures.length && !method.qualityReviews.length;
  function consider(method, at, reason) {
    if (!eligible(method) || champion?.key === method.key) return;
    const seconds = medianTwo(method.validRuns), comparator = champion?.medianSeconds ?? anchor.seconds;
    const initialBaseline = !champion && method.key === anchor.key;
    const reduction = 1 - seconds / comparator;
    method.promotionDecision = { at, comparatorSeconds: comparator, requiredSeconds: comparator * (1 - minimumReduction), reduction, promoted: initialBaseline || reduction + 1e-12 >= minimumReduction };
    if (!method.promotionDecision.promoted) return;
    const previous = champion;
    champion = { key: method.key, plan: method.plan, medianSeconds: seconds, twoRunSeconds: method.validRuns.slice(0, 2).map(run => run.seconds), runs: method.validRuns.slice(0, 2).map(run => run.outputDirectory), model: method.model, policy: method.policy, sourceIdentity: method.sourceIdentity, qualifiedAt: method.qualifiedAt };
    stamp(initialBaseline ? 'baseline-qualified' : 'promoted', at, { reason, previousKey: previous?.key || null, comparatorSeconds: comparator, reduction, champion: structuredClone(champion) });
  }
  for (const { run, at } of timeline) {
    const method = groups.get(run.groupKey);
    if (run.status === 'valid') {
      if (!method.validRuns.some(prior => prior.evidenceId === run.evidenceId || prior.outputDirectory === run.outputDirectory)) method.validRuns.push(run);
      if (method.validRuns.length === 2 && !method.failures.length) { method.qualifiedAt = at; consider(method, at, 'independent-two-run-median'); }
    } else {
      if (run.status === 'content-review-needed') method.qualityReviews.push(run); else method.failures.push(run);
      if (champion?.key === method.key) {
        stamp('withdrawn', at, { key: method.key, reason: run.status === 'content-review-needed' ? '同配置新结果文字显著缩短，暂撤竞速资格，等待内容核验。' : '同配置出现真实失败或无效结果，撤出稳定榜。', failedRun: run.outputDirectory, previousChampion: structuredClone(champion) });
        champion = null;
        const prior = [...history].reverse().find(event => event.champion && eligible(groups.get(event.champion.key)));
        if (prior) champion = structuredClone(prior.champion);
        for (const candidate of [...groups.values()].filter(eligible).sort((a, b) => (a.qualifiedAt || '').localeCompare(b.qualifiedAt || ''))) consider(candidate, at, 'reconsidered-after-withdrawal');
      }
    }
  }
  const methods = [...groups.values()].map(method => ({ ...method,
    status: method.failures.length ? 'unstable' : method.qualityReviews.length ? 'content-review-needed' : method.validRuns.length >= 2 ? 'stable-two-runs' : method.validRuns.length ? 'pending-repeat' : 'unverified',
    medianSeconds: method.validRuns.length >= 2 ? medianTwo(method.validRuns) : null,
    twoRunSeconds: method.validRuns.slice(0, 2).map(run => run.seconds), allRunSeconds: method.validRuns.map(run => run.seconds),
    improvementOverBaseline: method.validRuns.length >= 2 ? 1 - medianTwo(method.validRuns) / anchor.seconds : null,
    validRuns: method.validRuns.map(run => ({ outputDirectory: run.outputDirectory, seconds: run.seconds, startAt: run.startAt, completeAt: run.completeAt, characters: run.characters, wordCount: run.wordCount, implementation: run.implementation, transcriptSha256: run.transcriptSha256, artifacts: run.artifacts })),
    qualityReviews: method.qualityReviews.map(run => ({ outputDirectory: run.outputDirectory, seconds: run.seconds, characters: run.characters, wordCount: run.wordCount, contentCompleteness: run.contentCompleteness, issues: run.issues })),
    failures: method.failures.map(run => ({ outputDirectory: run.outputDirectory, at: failureAt(run), error: run.recordedError || run.issues?.join('；'), failingAudioSeconds: run.failingAudioSeconds, acceptedAudioSeconds: run.acceptedAudioSeconds, errorEvents: run.errorEvents, failureDetails: run.failureDetails })),
    otherRuns: method.otherRuns.map(run => ({ outputDirectory: run.outputDirectory, status: run.status, issues: run.issues })) })).sort((a, b) => (a.medianSeconds ?? Infinity) - (b.medianSeconds ?? Infinity));
  const baselineMethod = methods.find(method => method.key === anchor.key);
  anchor.status = baselineMethod?.status === 'unstable' ? 'single-pass-recheck-failed' : baselineMethod?.status === 'stable-two-runs' ? 'stable-two-runs' : 'single-pass-pending-repeat';
  const currentHistoryIds = new Set(history.map(event => event.id));
  const retainedHistory = previousHistory.filter(event => !currentHistoryIds.has(event.id)).map(event => ({ ...event, evidenceInvalidated: true, evidenceNote: '保留历史决定；当前原始证据不能重建此事件，不作为现榜首依据。' }));
  return { version: 1, updatedAt: now(), status: champion ? 'formal-champion' : 'no-stable-qualified-champion', minimumReduction,
    timingScope: 'raw-start-after-engine-ready-to-raw-complete', cpuComparison: 'not-requested', baseline: anchor, champion,
    nextPromotionThresholdSeconds: (champion?.medianSeconds ?? anchor.seconds) * (1 - minimumReduction),
    championHistory: [...history, ...retainedHistory].sort((a, b) => a.at.localeCompare(b.at)), methods,
    fastestStable: methods.find(method => method.status === 'stable-two-runs')?.key || null,
    runs: runs.map(run => relevant.find(item => item.outputDirectory === run.outputDirectory) || run), excludedSourceRuns: runs.filter(run => run.sourceIdentity && run.sourceIdentity !== anchor.sourceIdentity).map(run => run.outputDirectory) };
}

function renderMarkdown(board) {
  const number = value => Number.isFinite(value) ? value.toFixed(3) : '—';
  const percent = value => Number.isFinite(value) ? (value * 100).toFixed(2) + '%' : '—';
  const rows = ['# GPU 完整音轨加速榜', '', `更新时间：${board.updatedAt}`, '', '计时：引擎就绪后的 raw start → raw complete；不含下载、初装和首次音频预解码。仅独立整段、全样本覆盖、CUDA、无原始错误且文件哈希有效的轮次计入。', ''];
  if (!board.baseline) return rows.concat('尚无有效基准。', '').join('\n');
  rows.push(`基准锚：${number(board.baseline.seconds)} 秒；状态：${board.baseline.status}；初始 7% 目标：≤ ${number(board.baseline.initialPromotionThresholdSeconds)} 秒。`, '',
    `当前正式晋级榜首：${board.champion ? board.champion.plan.id + '，两轮中位 ' + number(board.champion.medianSeconds) + ' 秒' : '空；单轮成功或复验失败不能占榜。'}`, '',
    `下一晋级门槛：≤ ${number(board.nextPromotionThresholdSeconds)} 秒。同配置任何真实失败即列 unstable，不能挑第 3 轮忽略失败凑认证。`, '',
    '| 方案 | 状态 | 两轮秒数 | 中位秒 | 相对基准耗时下降 | 晋级状态 |', '| --- | --- | --- | ---: | ---: | --- |');
  for (const method of board.methods) rows.push(`| ${method.aliases.join(' / ')} | ${method.status} | ${method.twoRunSeconds.map(number).join(' / ') || '—'} | ${number(method.medianSeconds)} | ${percent(method.improvementOverBaseline)} | ${board.champion?.key === method.key ? '当前榜首' : method.status === 'unstable' ? '失效/不准入' : method.status === 'content-review-needed' ? '待内容核验/暂不准入' : method.promotionDecision?.promoted ? '曾晋级' : method.status === 'stable-two-runs' ? '有效，未达晋级门槛' : '待复验'} |`);
  rows.push('', '## 模型、参数、输入和记录路径', '', `同源音轨：${number(board.baseline.audioSeconds)} 秒；${board.baseline.totalSamples} 个 16kHz 样本。`, '');
  for (const method of board.methods) {
    rows.push(`### ${method.aliases.join(' / ')}`, '', `模型：${method.model.id || '未记录'}；路径：${method.model.directory || '未记录'}。`, '', `参数：\`${JSON.stringify(method.plan)}\``, '', `输入标识：\`${method.sourceIdentity}\`；策略：${method.policy}。`, '');
    for (const run of method.validRuns) rows.push(`- 有效轮：${number(run.seconds)} 秒；${run.characters ?? '未记录'} 字符；${run.outputDirectory}${run.implementation ? '；源码 ' + run.implementation.revision : ''}`);
    for (const run of method.qualityReviews) rows.push(`- 待内容核验：${run.characters} 字符/${run.wordCount} 词；${run.outputDirectory}；${run.issues.join('；')}`);
    for (const run of method.failures) rows.push(`- 失败：音频 ${number(run.failingAudioSeconds)} 秒处；${run.error || '见原始记录'}；${run.outputDirectory}`);
    rows.push('');
  }
  rows.push('## 晋级历史', '');
  for (const event of board.championHistory) rows.push(`- ${event.at} · ${event.type} · ${event.champion?.plan.id || event.previousChampion?.plan.id || event.key} · ${event.evidenceInvalidated ? '历史证据现已失效，保留记录' : event.reason || ''}`);
  if (!board.championHistory.length) rows.push('尚无满足独立双轮与 7% 规则的正式晋级。');
  rows.push('', '全部有效方案均保留，包括不足 7% 而未晋级的方案；单轮不抢榜，失败和失效历史不删除。不进行 CPU 比较。', '');
  return rows.join('\n');
}

export async function updateGpuLeaderboard({ inputFile, baselineId = baselinePlanId, minimumReduction = 0.07 } = {}) {
  const directory = path.dirname(path.resolve(inputFile)), lockFile = path.join(directory, '.leaderboard.lock');
  let handle;
  try { handle = fs.openSync(lockFile, 'wx'); } catch (error) { if (error.code !== 'EEXIST') throw error; const owner = readJson(lockFile); if (owner?.pid && alive(owner.pid)) return { skipped: 'leaderboard-update-in-progress' }; fs.unlinkSync(lockFile); handle = fs.openSync(lockFile, 'wx'); }
  fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: now() })); fs.closeSync(handle);
  try {
    const { assessFullResult } = await import('./gpu-queue-core.mjs');
    const input = readJson(path.resolve(inputFile)), state = readJson(path.join(directory, 'queue-state.json'), { runs: [] });
    if (!input?.source) throw Error('缺少音视频输入来源。');
    const runsDirectory = path.join(directory, 'runs'), candidates = new Map();
    for (const run of [...(state.runs || []), ...(state.current ? [state.current] : [])]) if (run.outputDirectory) candidates.set(path.resolve(run.outputDirectory), run);
    if (fs.existsSync(runsDirectory)) for (const name of fs.readdirSync(runsDirectory)) {
      const dir = path.join(runsDirectory, name);
      if (fs.lstatSync(dir).isDirectory() && !candidates.has(dir) && ['result.json', 'raw-results.jsonl', 'checkpoint.json'].some(file => fs.existsSync(path.join(dir, file)))) candidates.set(dir, {});
    }
    const machine = readJson(path.join(directory, 'machine.json'), {}), runs = [];
    for (const [outputDirectory, recorded] of candidates) runs.push(await auditLeaderboardRun({ outputDirectory, recorded, input, machine, assess: assessFullResult }));
    const previous = readJson(path.join(directory, 'leaderboard.json'), {});
    const board = buildSpeedLeaderboard(runs, { baselineId, minimumReduction, previousHistory: previous.championHistory || [] });
    atomic(path.join(directory, 'leaderboard.json'), JSON.stringify(board, null, 2) + '\n'); atomic(path.join(directory, 'LEADERBOARD.md'), renderMarkdown(board));
    return { ...board, jsonFile: path.join(directory, 'leaderboard.json'), markdownFile: path.join(directory, 'LEADERBOARD.md') };
  } finally { fs.unlinkSync(lockFile); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inputFile, ...flags] = process.argv.slice(2);
  if (!inputFile || flags.some(flag => flag !== '--watch')) throw Error('用法：node scripts/gpu-leaderboard.mjs <queue-input.json> [--watch]');
  const refresh = async () => { const board = await updateGpuLeaderboard({ inputFile }); console.log(JSON.stringify({ at: now(), status: board.status || board.skipped, champion: board.champion?.plan.id || null, thresholdSeconds: board.nextPromotionThresholdSeconds, jsonFile: board.jsonFile })); };
  await refresh();
  if (flags.includes('--watch')) {
    let active = false; const timer = setInterval(async () => { if (active) return; active = true; try { await refresh(); } catch (error) { console.error(JSON.stringify({ event: 'leaderboard-error', at: now(), error: error.message })); } finally { active = false; } }, 2000);
    const stop = () => clearInterval(timer); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }
}
