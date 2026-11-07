// Optional-profile admission only. Reads existing GPU evidence; never runs a model.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { inspectFullRun } from './verify-whole120-repair.mjs';
import { checkWhole120Coverage } from './check-whole120-coverage.mjs';

const require = createRequire(import.meta.url);
const { auditRunQuality, JENSEN_REFERENCE } = require('../src/speech/content-window-gate.cjs');
const { writeAtomicJson } = require('../src/speech/atomic-json.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const fileSha = file => sha(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const assert = (condition, message) => { if (!condition) throw Error(message); };
const candidate = 'bench-native120-stable30-v1';
const alias = 'native120-complete';
const revision = '75e7b4ee14daa549252ccc9b4b4e2c75f15f0fe972d66c72dad279e084cb43ca';
const namedIds = ['94-short-clause', '2274-honest-agreement', '2732-full-question', '2790-tail-appreciation', '1470-1500-phone'];
const defaultProofSha = 'e772521b6d78e6ccc83b3a552df70c53056053213d1ed27cc5b46ab08868c68b';

export function validateComplete120Proof(proof, runRoot) {
  assert(proof.status === 'pass' && proof.scope === 'optional-stable-120-second-container-alias-only', 'Independent optional-admission proof has not passed');
  assert(path.resolve(proof.sourceRunRoot) === path.resolve(runRoot) && proof.sourceCandidate === candidate && proof.implementationRevision === revision, 'Independent proof belongs to another candidate/run');
  assert(proof.rounds?.length === 2 && proof.crossRoundWorkersIndependent === true, 'Independent proof needs two different fresh workers');
  for (const round of proof.rounds) assert(round.completeCuda === true && round.fresh === true && round.exactD5 === true && round.fiveNamedPass === true && round.fixed3000 === true &&
    round.canonicalTextSha256 === JENSEN_REFERENCE.textSha256 && round.counts?.totalSamples === JENSEN_REFERENCE.totalSamples &&
    round.counts?.outerRequests === 24 && round.counts?.inner30SecondCalls === 94 && round.counts?.encoderCalls === 217 && round.counts?.lastInnerSamples === 256597,
  'Independent proof is missing full PCM/text/named/fixed-shape evidence');
  assert(proof.independentSourceAudit?.noReferenceTextInjectionFound && proof.independentSourceAudit.originalPcmAndOuterInnerF32HashesVerified &&
    proof.independentSourceAudit.rawGeneratedTextPreserved && proof.independentSourceAudit.frozenImplementationHashesVerified,
  'Independent source/PCM/raw-text audit is incomplete');
  return true;
}

export function inspectStable30Window(row, pcm) {
  const meta = row.result?.completeWindow;
  assert(meta?.mode === 'stable30' && meta.policy === 'stable-gpu-v1-complete-window' && meta.containerSeconds === 120 && meta.sampleRate === 16000 &&
    meta.innerRoute === 'stable-gpu-v1-greedy' && meta.innerChunkSeconds === 30 && meta.innerAcousticMaximumSamples === 320000 &&
    meta.innerAcousticMaximumSeconds === 20 && meta.outerAcousticSubdivision === true && meta.single120SecondAcousticEncode === false,
  'This is not the conservative 120-container -> 30-call -> <=20s acoustic route');
  assert(meta.fullPcmSubmitted === true && [meta.inputSamples, meta.submittedSamples, meta.completedPartSamples, meta.partSamplesSum].every(value => value === row.samples) &&
    meta.inputFloat32Sha256 === row.pcmSha256 && meta.transcribeCalls === meta.parts?.length, 'Container PCM accounting mismatch');
  const floats = Buffer.allocUnsafe(row.samples * 4);
  for (let sample = 0; sample < row.samples; sample++) floats.writeFloatLE(pcm.readInt16LE((row.startSample + sample) * 2) / 32768, sample * 4);
  let at = 0;
  for (const [index, part] of meta.parts.entries()) {
    assert(part.index === index && part.startSample === at && part.endSample === at + part.samples && part.samples > 0 && part.samples <= 480000 &&
      part.inputFloat32Sha256 === sha(floats.subarray(part.startSample * 4, part.endSample * 4)) && typeof part.rawResult?.text === 'string', 'Inner 30s original PCM/raw result mismatch');
    at = part.endSample;
  }
  assert(at === row.samples && meta.lastPartSamples === meta.parts.at(-1).samples, 'Inner calls omitted the tail');
  assert(meta.encoderObservations?.length > 0 && meta.encoderObservations.every(item => item.dtype === 'float32' && JSON.stringify(item.shape) === '[128,3000]'), 'Encoder shape changed from fixed 128x3000');
  return { innerCalls: meta.parts.length, encoderCalls: meta.encoderObservations.length, lastInnerSamples: meta.parts.at(-1).samples };
}

export async function prepareComplete120Admission({ bundle, runRoot, proofFile, proofSha256 = defaultProofSha } = {}) {
  bundle = path.resolve(bundle || 'D:/迅雷下载/notionSwitch/GPU转写算子');
  runRoot = path.resolve(runRoot || path.join(bundle, 'experiments/whole120-repair/full-2026-11-06T14-03-52-369Z'));
  proofFile = path.resolve(proofFile || path.join(import.meta.dirname, '../.notion-switch/speech/gpu-v1/quality/whole120-repair-review/stable30-admission-summary.json'));
  assert(fileSha(proofFile) === proofSha256, 'Independent summary hash changed');
  const proof = read(proofFile); validateComplete120Proof(proof, runRoot);
  assert(fileSha(proof.proof.file) === proof.proof.sha256, 'Independent detailed source proof hash changed');
  const detail = read(proof.proof.file);
  assert(detail.admission?.eligibleForStable120ContainerAlias === true && detail.sourceAudit?.manifestRevisionValid === true && !detail.sourceAudit.manifestFailures?.length,
    'Independent detailed proof does not admit this optional scope');
  const state = read(path.join(runRoot, 'state.json')), machine = read(path.join(bundle, 'machine.json'));
  assert(state.profile === candidate && state.attempts?.length === 2 && state.completedAt && state.active === null, 'Exactly two completed attempts required');
  assert(!machine.profiles[alias], 'Optional alias already exists; refusing to overwrite');
  const source = machine.profiles[candidate];
  assert(source?.implementationRevision === revision && state.candidateIdentity?.value.selected.implementationRevision === revision, 'Frozen implementation revision mismatch');
  for (const file of state.candidateIdentity.value.files) assert(fileSha(path.join(bundle, file.file)) === file.sha256, 'Candidate/operator file changed since verification: ' + file.file);
  const frozen = path.dirname(path.join(bundle, source.entryFile)), manifest = read(path.join(frozen, 'implementation.json'));
  assert(manifest.revision === revision && sha(JSON.stringify(manifest.files.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })))) === revision, 'Frozen implementation manifest revision invalid');
  for (const file of manifest.files) assert(path.basename(file.file) === file.file && fs.statSync(path.join(frozen, file.file)).size === file.bytes && fileSha(path.join(frozen, file.file)) === file.sha256,
    'Frozen source changed: ' + file.file);
  const plan = read(path.join(bundle, source.planFile));
  const required = { computeType: 'float16', allocator: 'cub_caching', fp16Gemm: false, chunkSeconds: 120, resetEveryChunks: 0,
    runtimeVariant: 'sm75-native', launchBlocking: true, beamSize: 1, languageOverride: 'en', batchSize: 1, batchClipSeconds: 0,
    encoderMicrobatchSize: 0, timestampedBatch: false, nativeWholeWindow: true, gpuEncoderBridge: false, shortEncoder: false, windowMode: 'stable30' };
  for (const [key, value] of Object.entries(required)) assert(plan[key] === value, 'Unexpected frozen 120 plan: ' + key);
  assert(fileSha(path.join(bundle, machine.resourcesRoot, 'speech/gpu-v1/variants/sm75-native/READY.json')) === plan.runtimeRevision, 'Native runtime READY hash mismatch');
  const referenceDirectory = path.join(bundle, 'validation/round-1'), referenceText = read(path.join(referenceDirectory, 'result.json')).text;
  const rounds = [];
  for (const [index, attempt] of state.attempts.entries()) {
    assert(attempt.round === index + 1 && attempt.profile === candidate && attempt.phase === 'full' && attempt.complete && !attempt.hardFailure && !attempt.hardFailureReasons.length, 'Attempt list includes a failure or survivor selection');
    const directory = path.resolve(attempt.directory);
    assert(directory === path.join(runRoot, `${candidate}-round-${index + 1}`), 'Unexpected attempt directory');
    const audit = await auditRunQuality({ referenceDirectory, candidateDirectory: directory });
    const input = inspectFullRun({ directory, referenceText });
    const coverage = checkWhole120Coverage({ directory });
    assert(audit.status === 'pass' && audit.runtimeStatus === 'pass' && audit.runtime.fresh && audit.runtime.errors === 0 && audit.runtime.recoveries === 0 && audit.runtime.nativeExits === 0 &&
      !audit.identityIssues.length && !input.inputIssues.length && !input.runtimeIssues.length && input.workerPids.length === 1 && input.v1ExactTextEquality && input.canonicalTextSha256 === JENSEN_REFERENCE.textSha256,
    'Full-audio runtime/PCM/canonical-text admission failed');
    assert(coverage.status === 'PASS_NAMED_ANCHORS_ONLY' && coverage.evaluatedChecks === 5 && !coverage.failedChecks.length && namedIds.every(id => coverage.checks.some(check => check.id === id && check.status === 'PASS')), 'Named-five gate not passed');
    const pcm = fs.readFileSync(path.join(directory, 'audio.s16le'));
    const rows = fs.readFileSync(path.join(directory, 'raw-results.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(row => row.event === 'result');
    let innerCalls = 0, encoderCalls = 0, lastInnerSamples;
    for (const row of rows) { const inspected = inspectStable30Window(row, pcm); innerCalls += inspected.innerCalls; encoderCalls += inspected.encoderCalls; lastInnerSamples = inspected.lastInnerSamples; }
    assert(rows.length === 24 && innerCalls === 94 && encoderCalls === 217 && lastInnerSamples === 256597, 'Recorded fixed-shape or tail counts changed');
    const original = proof.rounds[index];
    assert(path.resolve(original.directory) === directory && original.workerPids.length === 1 && original.workerPids[0] === input.workerPids[0] && original.seconds === audit.runtime.recognitionSeconds, 'Independent proof disagrees with raw attempt');
    const artifacts = ['result.json', 'checkpoint.json', 'raw-results.jsonl', 'named-coverage.json', 'quality-report.json', 'transcript.txt', 'audio.s16le', 'audio-source.json']
      .map(file => ({ file: path.relative(bundle, path.join(directory, file)).replaceAll('\\', '/'), sha256: fileSha(path.join(directory, file)) }));
    rounds.push({ round: index + 1, directory: path.relative(bundle, directory).replaceAll('\\', '/'), seconds: audit.runtime.recognitionSeconds,
      workerPid: input.workerPids[0], fresh: true, errors: 0, recoveries: 0, nativeExits: 0,
      totalSamples: input.totalSamples, inputPcmSha256: input.inputPcmSha256, canonicalTextSha256: input.canonicalTextSha256,
      v1ExactTextEquality: true, namedFive: 'PASS_NAMED_ANCHORS_ONLY', outerRequests: rows.length, inner30SecondCalls: innerCalls,
      encoderCalls, encoderFeatureShape: [128, 3000], lastInnerSamples, artifacts });
  }
  assert(rounds[0].workerPid !== rounds[1].workerPid, 'Rounds reused the actual CUDA worker');
  const seconds = rounds.map(round => round.seconds), medianSeconds = (seconds[0] + seconds[1]) / 2, baselineMedianSeconds = 194.092;
  assert(Math.abs(medianSeconds - 204.9925) < 1e-7, 'Unexpected preserved candidate timing');
  const reductionVsNative30 = 1 - medianSeconds / baselineMedianSeconds;
  const protectedFiles = ['machine.json', '榜单.json', '榜单.md', 'README.md', 'PACKAGE-MANIFEST.json', 'operator.cjs', 'VALIDATION.json', 'profiles/winner.json', 'profiles/native30.json', '逐字稿.txt'];
  const before = protectedFiles.map(file => ({ file, sha256: fileSha(path.join(bundle, file)) }));
  const metadata = { ...source, experimental: false, status: 'validated-optional', sourceCandidate: candidate,
    validationFile: 'COMPLETE120-VALIDATION.json', medianSeconds, reductionVsNative30, defaultProfile: false,
    retainedDespiteSlower: true, qualityBeforeSpeed: true, transportSeconds: 120, innerCallMaximumSeconds: 30,
    acousticMaximumSeconds: 20, encoderFrames: 3000,
    note: '用户明确：慢约5.6%也保留。120秒是传输容器，内部4x30秒顺序调用原<=20秒声学分段；GPU FP16/sync/3000，非单次120秒attention。默认winner/native30不变。' };
  return { bundle, runRoot, proofFile, proofSha256, proof, state, machine, source, rounds, medianSeconds, reductionVsNative30, before, metadata,
    validation: { version: 1, admittedAt: new Date().toISOString(), profile: alias, status: 'validated-optional', sourceCandidate: candidate,
      implementationRevision: revision, entryFile: source.entryFile, planFile: source.planFile,
      automaticPromotion: false, defaultWinnerChanged: false, retainedDespiteSlower: true, qualityBeforeSpeed: true,
      twoRunSeconds: seconds, medianSeconds, baselineMedianSeconds, reductionVsNative30, minimumSpeedPromotion: .07, speedPromotionQualified: false,
      timingScope: 'raw start-to-complete after engine ready; excludes verified PCM preparation/model load/audits/queue',
      inputPreparation: 'verified-existing-pcm-cache', totalSamples: JENSEN_REFERENCE.totalSamples, durationSeconds: JENSEN_REFERENCE.totalSamples / 16000,
      canonicalTextSha256: JENSEN_REFERENCE.textSha256, inputPcmSha256: JENSEN_REFERENCE.pcmSha256,
      route: { transportSeconds: 120, maximumSequentialInnerCalls: 4, innerCallMaximumSeconds: 30, acousticMaximumSeconds: 20,
        single120SecondAttention: false, encoderFeatureShape: [128, 3000], computeType: 'float16', device: 'cuda', launchBlocking: true, batchSize: 1, beamSize: 1 },
      independentProof: { summaryFile: 'validation/native120-complete/independent-summary.json', summarySha256: proofSha256,
        detailFile: 'validation/native120-complete/independent-source-audit.json', detailSha256: proof.proof.sha256 },
      transcriptPreservation: { source: path.relative(bundle, path.join(runRoot, `${candidate}-round-2/transcript.txt`)).replaceAll('\\', '/'),
        target: '逐字稿-native120-complete.txt', sourceFileSha256: fileSha(path.join(runRoot, `${candidate}-round-2/transcript.txt`)),
        provenance: 'Copy newly GPU-generated round-2 transcript.txt. No reference transcript is inserted into candidate or substituted for it.' },
      rounds, limitations: proof.limitations } };
}

export async function commitComplete120Admission(prepared) {
  const { bundle, metadata, validation, before, proofFile, proof, runRoot, medianSeconds, reductionVsNative30 } = prepared;
  for (const item of before) assert(fileSha(path.join(bundle, item.file)) === item.sha256, 'Concurrent package change: ' + item.file);
  for (const file of ['COMPLETE120-VALIDATION.json', '120秒稳定修复.md', '逐字稿-native120-complete.txt']) assert(!fs.existsSync(path.join(bundle, file)), 'Refusing to overwrite existing saved optional version: ' + file);
  const version = path.join(bundle, 'versions', 'before-native120-complete-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(version, { recursive: true });
  for (const item of before) { const target = path.join(version, item.file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(bundle, item.file), target, fs.constants.COPYFILE_EXCL); }
  const machine = read(path.join(bundle, 'machine.json')), originalWinner = JSON.stringify(machine.profiles.winner), originalNative30 = JSON.stringify(machine.profiles.native30);
  const board = read(path.join(bundle, '榜单.json')), originalChampion = JSON.stringify(board.formalChampion);
  machine.profiles[alias] = metadata;
  board.updatedAt = new Date().toISOString();
  board.candidates ||= []; board.candidates.push({ profile: alias, evidenceProfile: candidate, status: 'validated-optional', productionDefault: false,
    promotedByThisFinalizer: false, experimental: false, implementationRevision: revision, entryFile: metadata.entryFile,
    fullRunSeconds: validation.twoRunSeconds, measuredMedianSeconds: medianSeconds, reductionVersusPackagedBaseline: reductionVsNative30,
    validFullRuns: 2, validationFile: 'COMPLETE120-VALIDATION.json', retainedDespiteSlower: true,
    reviewReason: '两轮原PCM/完整d5/五项具名/固定3000/独立worker通过；慢约5.6%仍按用户要求保留，不替换winner/native30。' });
  assert(JSON.stringify(machine.profiles.winner) === originalWinner && JSON.stringify(machine.profiles.native30) === originalNative30 && JSON.stringify(board.formalChampion) === originalChampion, 'Default profile changed');
  const proofDirectory = path.join(bundle, 'validation/native120-complete'); fs.mkdirSync(proofDirectory, { recursive: true });
  fs.copyFileSync(proofFile, path.join(proofDirectory, 'independent-summary.json'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(proof.proof.file, path.join(proofDirectory, 'independent-source-audit.json'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(path.join(bundle, validation.transcriptPreservation.source), path.join(bundle, validation.transcriptPreservation.target), fs.constants.COPYFILE_EXCL);
  assert(fileSha(path.join(bundle, validation.transcriptPreservation.target)) === validation.transcriptPreservation.sourceFileSha256, 'New round-2 transcript copy mismatch');
  const md = `# 120秒稳定修复：慢5.6%也保留\n\n可选调用名：\`native120-complete\`；状态 \`validated-optional\`，无需实验开关。用户明确要求“5.6的也保留”，因此按质量优先独立封存，**默认 winner/native30 未改变**。\n\n本方案是120秒传输容器，每容器最多4次30秒顺序调用，内部继续使用原最大20秒声学分段及VAD/RMS；不是单次120秒attention，也没有缩短encoder。Native CUDA13/sm75、GPU FP16、同步、batch1/greedy1，实际记录每次encoder特征128×3000。\n\n两轮完整采访分别 **208.627 / 201.358秒**，中位 **204.9925秒**；相对Native30的194.092秒慢约5.6%（耗时增加${(-reductionVsNative30 * 100).toFixed(4)}%）。未达到7%提速门槛，更未宣称再快50%。计时仅原始start→complete，排除PCM缓存准备、载模、排队与复核。\n\n每轮24个外请求、94次内部30秒调用、217次固定3000帧encoder、44,896,597输入样本、2806.0373125秒；实际worker分别52440/38408且每轮只一个，零错误/恢复/退出、resumedChunks=0。末尾256,597样本保留。两轮新GPU返回全文UTF8 SHA均为\`${JENSEN_REFERENCE.textSha256}\`，与V1机器参考逐字相同；原PCM SHA为\`${JENSEN_REFERENCE.pcmSha256}\`。94秒短句、2274秒同意句、2732秒问句、2790秒感谢和1470–1500秒电话五项回归门均通过。\n\n源码冻结：\`${revision}\`，sourceCandidate=\`${candidate}\`。原始两轮目录：\`${path.relative(bundle, runRoot).replaceAll('\\', '/')}\`；完整文件哈希、独立来源复核与精确计数见 [COMPLETE120-VALIDATION.json](COMPLETE120-VALIDATION.json)。\n\n新保存的 [逐字稿-native120-complete.txt](逐字稿-native120-complete.txt) **直接复制本次新GPU第2轮 transcript.txt**，来源与文件SHA均记录；没有拿旧V1稿给候选补字，也没有覆盖原根目录逐字稿.txt。参考稿仅用于GPU返回后的比较。\n\n\`\`\`javascript\nconst operator = require('D:/迅雷下载/notionSwitch/GPU转写算子');\n(async () => {\n  const result = await operator.transcribeFile({\n    source: 'D:/视频.webm', outputDirectory: 'D:/120秒独立结果',\n    language: 'en', profile: 'native120-complete',\n  });\n  console.log(result.transcriptFile);\n})().catch(error => { console.error(error.message); process.exitCode = 1; });\n\`\`\`\n\n验收限本机这条英语采访与此冻结配置。V1仍是机器稿，不是人工WER或零漏字保证；whole30-only争议短句（包括2684秒问句）未因此裁决。继承的VAD/RMS、声学段及生成时间戳限制仍在；固定shape与软件库记录不是GPU内核profiler证据，不能宣称全部硬件/驱动原因已修复。独立proof完整限制随验证JSON保留。\n`;
  fs.writeFileSync(path.join(bundle, '120秒稳定修复.md'), md, { encoding: 'utf8', flag: 'wx' });
  await writeAtomicJson(path.join(bundle, 'COMPLETE120-VALIDATION.json'), validation);
  await writeAtomicJson(path.join(bundle, '榜单.json'), board);
  fs.appendFileSync(path.join(bundle, '榜单.md'), '\n## 按用户要求保留的120秒稳定修复（非默认）\n\n| 可选方案 | 状态 | 两轮秒 | 中位秒 | 对比Native30 |\n| --- | --- | --- | --- | --- |\n| native120-complete | validated-optional | 208.627 / 201.358 | 204.9925 | 慢约5.6%，质量优先保留 |\n\n原PCM、全文d5、五项具名回归、固定3000与独立真实worker双轮通过；未作速度晋级，不改变winner/native30。详见 [120秒稳定修复](120秒稳定修复.md) 与 [验收](COMPLETE120-VALIDATION.json)。\n', 'utf8');
  fs.appendFileSync(path.join(bundle, 'README.md'), '\n## 保留的120秒稳定修复\n\n`profile:\'native120-complete\'` 是已通过严格双轮与独立来源复核的可选方案，`experimental:false`，无需 `allowExperimental`。120秒是容器，内部最多4×30秒顺序调用原最大20秒声学路径，仍为GPU FP16/sync/3000；不是120秒attention。两轮208.627/201.358秒，中位204.9925秒，比Native30慢约5.6%，按用户要求质量优先保留，默认winner/native30不变。见 [120秒稳定修复](120秒稳定修复.md)、[验收](COMPLETE120-VALIDATION.json) 和来自新GPU第2轮的 [独立逐字稿](逐字稿-native120-complete.txt)。\n', 'utf8');
  // Alias is published last, only after proof, original output copy and validation exist.
  await writeAtomicJson(path.join(bundle, 'machine.json'), machine);
  for (const file of ['PACKAGE-MANIFEST.json', 'operator.cjs', 'VALIDATION.json', 'profiles/winner.json', 'profiles/native30.json', '逐字稿.txt']) assert(fileSha(path.join(bundle, file)) === before.find(item => item.file === file).sha256, 'Protected original file changed: ' + file);
  const published = read(path.join(bundle, 'machine.json'));
  assert(JSON.stringify(published.profiles.winner) === originalWinner && JSON.stringify(published.profiles.native30) === originalNative30 && published.profiles[alias].experimental === false, 'Published alias/default mismatch');
  await writeAtomicJson(path.join(version, 'admission-receipt.json'), { admittedAt: new Date().toISOString(), alias, sourceCandidate: candidate,
    backupDirectory: version, protectedBefore: before, manifestRehashed: false, defaultWinnerChanged: false,
    newFiles: ['COMPLETE120-VALIDATION.json', '120秒稳定修复.md', validation.transcriptPreservation.target].map(file => ({ file, sha256: fileSha(path.join(bundle, file)) })),
    modifiedMetadata: ['machine.json', 'README.md', '榜单.json', '榜单.md'].map(file => ({ file, sha256: fileSha(path.join(bundle, file)) })) });
  return { alias, status: 'validated-optional', medianSeconds, reductionVsNative30, backupDirectory: version, defaultWinnerChanged: false, manifestRehashed: false };
}

async function main() {
  const args = process.argv.slice(2), options = {}; let commit = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--commit') commit = true;
    else if (['--bundle', '--run-root', '--proof', '--proof-sha'].includes(args[index]) && args[index + 1]) {
      const key = { '--bundle': 'bundle', '--run-root': 'runRoot', '--proof': 'proofFile', '--proof-sha': 'proofSha256' }[args[index]]; options[key] = args[++index];
    } else throw Error('Usage: node scripts/admit-complete120.mjs [--bundle BUNDLE] [--proof JSON --proof-sha SHA] [--commit]');
  }
  const prepared = await prepareComplete120Admission(options);
  console.log(JSON.stringify(commit ? await commitComplete120Admission(prepared) : { ready: true, noBundleWrites: true, alias, medianSeconds: prepared.medianSeconds,
    reductionVsNative30: prepared.reductionVsNative30, proof: prepared.proofFile }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
