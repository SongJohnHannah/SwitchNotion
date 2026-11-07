import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Metadata/archive finalization only. No inference imports, child processes,
// model/plan writes, experimental promotion, or recursive deletion.
const defaultProject = path.resolve(import.meta.dirname, '..');
const defaultBundle = 'D:\\迅雷下载\\notionSwitch\\GPU转写算子';
const median = values => { const a = values.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2 : null; };
const round = value => value === null ? null : Number(value.toFixed(6));
const clone = value => JSON.parse(JSON.stringify(value));
const cell = value => String(value ?? '—').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const row = values => '| ' + values.map(cell).join(' | ') + ' |';
const privatePart = part => /^(?:\.git|node_modules|__pycache__|\.env(?:\..*)?|.*\.local\.json|.*(?:api[-_]?key|cookies|credentials).*\.(?:txt|json))$/i.test(part);

function guard(root) {
  if (!path.isAbsolute(root) || !fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw Error('目录必须是已存在的绝对真实目录。');
  root = fs.realpathSync(root);
  const inside = relative => {
    if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative)) throw Error('包内路径必须为非空相对路径。');
    const result = path.resolve(root, relative), rest = path.relative(root, result);
    if (!rest || rest === '..' || rest.startsWith('..' + path.sep) || path.isAbsolute(rest)) throw Error('路径越出指定目录：' + relative);
    let cursor = root;
    for (const part of rest.split(path.sep)) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('归档路径不能含符号链接：' + relative);
    }
    return result;
  };
  const relative = absolute => { const rel = path.relative(root, path.resolve(absolute)); inside(rel); return rel.replaceAll('\\', '/'); };
  return { root, inside, relative };
}
async function digest(file) {
  const before = fs.statSync(file), hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  const after = fs.statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('归档时文件仍在变化：' + file);
  return { sha256: hash.digest('hex'), bytes: after.size };
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function filesUnder(scope, relative, accept = () => true, depthLimit = Infinity) {
  const output = [];
  function visit(rel, depth) {
    const file = scope.inside(rel), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw Error('归档输入含链接：' + rel);
    if (stat.isDirectory()) {
      if (depth > depthLimit) return;
      for (const name of fs.readdirSync(file).sort()) if (!privatePart(name)) visit(path.join(rel, name), depth + 1);
    } else if (stat.isFile() && accept(rel)) output.push(rel.replaceAll('\\', '/'));
  }
  if (fs.existsSync(scope.inside(relative))) visit(relative, 0);
  return output;
}

export function buildLeaderboard({ validation, summary, machine }) {
  const baseline = round(validation.recognitionMedianSeconds);
  if (Math.abs(baseline - 194.092) > .000001 || validation.independentFullRuns < 2 || validation.packagedEntryGpuValidated !== true) throw Error('VALIDATION 不是本次194.092秒双轮封装基线。');
  const names = new Set([...Object.keys(machine.profiles || {}), ...Object.keys(summary.profileDecisions || {}), ...(summary.attempts || []).map(a => a.profile)]);
  const candidates = [];
  for (const name of names) {
    if (['winner', 'native30'].includes(name)) continue;
    const profile = machine.profiles?.[name] || {}, decision = summary.profileDecisions?.[name] || {};
    const evidenceProfile = profile.sourceCandidate || (name === 'native30-streaming' ? 'bench-native-pipeline' : name);
    const pipeline = profile.entryFile?.endsWith('/gpu-pipelined-file.cjs') === true;
    const attempts = (summary.attempts || []).filter(a => a.profile === evidenceProfile);
    const full = attempts.filter(a => a.phase === (pipeline ? 'full-pipeline' : 'full'));
    const failed = attempts.some(a => a.error || a.complete === false || ['runtime-review', 'content-review'].includes(a.report?.runtimeStatus));
    const blocked = [profile.status, decision.status];
    const contentHeld = blocked.some(s => ['content-review-needed', 'content-review', 'rejected'].includes(s)) || ['bench-native-whole120', 'bench-native-whole240'].includes(name);
    const forcedFailure = ['bench-native-d2d2x30', 'bench-native-d2d4x30'].includes(name);
    const runtimeFailed = blocked.includes('failed') || failed || forcedFailure;
    const fullSeconds = full.filter(a => a.complete === true && a.report?.runtime?.complete === true &&
      a.report.runtime.fresh === true && a.report.runtime.device === 'cuda' && a.report.runtime.errors === 0 &&
      a.report.runtime.recoveries === 0 && a.report.runtime.nativeExits === 0 && a.report.runtimeStatus === 'pass')
      .map(a => a.report.runtime.recognitionSeconds).filter(Number.isFinite);
    const validFull = full.filter(a => a.complete === true && a.report?.runtime?.complete === true && a.report?.runtime?.fresh === true &&
      a.report.runtime.errors === 0 && a.report.runtime.recoveries === 0 && a.report.runtime.nativeExits === 0 && a.report.status === 'pass');
    const series = (summary.sessions || []).flatMap(s => s.series || []).filter(s => s.profile === evidenceProfile);
    const speedScreened = series.some(s => s.speedStop === true && s.speedStopReason === 'below7%');
    const optional = profile.experimental === false && profile.status === 'validated-optional';
    let status = optional ? 'validated-optional-not-default' : contentHeld ? 'content-review-needed' : runtimeFailed ? 'failed' :
      validFull.length >= 2 && series.some(s => s.status === 'eligible') ? 'eligible-experiment-not-promoted' :
        validFull.length >= 2 ? 'full-runs-complete-no-qualifying-speedup' : speedScreened ? 'stopped-below7%' : full.length ? 'incomplete-series' : 'canary-only-or-not-run';
    // Manual content decisions and real failures outrank an old speed gate.
    if (contentHeld) status = 'content-review-needed';
    else if (runtimeFailed) status = 'failed';
    const measuredMedianSeconds = fullSeconds.length >= 2 ? round(median(fullSeconds)) : null;
    candidates.push({ profile: name, evidenceProfile, timingScope: pipeline ? 'Pipeline inference recorded separately from cold task preparation comparison' : validation.timingScope,
      status, productionDefault: false, promotedByThisFinalizer: false,
      machineStatus: profile.status || null, summaryStatus: decision.status || null, experimental: profile.experimental !== false,
      implementationRevision: profile.implementationRevision || null, entryFile: profile.entryFile || null,
      fullRunSeconds: fullSeconds, measuredMedianSeconds, reductionVersusPackagedBaseline: measuredMedianSeconds === null ? null : 1 - measuredMedianSeconds / baseline,
      validFullRuns: validFull.length, canaryAttempts: attempts.filter(a => a.phase === 'canary').length, fullAttempts: full.length,
        reviewReason: profile.reviewReason || decision.reviewReason || (speedScreened ? '首轮整片未达到7%提速门槛，已保存结果并停止；不是GPU运行失败，也不宣称双轮稳定。' : null), reviewFile: profile.reviewFile || decision.reviewFile || null,
      attemptReferences: attempts.map(a => ({ phase: a.phase, round: a.round, directory: a.directory, complete: a.complete,
        recognitionSeconds: a.report?.runtime?.recognitionSeconds ?? null, adapterWallSeconds: a.adapterWallSeconds ?? null,
        status: a.report?.status || null, error: a.error || a.report?.error || null, reportFile: a.qualityReportFile || null })), series });
  }
  return { version: 2, updatedAt: new Date().toISOString(), timingScope: validation.timingScope,
    formalChampion: { profile: 'winner', alias: 'native30', status: 'validated-default-preserved', twoRunSeconds: validation.rounds.map(r => r.recognitionSeconds),
      medianSeconds: baseline, validationFile: 'VALIDATION.json', textSha256: validation.expectedTextSha, pcmSha256: validation.expectedPcmSha },
    minimumPromotionReduction: .07, nextThresholdSeconds: round(baseline * .93), fiftyPercentTargetSeconds: round(baseline * .5),
    fiftyPercentGoalReachedByQualifiedProfile: false, promotionPerformed: false,
    historicalTiming: { oldProjectNative30MedianSeconds: 216.2185, oldProjectRecord: 'records/gpu-v1/leaderboard.json',
      unstableSinglePassAnchor: { seconds: 609.089, status: 'single-success-repeat-failed-not-a-stable-baseline' },
      oldBatch2SpeedOnly: { medianSeconds: 104.631, status: 'content-review-needed-not-production' } },
    scopeWarning: 'Cold preparation/model/queue time, partial failed inference and 90-second canaries are never ranked as complete-video inference.',
    candidates: candidates.sort((a, b) => (a.measuredMedianSeconds ?? Infinity) - (b.measuredMedianSeconds ?? Infinity)),
    preparationComparisons: (summary.sessions || []).filter(s => s.pipeline).map(s => ({ runRoot: s.runRoot, ...s.pipeline,
      recordedTimingScope: s.pipeline.timingScope, timingScope: summary.timingScopes?.pipeline || 'task start through returned result AND subsequent content/PCM audit' })),
    allExperimentRecords: 'experiments/SUMMARY.json', independentContentReview: 'experiments/whole-window-content-review/README.md' };
}

function leaderboardMarkdown(board) {
  const champ = board.formalChampion;
  const safe120 = board.candidates.find(candidate => candidate.profile === 'native120-complete');
  return '# 正式榜单与全部实验结果\n\n' +
    `正式默认仍为 winner / native30：${champ.twoRunSeconds.join(' / ')}秒，中位 **${champ.medianSeconds}秒**。${board.timingScope}。\n\n` +
    (safe120 ? `已保留可用的120秒稳定修复接口 native120-complete：${safe120.fullRunSeconds.join(' / ')}秒，中位 **${safe120.measuredMedianSeconds}秒**，慢约5.6%仍按用户要求保留。120秒为输入容器，内部30秒稳定识别；五项已知漏句及全原文一致性双轮通过，不是速度晋级。[验收与引用](120秒稳定修复.md)。\n\n` : '') +
    `7%门槛 ${board.nextThresholdSeconds}秒；本轮50%目标 **${board.fiftyPercentTargetSeconds}秒**，未达到。此脚本不晋级任何实验。\n\n` +
    row(['方案', '状态', '整片运行计时记录（秒）', '计时中位', '相对正式版', '复核/失败理由']) + '\n' + row(['---', '---', '---', '---', '---', '---']) + '\n' +
    board.candidates.map(c => row([c.profile, c.status, c.fullRunSeconds.join(' / ') || '无完整有效时间', c.measuredMedianSeconds,
      c.reductionVersusPackagedBaseline === null ? '—' : (c.reductionVersusPackagedBaseline * 100).toFixed(2) + '%', c.reviewReason || '未作默认晋级'])).join('\n') +
    '\n\nwhole120/240 即使旧计数 gate eligible，仍由逐句内容复核拦截；D2D及其他失败系列不取部分耗时或挑选幸存轮。可选 native30-streaming 保留，不视为默认提速晋级。\n\n' +
    '音频准备/流水线的冷任务计时单列，详见 [实验摘要](experiments/SUMMARY.json) 和 [实时榜单](experiments/实时榜单.md)；约1.1%的端到端改进不是神经识别快50%。\n\n' +
    '历史原工程Native30中位216.2185秒与早期609.089秒单轮成功/复验失败锚分别保留，不替换当前194.092秒基线。104.631秒旧B2有内容漏写，不能作为正式成绩。\n\n' +
    '[正式验收](VALIDATION.json) · [接入验收](INTEGRATION-VALIDATION.json) · [逐句复核](experiments/whole-window-content-review/README.md) · [踩坑入口](踩坑记录.md)\n';
}

const exclusions = [
  { path: 'PACKAGE-MANIFEST.json', reason: 'Current manifest cannot hash itself.' },
  { path: '.finalize-unified.lock', reason: 'Owned temporary finalization lock.' },
  { path: '**/__pycache__/**', reason: 'Interpreter-generated mutable bytecode caches.' },
  { path: 'outputs/**, video-runs/**', reason: 'User-created mutable future output directories; never deleted.' },
  { path: 'resources/speech/operator-sessions/**', reason: 'Mutable recording/PCM session logs and checkpoints.' },
  { path: 'resources/speech/gpu-leases/**', reason: 'Mutable cross-process queue ownership.' },
  { path: 'resources/**/{cache,cuda-cache,audio-cache,huggingface,hf-cache,native-faults,worker-failures,library-audits}/**', reason: 'Runtime caches/fault/worker/DLL diagnostics can change after delivery.' },
  { path: 'resources/**/*.local.json, **/.transcription.lock', reason: 'Mutable runtime configuration and active task ownership.' },
];
function excluded(relative) {
  const parts = relative.split('/');
  if (['PACKAGE-MANIFEST.json', '.finalize-unified.lock'].includes(relative)) return true;
  if (parts.includes('__pycache__') || parts.at(-1) === '.transcription.lock') return true;
  if (['outputs', 'video-runs'].includes(parts[0])) return true;
  if (parts[0] !== 'resources') return false;
  return parts.some(part => /^(?:operator-sessions|gpu-leases|cache|caches|cuda-cache|audio-cache|huggingface|hf-cache|native-faults?|worker-failures?|library-audits)$/i.test(part)) ||
    /(?:\.local\.json|native-fault[^/]*|worker-fail[^/]*)$/i.test(parts.at(-1));
}

export async function finalizeUnifiedOperator({ projectDirectory = defaultProject, bundleDirectory = defaultBundle, onProgress = value => console.log(JSON.stringify(value)) } = {}) {
  const project = guard(projectDirectory), bundle = guard(bundleDirectory);
  const validation = readJson(bundle.inside('VALIDATION.json')), summary = readJson(bundle.inside('experiments/SUMMARY.json'));
  const machine = readJson(bundle.inside('machine.json'));
  if ((summary.sessions || []).some(s => s.active)) throw Error('实验仍有active任务；请在最后GPU任务结束并同步SUMMARY后再归档。');
  for (const file of ['docs/GPU-OPERATOR-README.md', 'docs/VIDEO-TRANSCODE.md', 'docs/PCM-PIPELINE.md', 'src/speech/file-operator.d.cts']) project.inside(file);
  for (const name of ['winner', 'native30']) if (!machine.profiles?.[name]?.planFile) throw Error('缺少原稳定profile，停止归档。');
  const board = buildLeaderboard({ validation, summary, machine });
  const resources = bundle.relative(bundle.inside(machine.resourcesRoot));
  const leaseDirectory = bundle.inside(path.join(resources, 'speech/gpu-leases'));
  if (fs.existsSync(leaseDirectory)) for (const name of fs.readdirSync(leaseDirectory)) {
    const ownerFile = bundle.inside(path.join(resources, 'speech/gpu-leases', name, 'owner.json'));
    if (!fs.existsSync(ownerFile)) throw Error('GPU租约正在创建，尚不能归档。');
    const owner = readJson(ownerFile); let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw Error('GPU租约仍被占用，请完成并释放任务后再归档。');
  }
  const token = randomUUID(), lock = bundle.inside('.finalize-unified.lock');
  const descriptor = fs.openSync(lock, 'wx'); fs.writeFileSync(descriptor, token); fs.closeSync(descriptor);
  const version = 'versions/finalize-unified-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + token.slice(0, 8);
  const backedUp = new Set(), journal = [];
  const allowedPublic = new Set(['README.md', 'operator.d.cts', 'VIDEO-TRANSCODE.md', 'VIDEO-OPTIMIZATION-PLANS.md', 'PCM-PIPELINE.md', '榜单.md', '榜单.json', 'machine.json', '踩坑记录.md', 'QUALITY-AND-LIMITS.md', 'NEXT-OPTIMIZATIONS.md', 'PACKAGE-MANIFEST.json']);
  function writable(relative) {
    const rel = relative.replaceAll('\\', '/');
    if (!allowedPublic.has(rel) && !rel.startsWith(version + '/') && !rel.startsWith('records/current-project/') && !rel.startsWith('records/gpuops-build/')) throw Error('禁止写入稳定实现/plan/binary/session目录：' + relative);
    return bundle.inside(rel);
  }
  async function backup(relative) {
    if (backedUp.has(relative) || !fs.existsSync(bundle.inside(relative))) return;
    const destination = writable(version + '/previous/' + relative); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(bundle.inside(relative), destination, fs.constants.COPYFILE_EXCL); backedUp.add(relative);
  }
  // Temporary paths have the same authorized destination plus our own token.
  const originalWritable = writable;
  const temporarySuffix = '.' + token + '.tmp';
  function atomicTarget(relative) { return relative.endsWith(temporarySuffix) ? originalWritable(relative.slice(0, -temporarySuffix.length)) + temporarySuffix : originalWritable(relative); }
  async function copyRecord(sourceScope, sourceRelative, targetRelative) {
    if (sourceRelative.split(/[\\/]/).some(privatePart)) throw Error('拒绝归档凭据或可变配置：' + sourceRelative);
    const source = sourceScope.inside(sourceRelative), destination = writable(targetRelative);
    await backup(targetRelative); fs.mkdirSync(path.dirname(destination), { recursive: true });
    const before = await digest(source); fs.copyFileSync(source, destination);
    const after = await digest(destination); if (before.sha256 !== after.sha256) throw Error('归档副本哈希不匹配：' + sourceRelative);
    return { source: sourceRelative, destination: targetRelative, ...after };
  }
  const protectedNames = new Set(['operator.cjs', 'run.mjs', 'run.cmd', 'bridge.mjs']);
  for (const dir of ['module', 'profiles', 'bin', path.dirname(machine.sessionEntryFile || 'module/src/speech/operator-session.cjs')]) {
    for (const file of filesUnder(bundle, dir)) protectedNames.add(file);
  }
  const protectedBefore = new Map();
  try {
    fs.mkdirSync(bundle.inside(version), { recursive: true });
    for (const name of fs.readdirSync(bundle.root)) if (/\.(?:md|json|cts)$/i.test(name) && !privatePart(name)) await backup(name);
    for (const name of protectedNames) protectedBefore.set(name, await digest(bundle.inside(name)));
    const archive = [];
    const selected = new Set(filesUnder(project, 'src/speech', rel => /\.(?:cjs|mjs|js|py|json|cts|cpp|cc|cu|h|hpp|md|txt|patch)$/i.test(rel)));
    const appFiles = ['src/collection/media.cjs', 'src/collection/service.cjs', 'src/media-transcript.cjs', 'src/settings/index.html', 'src/settings/settings.js', 'src/settings/speech-presentation.js', 'src/speech/operator-client.cjs', 'src/speech/operator-session-client.cjs', 'src/speech/settings.cjs', 'src/speech-provider.cjs', 'src/speech-provider.d.cts'];
    appFiles.forEach(file => selected.add(file));
    for (const rel of filesUnder(project, 'tests', rel => /\.(?:mjs|py)$/i.test(rel) && /^(?:speech|operator|file-operator|native-fp16|media-transcript-operator|collection-(?:operator|video-operator|media|service|extraction)|meeting-recordings|unified-benchmark|whole120|verify-whole120|admit-.*120|test_audit|.*gpuops)/.test(path.basename(rel)))) selected.add(rel);
    for (const rel of filesUnder(project, 'scripts', rel => /\.(?:mjs|cjs|py|ps1)$/i.test(rel) && /^(?:benchmark-|verify-(?:.*operator|whole120)|check-whole120|probe-(?:whole120|native-fp16)|admit-.*120|sync-unified-|prepare-(?:operator|native|short|whole120)|(?:build|publish|check)-native-(?:gpuops|fp16)|audit-transcript-|finalize-(?:unified|gpu)|export-gpu-operator|gpu-|migrate-gpu|transcribe-gpu|watch-gpu|start-desktop|prepare-desktop|runtime-update|native-fs|asar|desktop-compat|runtime-health|open-update)/.test(path.basename(rel)))) selected.add(rel);
    for (const rel of filesUnder(project, 'docs', rel => /\.(?:md|json)$/i.test(rel) && /(?:GPU|VIDEO|PCM|OFFLINE-SPEECH|SPEECH-INTERFACE|TRANSCRIBER)/i.test(path.basename(rel)))) selected.add(rel);
    selected.add('package.json');
    selected.add('scripts/record-native-speed-decisions.mjs');
    for (const rel of [...selected].sort()) archive.push(await copyRecord(project, rel, 'records/current-project/' + rel));
    const buildArchive = [], buildRoots = [['.notion-switch/speech/gpu-v1/gpuops-stage', Infinity], ['.notion-switch/speech/gpu-v1/fp16-accum-v1-stage', Infinity], ['.notion-switch/speech/gpu-v1/quality/native30-cache-review', Infinity], ['.notion-switch/speech/gpu-v1/quality/native30-fp16-review', Infinity], ['.notion-switch/speech/gpu-v1/ct2-sm75', 0], ['.notion-switch/speech/gpu-v1/variants/sm75-native-gpuops', 1]];
    for (const [directory, depth] of buildRoots) for (const rel of filesUnder(project, directory, rel => /\.(?:md|json|txt|log|py|cjs|mjs|patch|diff|cc|h|rsp|cmd|def|pristine)$/i.test(rel), depth)) buildArchive.push(await copyRecord(project, rel, 'records/gpuops-build/' + path.relative('.notion-switch/speech/gpu-v1', rel).replaceAll('\\', '/')));
    for (const name of ['GPU-D2D-FAILURE-AUDIT.md', 'GPU-D2D-ENCODER-BRIDGE-FEASIBILITY.md', 'NATIVE-FP16-CACHE-SOURCE-AUDIT.md']) {
      const rel = '.notion-switch/speech/gpu-v1/' + name;
      if (fs.existsSync(project.inside(rel))) buildArchive.push(await copyRecord(project, rel, 'records/gpuops-build/' + name));
    }
    // Freeze the real fault/audit evidence before future application calls can
    // append to the mutable resource logs excluded from the package manifest.
    const runtimeEvidence = [
      ...filesUnder(bundle, 'resources/speech', rel => /(?:worker-failures\.jsonl|native-faults-\d+\.log)$/.test(rel), 0),
      ...filesUnder(bundle, 'resources/speech/gpu-v1/library-audits', rel => rel.endsWith('.json')),
    ];
    for (const rel of runtimeEvidence) buildArchive.push(await copyRecord(bundle, rel,
      'records/gpuops-build/runtime/' + path.relative('resources/speech', rel).replaceAll('\\', '/')));
    // Public writes only; use atomicTarget for the owned temporary filename.
    async function publish(relative, content) {
      const dest = writable(relative); await backup(relative); fs.mkdirSync(path.dirname(dest), { recursive: true });
      const temp = atomicTarget(relative + temporarySuffix); fs.writeFileSync(temp, content, { flag: 'wx', flush: true });
      let failure; for (const delay of [0, 20, 50, 120, 250, 500]) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        try { fs.renameSync(temp, dest); failure = null; break; } catch (error) { failure = error; if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error; }
      }
      if (failure) throw Object.assign(Error('元数据替换失败，临时文件与备份保留：' + relative), { cause: failure });
      journal.push({ file: relative, ...(await digest(dest)) });
    }
    const json = value => JSON.stringify(value, null, 2) + '\n';
    await publish('records/current-project/ARCHIVE.json', json({ version: 1, createdAt: new Date().toISOString(), projectDirectory: project.root, scope: 'selected-source-tests-scripts-docs; not a complete application distribution', credentialsExcludedByPath: true, files: archive }));
    await publish('records/gpuops-build/ARCHIVE.json', json({ version: 1, createdAt: new Date().toISOString(), gpuValidationImpliedByBuildOrAbi: false, files: buildArchive }));
    for (const [src, dest] of [['docs/GPU-OPERATOR-README.md', 'README.md'], ['docs/VIDEO-TRANSCODE.md', 'VIDEO-TRANSCODE.md'], ['docs/PCM-PIPELINE.md', 'PCM-PIPELINE.md'], ['docs/VIDEO-OPTIMIZATION-PLANS.md', 'VIDEO-OPTIMIZATION-PLANS.md'], ['src/speech/file-operator.d.cts', 'operator.d.cts']]) {
      if (fs.existsSync(project.inside(src))) await publish(dest, fs.readFileSync(project.inside(src)));
    }
    const updated = clone(machine);
    for (const name of ['winner', 'native30']) Object.assign(updated.profiles[name], { medianSeconds: board.formalChampion.medianSeconds, oldProjectMedianSeconds: 216.2185, validationFile: 'VALIDATION.json' });
    updated.validation = { ...updated.validation, validationFile: 'VALIDATION.json', recognitionMedianSeconds: board.formalChampion.medianSeconds,
      oldProjectMedianSeconds: 216.2185, timingScope: validation.timingScope, integrationValidationFile: fs.existsSync(bundle.inside('INTEGRATION-VALIDATION.json')) ? 'INTEGRATION-VALIDATION.json' : null,
      videoHardwareValidationFile: machine.videoTranscode?.validationFile || null };
    updated.validation.finalRuntimeCheckFile = 'records/integrations/FINAL-RUNTIME-CHECK.json';
    updated.validation.finalStableRecordingFile = 'tests/recording-2026-11-06T13-04-14-304Z/VERIFICATION.json';
    updated.metadataFinalizedAt = new Date().toISOString();
    await publish('machine.json', json(updated)); await publish('榜单.json', json(board)); await publish('榜单.md', leaderboardMarkdown(board));
    const qualityFile = bundle.inside('QUALITY-AND-LIMITS.md');
    const oldQuality = fs.readFileSync(qualityFile, 'utf8');
    if (!oldQuality.startsWith('# 当前交付质量边界')) await publish('QUALITY-AND-LIMITS.md',
      '# 当前交付质量边界\n\n正式入口仍为Native30，包内双轮中位194.092秒。下方保留早期B2审计原文，其中216.2185秒和201.083205秒门槛为原工程历史值；当前门槛见[榜单](榜单.md)。\n\n本轮whole120/240的疑似缺句与时间越界已单独[逐句复核](experiments/whole-window-content-review/README.md)，没有替换正式版。D2D与动态短编码出现GPU错误，全部失败轮次保留。完整PCM输入、运行零错误和机器参考一致都不等于人工逐字准确率；本包没有人工WER或零漏字保证。\n\n---\n\n' + oldQuality);
    await publish('踩坑记录.md', '# 踩坑记录入口\n\n- [从最快Native30出发的新提速筛选](experiments/native30-speed-search/README.md)\n- [私有FP16完整运行与文字差异](records/gpuops-build/quality/native30-fp16-review/README.md)\n- [两个缓存方案的独立原始链审计](records/gpuops-build/quality/native30-cache-review/README.md)\n- [实际FP16开关与缓存源码核查](records/gpuops-build/NATIVE-FP16-CACHE-SOURCE-AUDIT.md)\n- [120秒稳定修复与保留版本](120秒稳定修复.md)\n- [120秒修复过程与原始GPU结果](experiments/whole120-repair/README.md)\n- [更快clip30方案整片新问题](experiments/whole120-repair/review/clips30-independent-review.md)\n- [本轮全部实验与失败](experiments/实时错题.md)\n- [本轮实验摘要](experiments/SUMMARY.json)\n- [逐句内容复核](experiments/whole-window-content-review/README.md)\n- [D2D失败审计](records/gpuops-build/GPU-D2D-FAILURE-AUDIT.md)\n- [GPUops构建/ABI记录](records/gpuops-build/ARCHIVE.json)\n- [历史完整失败](records/gpu-v1/FAILURES.md)\n- [早期方案](records/gpu-v1/PRIOR-EXPERIMENTS.md)\n- [历史时间线](records/gpu-v1/TIMELINE.md)\n- [历史漏写与边界](QUALITY-AND-LIMITS.md)\n\n最新三项提速候选未超过Native30，全部首轮保存后停止。两个缓存候选精确复现旧稿；真实FP16累加修改虽GPU零错误、五处回归通过，却有22段原始文字差异和新重复/省句，内容待复核。GPU不报错和局部检查都不能代替全文核验。\n\n120秒已证实的问题：长窗VAD删除感谢声段；时间戳seek切进问句中部；固定clip的0.32秒微尾生成不可靠长句。关闭时间戳重新出现Roasted整段漏写，已淘汰。120秒容器内部稳定30秒路径双轮与原稳定稿逐字一致，慢约5.6%仅保留备用。\n\n错误保留原始事件；短测、重复成功或计数gate均不等于逐字内容正确。本次旧入口文件已备份到 `' + version + '`，没有删除任何测试或失败产物。\n');
    const speedSearch = board.candidates.filter(candidate => /^bench-native30-(?:cache|fp16)/.test(candidate.profile));
    await publish('NEXT-OPTIMIZATIONS.md', '# 当前结果与后续边界\n\n正式默认仍为Native30，封装双轮193.326/194.858秒，中位194.092秒；本轮50%目标97.046秒未达到。\n\n120秒漏句修复已经双轮保存为native120-complete，慢约5.6%仅保留备用，不再作为提速主线。当前搜索从最快Native30出发，新的配置首轮整片超过180.50556秒就保存并停止，不为慢版本重复跑第二轮；更快且完整稳定的版本才有晋级资格。\n\n' + speedSearch.map(candidate => `- ${candidate.profile}：${candidate.fullRunSeconds.join(' / ') || '无整片计时'}秒；${candidate.status}。`).join('\n') + '\n\n缓存候选只改变分配缓存；私有FP16候选单独编译四处Whisper累加保护开关，保留attention保护，不是给旧库设置无效flag。原稳定源码、DLL与默认入口均保留。缓存单轮测量与历史基准的差值不等于严格归因；其中compact运行期间还有单CPP编译/链接的CPU活动，未做同期配对性能因果实验，因此只按实测筛选，不声称缓存本身造成这些差值。\n\nwhole120/240旧候选的省句、重复和时间问题，D2D、异步及short失败系列均保留，不取部分耗时或第三轮幸存结果。可选native30-streaming约1.1%的冷任务改善与识别计时分开。\n\n最新各版本结果以 [实验摘要](experiments/SUMMARY.json)、[正式榜单](榜单.json) 为准。没有通过整片内容审查和持续GPU验证的更短时间，不冒充最快可用版本；短测和改开关不能证明50%提速。\n\n源代码/测试/复现脚本索引：[当前工程归档](records/current-project/ARCHIVE.json)；[真实FP16源码与缓存核查](records/gpuops-build/NATIVE-FP16-CACHE-SOURCE-AUDIT.md)；[缓存独立审计](records/gpuops-build/quality/native30-cache-review/README.md)。\n');
    for (const [name, before] of protectedBefore) if ((await digest(bundle.inside(name))).sha256 !== before.sha256) throw Error('稳定受保护文件在归档期间发生变化：' + name);
    if (readJson(bundle.inside('machine.json')).sessionEntryFile !== machine.sessionEntryFile) throw Error('会话快照入口发生变化。');
    await publish(version + '/FINALIZATION.json', json({ version: 1, finalizedAt: new Date().toISOString(), productionPromotion: false,
      protectedFileCount: protectedBefore.size, protectedFilesUnchanged: true, backupDirectory: version, archivedProjectFiles: archive.length, archivedBuildFiles: buildArchive.length, writes: journal }));
    const listed = [], excludedPaths = [];
    async function scan(relative = '') {
      const directory = relative ? bundle.inside(relative) : bundle.root;
      for (const name of fs.readdirSync(directory).sort()) {
        const rel = relative ? relative + '/' + name : name;
        if (excluded(rel)) { excludedPaths.push(rel); continue; }
        const file = bundle.inside(rel), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) throw Error('静态清单不能跟随链接：' + rel);
        if (stat.isDirectory()) await scan(rel);
        else if (stat.isFile()) { listed.push({ file: rel, ...(await digest(file)) }); if (listed.length % 250 === 0) onProgress({ stage: 'manifest', files: listed.length }); }
      }
    }
    await scan();
    const prior = readJson(bundle.inside('PACKAGE-MANIFEST.json'));
    const manifest = { ...prior, version: 2, finalizedAt: new Date().toISOString(), winner: 'winner', backup: 'native30',
      validationFile: 'VALIDATION.json', integrationValidationFile: 'INTEGRATION-VALIDATION.json', formalMedianSeconds: 194.092, fiftyPercentTargetSeconds: 97.046,
      promotionPerformed: false, backupDirectory: version, includesMediaTestArtifacts: true,
      mediaTestArtifactNote: 'Real video/audio test outputs already exist under tests and are retained, not omitted or claimed absent.',
      hashing: 'Streaming SHA256, 1MiB buffers, file-size/mtime checked before and after each file.',
      staticManifestExclusions: exclusions, excludedPaths, files: listed, totalBytes: listed.reduce((sum, item) => sum + item.bytes, 0) };
    delete manifest.originalVideoCopied; delete manifest.mutableDirectoriesExcluded;
    await publish('PACKAGE-MANIFEST.json', json(manifest));
    return { bundleDirectory: bundle.root, backupDirectory: version, manifestFiles: listed.length, staticBytes: manifest.totalBytes,
      includesMediaTestArtifacts: true, productionPromotion: false, stableFilesUnchanged: true };
  } finally {
    // Only our unique lock file; no source/test/cache directory is removed.
    if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bundle' && args[i + 1]) options.bundleDirectory = path.resolve(args[++i]);
    else if (args[i] === '--project' && args[i + 1]) options.projectDirectory = path.resolve(args[++i]);
    else throw Error('用法：node scripts/finalize-unified-operator.mjs [--bundle ABSOLUTE_DIRECTORY] [--project ABSOLUTE_DIRECTORY]');
  }
  console.log(JSON.stringify(await finalizeUnifiedOperator(options), null, 2));
}
