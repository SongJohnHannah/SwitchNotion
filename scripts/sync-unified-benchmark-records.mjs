import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { writeAtomicJson } = require('../src/speech/atomic-json.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const median = values => { const a = [...values].sort((x, y) => x - y); const n = Math.floor(a.length / 2); return a.length ? a.length % 2 ? a[n] : (a[n - 1] + a[n]) / 2 : null; };
const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '—';
const cell = value => String(value ?? '—').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const row = values => `| ${values.map(cell).join(' | ')} |`;

function compactReport(report = {}) {
  return { status: report.status, runtimeStatus: report.runtimeStatus, error: report.error,
    anomalyCount: report.anomalyCount, identityIssues: report.identityIssues || [],
    structureIssues: report.structureIssues || [], mappingWarnings: report.mappingWarnings || [],
    anomalies: report.anomalies || [], runtime: report.runtime || null,
    fingerprints: report.fingerprints || null, scope: report.scope || null,
    referenceKind: report.referenceKind, contentStatus: report.contentStatus || null,
    windowAuditStatus: report.windowAuditStatus || null, namedCoverage: report.namedCoverage || null,
    actualInputAndWorkerAudit: report.actualInputAndWorkerAudit || null,
    hardFailureReasons: report.hardFailureReasons || [], automaticPromotion: report.automaticPromotion };
}

export function buildSummary({ state, stateFile, previous = {}, reports = {}, profileDecisions = {}, contentHash }) {
  const runRoot = state.runRoot || path.dirname(stateFile);
  const sessionId = path.resolve(stateFile);
  const sessions = new Map((previous.sessions || []).map(session => [session.id, session]));
  sessions.set(sessionId, { id: sessionId, runRoot, source: state.source,
    createdAt: state.createdAt, completedAt: state.completedAt || null, mode: state.mode,
    baselineSeconds: state.baselineSeconds || [], inferenceThresholdSeconds: state.inferenceThresholdSeconds,
    series: state.series || [], pipeline: state.pipeline || null, active: state.active || null,
    stateContentHash: contentHash });
  const attempts = new Map((previous.attempts || []).map(attempt => [attempt.id, attempt]));
  for (const attempt of state.attempts || []) {
    const id = attempt.directory ? path.resolve(attempt.directory) : `${sessionId}:${attempt.profile}:${attempt.phase}:${attempt.round}:${attempt.startedAt}`;
    const report = compactReport(reports[attempt.directory] || attempt.report);
    const item = { ...attempt, id, sessionId, report,
      qualityReportFile: attempt.directory ? path.join(attempt.directory, 'quality-report.json') : null };
    const old = attempts.get(id);
    // Never erase the earlier completed attempt if an edited source later
    // changes it. Retain snapshots alongside the latest view of that identity.
    const history = old?.history || [];
    if (old) {
      const { history: _oldHistory, ...oldValue } = old;
      if (JSON.stringify(oldValue) !== JSON.stringify(item)) history.push(oldValue);
    }
    attempts.set(id, { ...item, ...(history.length ? { history } : {}) });
  }
  return { version: 1, updatedAt: new Date().toISOString(),
    purpose: 'Live experiment records only; no production promotion or mutation.',
    seriesRule: 'Only state.series.status=eligible qualifies; canary is not a full run; all completed attempts retained, no third-round survivor selection.',
    timingScopes: { inference: 'engine-ready-to-final-transcript, excludes preparation/loading/queue',
      pipeline: 'cold task start through returned result AND content/PCM audit; paired queue-free control, separate from inference' },
    profileDecisions, sessions: [...sessions.values()], attempts: [...attempts.values()] };
}

function runtimeFailed(attempt) {
  return attempt.report?.runtimeStatus === 'runtime-review' || Boolean(attempt.error) || attempt.complete !== true;
}
function contentReview(attempt) {
  return attempt.report?.status === 'content-review' || (attempt.report?.identityIssues || []).length > 0;
}
function runtimeLabel(attempt) {
  if (!runtimeFailed(attempt)) return attempt.report?.runtimeStatus === 'pass' ? '通过' : '待判定';
  const message = `${attempt.error || ''} ${attempt.report?.error || ''}`;
  return /EPERM|EBUSY|EACCES|rename|persistence/i.test(message) ? '持久化/运行失败' : '运行失败（原因见记录）';
}
function attemptRows(attempts) {
  return attempts.map(attempt => row([attempt.profile, attempt.round, attempt.phase,
    attempt.complete === true ? '完成' : '未完成', runtimeLabel(attempt),
    contentReview(attempt) ? '内容复核' : attempt.report?.status === 'pass' ? '通过' : '未评判',
    number(attempt.report?.runtime?.recognitionSeconds), number(attempt.adapterWallSeconds),
    attempt.waitedForGpu ? '有等待' : '无等待', attempt.directory]));
}

export function renderRecords(summary) {
  const board = ['# 实时实验榜单', '', `更新时间：${summary.updatedAt}`, '',
    '本页仅记录实验。短测、整片识别计时、冷任务端到端配对分别列示；没有自动修改生产方案。Native 机器参考不是人工真值稿，质量通过不代表零漏词。', ''];
  for (const session of summary.sessions) {
    const attempts = summary.attempts.filter(attempt => attempt.sessionId === session.id);
    board.push(`## ${session.runRoot}`, '', `状态：${session.completedAt ? '已结束' : '运行中'}；来源：${session.source || '—'}。`, '',
      `识别阶段基线：${(session.baselineSeconds || []).map(number).join(' / ')} 秒；中位 ${number(median(session.baselineSeconds || []))} 秒；7%门槛 ${number(session.inferenceThresholdSeconds)} 秒。`, '');
    if (session.active) board.push(`当前任务：${session.active.profile} / ${session.active.phase} / 第 ${session.active.round} 轮，开始于 ${session.active.startedAt}。`, '');
    board.push('### 识别阶段系列判定', '', '| 候选 | state系列状态 | 整片轮次 | 中位识别秒 | 降幅 | 判定 |', '| --- | --- | ---: | ---: | ---: | --- |');
    for (const series of session.series || []) {
      const rounds = attempts.filter(attempt => attempt.profile === series.profile && attempt.phase === 'full');
      const decision = summary.profileDecisions?.[series.profile];
      const held = ['failed', 'content-review-needed', 'rejected'].includes(decision?.status);
      const qualified = !held && series.status === 'eligible' && rounds.length >= 2 && rounds.every(attempt => !runtimeFailed(attempt) && !contentReview(attempt) && attempt.report?.status === 'pass');
      const candidateMedian = series.candidateMedianSeconds ?? series.speed?.candidateMedianSeconds;
      const improvement = series.improvement ?? series.speed?.improvement;
      const functional = series.functionalStatus === 'machine-reference-exact-two-rounds' ? '功能双轮与机器参考原文一致；未自动晋级'
        : series.functionalStatus === 'pending-independent-content-review' ? '具名回归与全片运行通过，全文差异待独立复核'
        : series.functionalStatus === 'failed' ? '功能验收失败；速度不授予资格' : null;
      board.push(row([series.profile, series.status, rounds.length, number(candidateMedian),
        typeof improvement === 'number' ? `${(improvement * 100).toFixed(2)}%` : '—',
        held ? `${decision.status}；${decision.reviewReason || '独立复核拦截'}` : functional || (qualified ? '达到7%且双轮（实验资格，未生产晋级）' : '未达到系列资格')]));
    }
    if (!(session.series || []).length) board.push(row(['—', '待整片系列结束', '—', '—', '—', '未判定']));
    const header = ['| 候选 | 轮 | 阶段 | 完整性 | 运行 | 内容 | 识别秒 | 任务含审查秒 | GPU队列 | 原始目录 |', '| --- | ---: | --- | --- | --- | --- | ---: | ---: | --- | --- |'];
    for (const [title, filter] of [
      ['90秒 CAN 短测：仅证明该窗口', attempt => attempt.phase === 'canary'],
      ['整片识别尝试：失败与内容复核分列', attempt => attempt.phase === 'full'],
      ['冷任务端到端：对照/流水线单独比较', attempt => ['full-control', 'full-pipeline'].includes(attempt.phase)],
    ]) board.push(`### ${title}`, '', ...header, ...attemptRows(attempts.filter(filter)), '');
    const pipeline = session.pipeline;
    if (pipeline) {
      board.push(`冷任务配对状态：${pipeline.status}。`, '',
        `对照任务墙钟（含内容/PCM审查）：${(pipeline.controlWallSeconds || []).map(number).join(' / ')} 秒；流水线：${(pipeline.pipelineWallSeconds || []).map(number).join(' / ')} 秒。`, '',
        `记录的端到端降幅：${typeof pipeline.reduction === 'number' ? (pipeline.reduction * 100).toFixed(2) + '%' : '—'}。计时口径：${pipeline.timingScope}。`, '',
        `计时更正：旧state的timingScope写API返回，实际计时器在内容/PCM审查后停止；此处按真实口径展示。原state保留。本组对照 ${pipeline.controlWallSeconds?.length || 0} 轮、流水线 ${pipeline.pipelineWallSeconds?.length || 0} 轮；原实现采用算术平均，恰好两轮时与中位数相同。不足双轮或失败仍按 not-eligible 记录。该比较不进入上方旧识别阶段榜。`, '');
    }
  }
  const pitfalls = ['# 实时实验错题', '', `更新时间：${summary.updatedAt}`, '',
    '保留每次已发生尝试及其原始目录。单次 full 失败后停止该候选；每候选计划最多两次整片，不增开第三轮挑幸存者。CAN短测通过不能替代整片两轮。内容复核与运行失败分开，运行失败本身不等于已证实 GPU 硬件故障。', ''];
  for (const [title, predicate] of [
    ['运行或持久化失败', runtimeFailed], ['内容或固定输入待复核', contentReview],
  ]) {
    pitfalls.push(`## ${title}`, '');
    const values = summary.attempts.filter(predicate);
    if (!values.length) pitfalls.push('暂无已完成尝试落入此类；正在运行的任务尚未判定。', '');
    for (const attempt of values) {
      pitfalls.push(`### ${attempt.profile} / ${attempt.phase} / 第 ${attempt.round} 轮`, '',
        `时间：${attempt.startedAt || '—'} → ${attempt.endedAt || '—'}；完整：${attempt.complete === true}；运行：${runtimeLabel(attempt)}；内容：${attempt.report?.status || '—'}。`, '',
        `错误：${attempt.error || attempt.report?.error || '无运行错误记录'}。`, '',
        `原始目录：${attempt.directory || '—'}；质量报告：${attempt.qualityReportFile || '—'}。`, '');
      if (attempt.report?.identityIssues?.length) pitfalls.push(`输入/参考问题：${attempt.report.identityIssues.join('；')}。`, '');
      for (const anomaly of attempt.report?.anomalies || []) pitfalls.push(
        `- ${anomaly.start}–${anomaly.end}秒（${anomaly.scaleSeconds}秒窗）：参考约${number(anomaly.reference?.words)}词，候选约${number(anomaly.candidate?.words)}词；${(anomaly.reasons || []).join('、')}；静音豁免=${anomaly.exemption || '无'}。`);
      pitfalls.push('');
    }
  }
  return { board: board.join('\n') + '\n', pitfalls: pitfalls.join('\n') + '\n' };
}

async function optionalJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function syncOnce({ stateFile, outputDirectory, lastHash }) {
  const stateText = await fs.readFile(stateFile, 'utf8');
  const state = JSON.parse(stateText);
  const reports = {};
  const reportTexts = [];
  for (const directory of [...new Set((state.attempts || []).map(attempt => attempt.directory).filter(Boolean))].sort()) {
    try {
      const text = await fs.readFile(path.join(directory, 'quality-report.json'), 'utf8');
      reports[directory] = JSON.parse(text); reportTexts.push([directory, text]);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const machine = await optionalJson(path.join(path.dirname(outputDirectory), 'machine.json'));
  const profileDecisions = Object.fromEntries(Object.entries(machine?.profiles || {}).map(([name, profile]) => [name,
    { status: profile.status || null, reviewReason: profile.reviewReason || null, reviewFile: profile.reviewFile || null }]));
  const contentHash = hash(JSON.stringify([stateText, reportTexts, profileDecisions]));
  if (contentHash === lastHash) return { changed: false, contentHash, complete: Boolean(state.completedAt) };
  const summaryFile = path.join(outputDirectory, 'SUMMARY.json');
  const previous = await optionalJson(summaryFile) || {};
  const summary = buildSummary({ state, stateFile, previous, reports, profileDecisions, contentHash });
  const { board, pitfalls } = renderRecords(summary);
  await fs.mkdir(outputDirectory, { recursive: true });
  // JSON is durable and retains all attempts before the human-facing views.
  await writeAtomicJson(summaryFile, summary);
  await fs.writeFile(path.join(outputDirectory, '实时榜单.md'), board, { encoding: 'utf8', flush: true });
  await fs.writeFile(path.join(outputDirectory, '实时错题.md'), pitfalls, { encoding: 'utf8', flush: true });
  return { changed: true, contentHash, complete: Boolean(state.completedAt), attempts: summary.attempts.length, outputDirectory };
}

async function main() {
  const args = process.argv.slice(2);
  const values = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--once') values.once = true;
    else if (args[index] === '--watch') values.once = false;
    else if (args[index].startsWith('--') && args[index + 1]) values[args[index].slice(2)] = args[++index];
    else throw Error('Usage: --state STATE.json [--bundle BUNDLE] [--out-dir DIR] [--once|--watch] [--interval 3000]');
  }
  const bundle = path.resolve(values.bundle || 'D:/迅雷下载/notionSwitch/GPU转写算子');
  const outputDirectory = path.resolve(values['out-dir'] || path.join(bundle, 'experiments'));
  let stateFile = values.state && path.resolve(values.state);
  if (!stateFile) {
    const entries = await fs.readdir(path.join(bundle, 'experiments'), { withFileTypes: true });
    const latest = entries.filter(entry => entry.isDirectory() && entry.name.startsWith('runs-')).map(entry => entry.name).sort().at(-1);
    if (!latest) throw Error('No experiments/runs-* state found; pass --state');
    stateFile = path.join(bundle, 'experiments', latest, 'state.json');
  }
  const interval = Number(values.interval || 3000);
  if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 60000) throw Error('interval must be 1000–60000 ms');
  let lastHash;
  for (;;) {
    try {
      const result = await syncOnce({ stateFile, outputDirectory, lastHash });
      lastHash = result.contentHash;
      if (result.changed) console.log(JSON.stringify({ at: new Date().toISOString(), event: 'records-synced', ...result }));
      if (values.once || result.complete) break;
    } catch (error) {
      if (values.once) throw error;
      console.error(JSON.stringify({ at: new Date().toISOString(), event: 'records-read-retry', error: error.message }));
    }
    await pause(interval);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
