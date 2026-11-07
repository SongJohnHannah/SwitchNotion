import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const target = path.resolve(process.argv[2] || 'D:/迅雷下载/notionSwitch/GPU转写算子');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = data => createHash('sha256').update(data).digest('hex');
const fileSha = file => {
  const hash = createHash('sha256'), buffer = Buffer.alloc(8 * 1024 * 1024), fd = fs.openSync(file, 'r');
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
};
const check = (value, message) => { if (!value) throw Error(message); };
const inside = file => { const rel = path.relative(target, path.resolve(file)); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
check(fs.existsSync(path.join(target, 'PACKAGE-MANIFEST.json')), '缺少导出清单。');
const expectedTextSha = 'd5e26d3b8a829eb19573809dd8c3b2eb5f6e94182ee2057a12115c184a68d113';
const expectedPcmSha = 'c42d69c8317656aae25a3edbd9ee8c9df402b07c89bbad4b2ce195a92e7e93bd';
const rounds = [];
for (const number of [1, 2]) {
  const directory = path.join(target, 'validation', 'round-' + number);
  const result = read(path.join(directory, 'result.json')), checkpoint = read(path.join(directory, 'checkpoint.json'));
  const events = fs.readFileSync(path.join(directory, 'raw-results.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const starts = events.filter(row => row.event === 'start'), completes = events.filter(row => row.event === 'complete');
  const outputs = events.filter(row => row.event === 'result');
  check(result.complete === true && result.device === 'cuda' && result.recoveries === 0 && result.nativeExits === 0, '封装运行不完整或发生恢复/退出。');
  check(result.totalSamples === 44896597 && checkpoint.parts.length === 94, '封装运行样本或段数不符。');
  check(starts.length === 1 && completes.length === 1 && starts[0].resumedChunks === 0, '不是独立的新目录完整执行。');
  check(outputs.length === 94 && !events.some(row => ['error', 'failed'].includes(row.event)), '原始返回存在缺段或错误。');
  check(result.transcriptSha256 === expectedTextSha && sha(result.text) === expectedTextSha, '逐字稿与已验证的完整Native30结果不一致，需要复核。');
  check(fs.readFileSync(path.join(directory, 'transcript.txt'), 'utf8') === result.text + '\n', '逐字稿文件与结果不一致。');
  check(fileSha(path.join(directory, 'audio.s16le')) === expectedPcmSha, '解码音轨与原验证音轨不一致。');
  let at = 0;
  for (const [index, part] of checkpoint.parts.entries()) {
    check(part.index === index && part.startSample === at && part.device === 'cuda', '检查点边界或设备不一致。');
    at += part.samples;
  }
  check(at === result.totalSamples, '检查点未覆盖全部样本。');
  const workers = [...new Set(outputs.map(row => row.workerPid))];
  check(workers.length === 1 && Number.isInteger(workers[0]), '单次运行没有维持同一真实工作进程。');
  const auditFile = path.join(target, 'resources/speech/gpu-v1/library-audits', workers[0] + '.json');
  const audit = read(auditFile);
  check(inside(audit.ctranslate2Package), 'CTranslate2包仍引用交付目录外的文件。');
  const userLibraries = audit.libraries.filter(item => /^(?:cublas|cudnn|cudart|ctranslate|_ext\.)/i.test(item.name));
  check(userLibraries.some(item => /^cublas64_13\.dll$/i.test(item.name)), '未审计到CUDA13 cuBLAS。');
  check(userLibraries.every(item => inside(item.path)), 'GPU用户态库仍引用交付目录之外。');
  fs.copyFileSync(auditFile, path.join(target, 'validation', 'round-' + number + '.library-audit.json'));
  rounds.push({ round: number, complete: true, totalSamples: result.totalSamples, duration: result.duration,
    device: result.device, workerPid: workers[0], start: starts[0].at, end: completes[0].at,
    recognitionSeconds: (Date.parse(completes[0].at) - Date.parse(starts[0].at)) / 1000,
    errors: 0, transcriptSha256: result.transcriptSha256, pcm16Sha256: expectedPcmSha,
    outputDirectory: 'validation/round-' + number });
}
check(Date.parse(rounds[1].start) >= Date.parse(rounds[0].end), '两次GPU识别时间重叠，排队验证失败。');
const waiting = fs.readFileSync(path.join(target, 'validation/round-2.stdout.log'), 'utf8').split('\n').some(line => {
  try { return JSON.parse(line).stage === 'waiting-gpu'; } catch { return false; }
});
check(waiting, '没有观察到跨进程GPU排队。');
const validation = { version: 1, verifiedAt: new Date().toISOString(), packagedEntryGpuValidated: true,
  independentFullRuns: 2, cooperativeCrossProcessQueueVerified: true,
  source: 'Jensen Huang interview S7CrlFLAmEA', language: 'en', expectedTextSha, expectedPcmSha,
  timingScope: 'engine-ready-to-final-transcript, excluding preparation/model loading/queue wait',
  recognitionMedianSeconds: (rounds[0].recognitionSeconds + rounds[1].recognitionSeconds) / 2, rounds,
  comparison: { previousVerifiedMedianSeconds: 216.2185,
    reduction: 1 - (rounds[0].recognitionSeconds + rounds[1].recognitionSeconds) / 2 / 216.2185,
    sameExactDecodedPcmVerified: true, note: '记录独立封装版本实测，不把运行环境变化的耗时差异断言为某个数学算子的因果提速。' },
  qualityScope: '全音轨完整输入、四轮Native30一致（原工程两轮+搬迁包两轮），已复核B2漏段窗口；未提供人工WER或零漏字保证。' };
fs.writeFileSync(path.join(target, 'VALIDATION.json'), JSON.stringify(validation, null, 2) + '\n');
fs.copyFileSync(path.join(target, 'validation/round-1/transcript.txt'), path.join(target, '逐字稿.txt'));
const machineFile = path.join(target, 'machine.json'), machine = read(machineFile);
machine.validation = { ...machine.validation, latestPackagedEntryRequiresFullVideoValidation: false,
  packagedEntryGpuValidated: true, validationFile: 'VALIDATION.json' };
fs.writeFileSync(machineFile, JSON.stringify(machine, null, 2) + '\n');
fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'local-gpu-transcription-operator', version: '1.0.0',
  private: true, type: 'commonjs', main: './operator.cjs', types: './operator.d.cts',
  exports: { '.': { types: './operator.d.cts', require: './operator.cjs', default: './operator.cjs' } }, engines: { node: '>=22' } }, null, 2) + '\n');
fs.writeFileSync(path.join(target, 'operator.d.cts'), `import type { transcribeGpuFile } from './module/src/speech-provider.cjs';
export interface TranscribeFileOptions {
  source: string; outputDirectory?: string; profile?: 'winner' | 'native30'; language?: 'en' | 'zh' | 'auto';
  signal?: AbortSignal; onProgress?: (event: {stage: string; plan: string; index?: number; totalChunks?: number; seconds?: number; totalSeconds?: number; ownerPid?: number}) => void;
}
export function transcribeFile(options: TranscribeFileOptions): ReturnType<typeof transcribeGpuFile>;
export function describe(): Record<string, unknown>;
`);
fs.writeFileSync(path.join(target, '榜单.md'), fs.readFileSync(path.join(target, 'records/gpu-v1/LEADERBOARD.md'), 'utf8')
  + `\n包内入口搬迁复验：${rounds.map(round => round.recognitionSeconds.toFixed(3)).join(' / ')}秒，中位${validation.recognitionMedianSeconds.toFixed(3)}秒，较原Native30两轮中位耗时下降${(validation.comparison.reduction * 100).toFixed(2)}%。两轮均与原Native30音频及文本哈希一致。详见 VALIDATION.json；保留旧榜计时，不用后续轮次择优替换。该版本单列封装实测，未据此断言某一算子的因果改进。\n`);
fs.writeFileSync(path.join(target, '榜单.json'), JSON.stringify({
  version: 1, updatedAt: validation.verifiedAt, benchmarkPcm16Sha256: expectedPcmSha,
  historicalLeaderboard: 'records/gpu-v1/leaderboard.json',
  packagedVersion: { id: 'native30-standalone-v1', status: 'independent-full-video-twice',
    twoRunSeconds: rounds.map(round => round.recognitionSeconds), medianSeconds: validation.recognitionMedianSeconds,
    comparison: validation.comparison, validationFile: 'VALIDATION.json' },
  speedOnlyB2Status: 'content-review-needed', nextRequiredReduction: 0.07,
  nextThresholdSeconds: Math.min(216.2185, validation.recognitionMedianSeconds) * 0.93,
}, null, 2) + '\n');
fs.writeFileSync(path.join(target, '踩坑记录.md'), '# 踩坑记录入口\n\n'
  + '- 完整试错记录：[FAILURES.md](records/gpu-v1/FAILURES.md)\n'
  + '- 早期尝试：[PRIOR-EXPERIMENTS.md](records/gpu-v1/PRIOR-EXPERIMENTS.md)\n'
  + '- 运行时间线：[TIMELINE.md](records/gpu-v1/TIMELINE.md)\n'
  + '- 漏写与限制：[QUALITY-AND-LIMITS.md](QUALITY-AND-LIMITS.md)\n'
  + '- 下一步：[NEXT-OPTIMIZATIONS.md](NEXT-OPTIMIZATIONS.md)\n'
  + '- 每轮原始结果、检查点、错误和源码哈希：records/gpu-v1/runs 与 implementations\n'
  + '- 原文件到包内路径的索引：records/RECORD-INDEX.json\n');
const readmeFile = path.join(target, 'README.md');
let readme = fs.readFileSync(readmeFile, 'utf8');
readme = readme.replace('最终包入口尚待根任务整段验收', '最终包入口已在此目录独立整片验收两轮，见 VALIDATION.json')
  .replace('备用入口需要搬迁后验收', '搬迁后的Native30入口已通过两轮整片验收');
readme += `\n## 交付验收\n\n包内入口两轮识别阶段耗时：${rounds.map(round => round.recognitionSeconds.toFixed(3)).join(' / ')}秒；两轮均覆盖44,896,597样本、94段、零错误，文本哈希与原Native30两轮完全一致。两个独立调用已实际验证排队。winner/native30是同一方案的入口别名。\n\n104秒B2曾有24:30–25:00漏写嫌疑，已标内容待复核；它的性能记录不作为可用逐字稿资格。全部历史榜单见 [榜单.md](榜单.md)，试错入口见 [踩坑记录.md](踩坑记录.md)。\n\n其他项目可直接调用：\n\n\`\`\`js\nconst { transcribeFile } = require('${target.replaceAll('\\', '/')}');\nconst result = await transcribeFile({ source: '音视频绝对路径', outputDirectory: '输出目录绝对路径', language: 'en' });\nconsole.log(result.transcriptFile);\n\`\`\`\n\n同时调用的项目必须引用同一份operator.cjs/资源目录才能共用GPU队列。CPU承担文件解码与前处理，语音模型仅使用CUDA，无CPU识别回退。\n`;
fs.writeFileSync(readmeFile, readme);
const nextFile = path.join(target, 'NEXT-OPTIMIZATIONS.md');
if (fs.existsSync(nextFile)) fs.writeFileSync(nextFile, fs.readFileSync(nextFile, 'utf8')
  .replace('当前 Native30 基线为 216.2185 秒，下一次晋级门槛为 **201.083205 秒**',
    `当前独立封装Native30版本两轮中位为 ${validation.recognitionMedianSeconds.toFixed(3)} 秒，下一次同口径晋级门槛为 **${(Math.min(216.2185, validation.recognitionMedianSeconds) * 0.93).toFixed(6)} 秒**（旧工程216.2185秒记录保留）`));
const manifestFile = path.join(target, 'PACKAGE-MANIFEST.json'), previous = read(manifestFile), files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), relative = path.relative(target, file).replaceAll('\\', '/');
    if (relative === 'PACKAGE-MANIFEST.json' || /(?:^|\/)__pycache__(?:\/|$)|\.pyc$/.test(relative)
        || /^(?:outputs\/|resources\/speech\/(?:gpu-leases|cuda-cache|gpu-v1\/library-audits)\/)/.test(relative)) continue;
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) files.push({ file: relative, bytes: fs.statSync(file).size, sha256: fileSha(file) });
    else throw Error('交付目录出现未预期的链接：' + relative);
  }
}
walk(target);
fs.writeFileSync(manifestFile, JSON.stringify({ ...previous, finalizedAt: new Date().toISOString(),
  packagedEntryGpuValidated: true, validationFile: 'VALIDATION.json', files,
  totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  mutableDirectoriesExcluded: ['outputs', '**/__pycache__', 'resources/speech/gpu-leases', 'resources/speech/cuda-cache', 'resources/speech/gpu-v1/library-audits'] }, null, 2) + '\n');
console.log(JSON.stringify({ directory: target, ...validation, files: files.length }, null, 2));
