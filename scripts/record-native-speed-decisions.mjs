import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Record measured results only. Never starts inference, edits a plan or promotes.
const bundle = path.resolve(process.argv[2] || 'D:/迅雷下载/notionSwitch/GPU转写算子');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const definitions = [
  ['bench-native30-cache1g-v1', 'full-2026-11-06T14-43-02-077Z', 196.604],
  ['bench-native30-cachecompact-v1', 'full-2026-11-06T14-55-37-935Z', 214.086],
  ['bench-native30-fp16-accum-v1', 'full-2026-11-06T15-01-45-191Z', 240.372],
];
const machineFile = path.join(bundle, 'machine.json'), machine = read(machineFile);
const originals = ['operator.cjs', 'profiles/winner.json', 'profiles/native30.json', 'resources/speech/gpu-v1/variants/sm75-native/ctranslate2/ctranslate2.dll']
  .map(file => ({ file, sha256: sha(path.join(bundle, file)) }));
if (originals.at(-1).sha256 !== '9dfdd201fc6769c611a6ba595d53489cf2f05833ac2940d02f29670b5320a20f') throw Error('Original stable DLL changed');
const defaultBefore = JSON.stringify([machine.profiles.winner, machine.profiles.native30]);
const attempts = definitions.map(([profile, run, seconds]) => {
  const stateFile = `experiments/whole120-repair/${run}/state.json`, state = read(path.join(bundle, stateFile));
  const attempt = state.attempts?.[0];
  if (!state.completedAt || state.active || state.profile !== profile || state.attempts.length !== 1 ||
      !state.speedStop || state.speedStopReason !== 'below7%' || attempt.hardFailure || !attempt.complete ||
      attempt.report?.runtime?.recognitionSeconds !== seconds) throw Error('Speed-screen evidence mismatch: ' + profile);
  const selected = machine.profiles[profile], before = { ...selected };
  if (sha(path.join(bundle, selected.planFile)) !== state.candidateIdentity.value.files.find(item => item.file === selected.planFile)?.sha256 ||
      sha(path.join(bundle, selected.entryFile)) !== state.candidateIdentity.value.files.find(item => item.file === selected.entryFile)?.sha256) throw Error('Frozen plan or entry changed');
  Object.assign(selected, { status: profile.includes('fp16') ? 'content-review-needed' : 'speed-screened-out',
    reviewReason: `${seconds}秒，首轮整片未达到180.50556秒提速门槛，停止追加同方案；${attempt.v1ExactTextEquality ? '原文精确复现稳定机器参考；只有一轮，不认定双轮稳定。' : '全文不同于稳定机器参考，内容待复核；零GPU错误不代表内容正确。'}`,
    speedDecisionFile: 'experiments/native30-speed-search/DECISIONS.json',
    ...(profile.includes('fp16') ? { reviewFile: 'records/gpuops-build/quality/native30-fp16-review/README.md' } : {}) });
  return { profile, stateFile, seconds, reductionVs194092: 1 - seconds / 194.092,
    canonicalTextSha256: attempt.canonicalTextSha256, referenceExact: attempt.v1ExactTextEquality,
    namedCoverage: attempt.report.namedCoverage?.status || null, hardFailure: false, freshFullRuns: 1,
    speedStop: true, speedStopReason: 'below7%', before, after: selected };
});
if (JSON.stringify([machine.profiles.winner, machine.profiles.native30]) !== defaultBefore) throw Error('Do not change production profiles');
const directory = path.join(bundle, 'experiments/native30-speed-search');
fs.mkdirSync(directory, { recursive: true });
if (fs.existsSync(path.join(directory, 'DECISIONS.json'))) throw Error('Do not overwrite a prior speed decision');
const backup = path.join(bundle, 'versions', 'before-native-speed-decisions-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(backup); fs.copyFileSync(machineFile, path.join(backup, 'machine.json'), fs.constants.COPYFILE_EXCL);
write(path.join(directory, 'DECISIONS.json'), { version: 1, decidedAt: new Date().toISOString(), attempts,
  formalBest: { profile: 'winner/native30', seconds: [193.326, 194.858], medianSeconds: 194.092 },
  preservedOptional: 'native120-complete', preservedOptionalMedianSeconds: 204.9925,
  defaultUnchanged: true, promotionPerformed: false, noCpuAsr: true, baselineFiles: originals,
  comparisonScope: 'Historical baseline speed screen, not contemporaneous paired causal attribution. Compact run overlapped one BelowNormal C++ compile/link. All raw attempts retained.' });
fs.writeFileSync(machineFile + '.tmp', JSON.stringify(machine, null, 2) + '\n'); fs.renameSync(machineFile + '.tmp', machineFile);
for (const item of originals) if (sha(path.join(bundle, item.file)) !== item.sha256) throw Error('Protected stable file changed');
fs.writeFileSync(path.join(directory, 'README.md'), '# Native30提速筛选记录\n\n当前最快合格版仍为Native30：单轮最快193.326秒，双轮中位194.092秒，对应2806.0373125秒原采访。慢5.6%的native120-complete保留备用，不作为提速测试主线。\n\n| 新方案 | 整片GPU耗时 | 决定 |\n| --- | ---: | --- |\n' + attempts.map(item => `| ${item.profile} | ${item.seconds}秒 | 首轮未达7%，停止；${item.referenceExact ? '全文同原参考' : '全文有差异，内容待复核'} |`).join('\n') + '\n\n三项均无GPU硬错误，但都只有一轮整片，不标为双轮稳定。原始结果与样本保存在各stateFile指向的目录，未用参考文字修补输出，未挑幸存轮。FP16另有一次同源90秒canary（8.295秒），短测不冒充整片验收。\n\n缓存影响分配策略；私有FP16库修改四处Whisper累加保护开关并保留attention保护，原DLL保持不变。所有测试均GPU识别，没有CPU识别回退。缓存单轮差值只用于筛选；compact期间有单CPP编译/链接的CPU活动，不据此断言缓存导致该差值。\n\n详细决定见[DECISIONS.json](DECISIONS.json)，完整榜单见[榜单](../../榜单.md)，源码/构建/ABI记录见[归档](../../records/gpuops-build/ARCHIVE.json)。\n', { flag: 'wx' });
console.log(JSON.stringify({ directory, backup, attempts: attempts.map(({ profile, seconds, after }) => ({ profile, seconds, status: after.status })), defaultUnchanged: true }));
