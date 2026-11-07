import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stageSpeech } from './package-speech.mjs';
import { localDeepSeekKeys } from './package-safety.mjs';
const require = createRequire(import.meta.url);
const { CollectionBinaries } = require('../src/collection/binaries.cjs');
const project = path.resolve(import.meta.dirname, '..');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const isInside = (parent, child) => { const relative = path.relative(path.resolve(parent), path.resolve(child)); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
function walk(directory, accept = () => true, relative = '') {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const rel = path.join(relative, entry.name), file = path.join(directory, entry.name);
    if (!accept(rel, entry) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...walk(file, (nested, type) => accept(path.join(entry.name, nested), type), ''));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}
function fileHash(file) {
  const hash = createHash('sha256'), descriptor = fs.openSync(file, 'r'), buffer = Buffer.alloc(8 * 1024 * 1024);
  try { let count; while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}
function absoluteArtifact(directory, value) {
  const resolved = path.resolve(directory, value);
  if (!isInside(directory, resolved)) throw Error('包内路径越界：' + value);
  return resolved;
}
const textExtensions = /\.(?:jsonl?|md|txt|log|csv|py|cjs|mjs|js|cfg|pth|ps1|cpp|h)$/i;
function secretCheck(file, keys) {
  if (!textExtensions.test(file)) return;
  const size = fs.statSync(file).size;
  if (size > 64 * 1024 * 1024) throw Error('文本记录过大，需审查后再打包：' + path.basename(file));
  const text = fs.readFileSync(file, 'utf8');
  if (keys.some(key => key && text.includes(key)) || /\b(?:sk-|ntn_|secret_)[A-Za-z0-9_-]{20,}/.test(text)) throw Error('发现疑似凭据，未复制内容：' + path.basename(file));
}
function selectStable(board, predicate) {
  return board.methods.find(method => method.status === 'stable-two-runs' && method.validRuns?.length >= 2 && !method.failures?.length &&
    method.validRuns.every(run => {
      const review = path.join(run.outputDirectory, 'quality-review.json');
      return !fs.existsSync(review) || !['content-review-needed', 'rejected', 'failed'].includes(json(review).status);
    }) && predicate(method));
}
function sourceImplementation(method) {
  const latestRun = method.validRuns.at(-1), manifest = path.join(latestRun.outputDirectory, 'implementation.json');
  return fs.existsSync(manifest) ? json(manifest) : null;
}

export function inspectGpuExport({ sourceProject = project, destination = 'D:\\迅雷下载\\notionSwitch\\GPU转写算子', video } = {}) {
  const root = path.join(sourceProject, '.notion-switch'), experiment = path.join(root, 'speech/gpu-v1');
  const board = json(path.join(experiment, 'leaderboard.json'));
  if (!board.champion) throw Error('尚无正式榜首，不能导出为稳定算子。');
  const winner = selectStable(board, method => method.key === board.champion.key);
  if (!winner) throw Error('榜首缺少独立双轮稳定证据。');
  const native = selectStable(board, method => method.plan.runtimeVariant === 'sm75-native' && method.plan.chunkSeconds === 30);
  if (!native) throw Error('未找到通过独立双轮的 Native30 备用方案。');
  const config = json(path.join(root, 'speech.local.json')), runtime = config.runtime;
  const venv = path.dirname(path.dirname(runtime.pythonExecutable));
  const home = fs.readFileSync(path.join(venv, 'pyvenv.cfg'), 'utf8').match(/^home\s*=\s*(.+)$/m)?.[1].trim();
  if (!home || !fs.existsSync(path.join(home, 'python.exe'))) throw Error('无法确定自包含 Python 基础解释器。');
  const ffmpeg = new CollectionBinaries({ root }).find('ffmpeg');
  if (!ffmpeg) throw Error('未找到已安装 FFmpeg。');
  const entries = [], targets = new Set();
  const add = (source, relative, kind) => { if (!fs.statSync(source).isFile()) throw Error('导出源不是文件：' + source); if (targets.has(relative)) return; targets.add(relative); entries.push({ source, relative, kind, bytes: fs.statSync(source).size }); };
  const tree = (source, relative, kind, filter = () => true) => { for (const file of walk(source, filter)) add(file, path.join(relative, path.relative(source, file)), kind); };
  const pythonFilter = (relative, entry) => !/(?:^|[\\/])(?:__pycache__|\.git|\.cache)(?:[\\/]|$)/.test(relative) && !/\.py[co]$/i.test(relative);
  tree(fs.realpathSync(home), 'resources/speech/python', 'python-base', (rel, entry) => pythonFilter(rel, entry) && !/^Lib[\\/]site-packages(?:[\\/]|$)/i.test(rel));
  tree(path.join(venv, 'Lib/site-packages'), 'resources/speech/python/Lib/site-packages', 'python-dependencies', pythonFilter);
  tree(runtime.modelDirectory, 'resources/speech/model', 'model', (rel, entry) => !rel.split(/[\\/]/).some(part => part.startsWith('.')) && !/\.lock$/i.test(rel));
  add(fs.realpathSync(process.execPath), 'bin/node.exe', 'node'); add(fs.realpathSync(ffmpeg), 'bin/ffmpeg.exe', 'ffmpeg');
  const relocation = [];
  for (const name of new Set([winner.plan.runtimeVariant, native.plan.runtimeVariant])) {
    const variant = path.join(experiment, 'variants', name), manifest = json(path.join(variant, 'variant.json'));
    if (!fs.existsSync(path.join(variant, 'READY.json'))) throw Error('运行库尚未冻结：' + name);
    tree(variant, path.join('resources/speech/gpu-v1/variants', name), 'gpu-variant', (rel, entry) => !/\.py[co]$/.test(rel) && !rel.includes('__pycache__'));
    const externalDirectories = manifest.dllDirectories.filter(value => path.isAbsolute(value));
    if (externalDirectories.length) {
      for (const library of manifest.preloadLibraries || []) {
        const source = externalDirectories.map(directory => path.join(directory, library)).find(file => fs.existsSync(file));
        if (!source) throw Error('备用算子缺少 CUDA 库：' + library);
        add(source, path.join('resources/speech/gpu-v1/variants', name, 'gpu-libs', library), 'native-cuda');
      }
      relocation.push({ variant: name, originalManifest: manifest, originalReadySha256: fileHash(path.join(variant, 'READY.json')), originalDirectories: externalDirectories });
    }
  }
  // Preserve every ASR trial's textual evidence, but not repeated PCM/audio caches.
  tree(experiment, 'records/gpu-v1', 'trial-record', (rel, entry) => {
    if (/(?:^|[\\/])(?:variants|ct2-sm75)(?:[\\/]|$)/.test(rel)) return false;
    if (entry.isDirectory()) return true;
    return textExtensions.test(rel) && !/(?:^|[\\/])(?:STOP|\.queue\.lock|\.leaderboard\.lock)$/.test(rel) && !/api[-_]?key|cookies|\.env(?:\.|$)/i.test(rel);
  });
  const diagnostic = path.join(root, 'collection/video-diagnostic');
  if (fs.existsSync(diagnostic)) for (const name of fs.readdirSync(diagnostic)) {
    if (/^(?:gpu-exit.*\.json|gpu-fix-verification.*\.json|gpu-probe-result.*\.json|loaded-gpu-modules.*\.json|transcript-before-gpu.*\.json|speech-before-gpu-fix.*\.json|final-transcript-as-written\.txt|transcript-first-23-minutes\.txt|.*-raw-result.*\.json|comparison-.*\.jsonl|recovery-failure.*\.json|initial-queue.*\.log)$/.test(name)) add(path.join(diagnostic, name), path.join('records/early-diagnostics', name), 'early-diagnostic');
  }
  for (const name of fs.readdirSync(path.join(root, 'speech'))) if (/^(?:worker-failures\.jsonl|native-faults-.*\.log)$/.test(name)) add(path.join(root, 'speech', name), path.join('records/worker-diagnostics', name), 'worker-diagnostic');
  const nativeBuild = path.join(experiment, 'ct2-sm75');
  if (fs.existsSync(nativeBuild)) for (const file of walk(nativeBuild, (rel, entry) => {
    if (entry.isDirectory()) return !/(?:^|[\\/])(?:source|build|binding-build|variant-staging)(?:[\\/]|$)/.test(rel);
    return /BUILD-NOTES.*\.md$|(?:build|pipeline|cmake|source-reference|patch).*(?:\.log|\.json|\.md|\.patch)$/i.test(rel);
  })) add(file, path.join('records/native-build', path.relative(nativeBuild, file)), 'native-build-record');
  for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) if (fs.existsSync(path.join(sourceProject, name))) add(path.join(sourceProject, name), path.join('licenses', name), 'license');
  for (const name of fs.readdirSync(path.join(sourceProject, 'scripts'))) if (/^(?:build-ct2-sm75|build-native-gpuops|check-native-gpuops|publish-native-gpuops|prepare-pinned|gpu-leaderboard|gpu-runtime-snapshot|gpu-queue|migrate-gpu-queue|export-gpu-operator).*\.(?:mjs|py|ps1)$/.test(name)) add(path.join(sourceProject, 'scripts', name), path.join('records/reproduction-scripts', name), 'reproduction-source');
  for (const name of ['GPU-TRANSCRIPTION-V1.md', 'QUALITY-AND-LIMITS.md', 'NEXT-OPTIMIZATIONS.md']) {
    const file = [path.join(experiment, name), path.join(sourceProject, 'docs', name)].find(file => fs.existsSync(file));
    if (file) add(file, name, 'documentation');
  }
  for (const name of ['pinned-cudnn', 'sm75-native']) {
    const variant = path.join(experiment, 'variants', name);
    if (fs.existsSync(variant)) for (const file of walk(variant, (rel, entry) => entry.isDirectory() || /license|notice|copyright/i.test(rel))) add(file, path.join('licenses/variants', name, path.relative(variant, file)), 'license');
  }
  const nativeSource = path.join(nativeBuild, 'source');
  for (const name of ['LICENSE', 'CMakeLists.txt']) if (fs.existsSync(path.join(nativeSource, name))) add(path.join(nativeSource, name), path.join('records/native-source', name), name === 'LICENSE' ? 'license' : 'source-reference');
  const sourceVideo = video ? path.resolve(video) : json(path.join(experiment, 'queue-input.json')).source;
  const totals = Object.fromEntries([...new Set(entries.map(entry => entry.kind))].map(kind => [kind, entries.filter(entry => entry.kind === kind).reduce((sum, entry) => sum + entry.bytes, 0)]));
  return { version: 1, sourceProject, root, experiment, destination: path.resolve(destination), winner, native, runtime, sourceVideo, relocation, entries,
    totals, estimatedBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), pythonBase: fs.realpathSync(home), ffmpeg, leaderboard: board,
    winnerImplementation: sourceImplementation(winner), nativeImplementation: sourceImplementation(native) };
}

const operatorSource = `'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const home=__dirname,machine=JSON.parse(fs.readFileSync(path.join(home,'machine.json')));
const {transcribeGpuFile}=require('./module/src/speech-provider.cjs');
const inside=value=>{const resolved=path.resolve(home,value);const rel=path.relative(home,resolved);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw Error('包内路径无效');return resolved;};
function describe(){return{...machine,packageDirectory:home};}
async function transcribeFile(options={}){
 const profile=options.profile||'winner',selected=machine.profiles[profile];if(!selected)throw Error('未知方案：'+profile);
 const plan=JSON.parse(fs.readFileSync(inside(selected.planFile))),explicit=Object.hasOwn(options,'language'),language=explicit?options.language:'en';
 if(!['auto','en','zh'].includes(language))throw Error('language须为auto/en/zh');
 plan.languageOverride=language==='auto'?null:language;
 const root=inside(machine.resourcesRoot),runtime={pythonExecutable:inside(machine.pythonExecutable),modelDirectory:inside(machine.modelDirectory),model:machine.model,platform:'win32',architecture:'x64',device:'cuda',computeType:plan.computeType,cpuThreads:4,dllDirectory:null,dllDirectories:[]};
 const source=path.resolve(options.source||machine.originalVideo||'');if(!fs.existsSync(source)||!fs.statSync(source).isFile())throw Error('音视频不存在，请提供source绝对路径。');
 const outputDirectory=options.outputDirectory?path.resolve(options.outputDirectory):path.join(home,'outputs',new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8));
 const result=await transcribeGpuFile({source,outputDirectory,root,ffmpeg:inside(machine.ffmpeg),runtime,plan,language,signal:options.signal,onProgress:options.onProgress||(()=>{})});
 return{...result,profile,validationScope:language==='en'?'本机英文访谈整段验证方案；本次运行结果另存':'auto/zh为显式派生调用，未接受本次英文全片质量/速度验收'};
}
module.exports={transcribeFile,describe};
`;
const runnerSource = `import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{transcribeFile,describe}=require('./operator.cjs');
const args=process.argv.slice(2);if(args.includes('--describe')){console.log(JSON.stringify(describe(),null,2));process.exit(0);}
let language,profile='winner';for(const flag of ['--language','--profile']){const at=args.indexOf(flag);if(at>=0){const value=args[at+1];if(!value)throw Error('缺少参数：'+flag);if(flag==='--language')language=value;else profile=value;args.splice(at,2);}}
if(!args[0])throw Error('用法：run.cmd "音视频路径" ["输出目录"] [--profile winner|native30] [--language en|auto|zh]');
const controller=new AbortController();process.once('SIGINT',()=>controller.abort(Error('用户停止，已保留检查点。')));
const result=await transcribeFile({source:args[0],...(args[1]?{outputDirectory:args[1]}:{}),profile,...(language?{language}:{}),signal:controller.signal,onProgress:event=>console.log(JSON.stringify(event))});
console.log(JSON.stringify({complete:result.complete,device:result.device,transcriptFile:result.transcriptFile,eventsFile:result.eventsFile,validationScope:result.validationScope},null,2));
`;

export async function exportGpuOperator({ apply = false, ...options } = {}) {
  const plan = inspectGpuExport(options);
  if (!apply) return { dryRun: true, destination: plan.destination, champion: plan.winner.plan.id, medianSeconds: plan.winner.medianSeconds, backup: plan.native.plan.id,
    estimatedBytes: plan.estimatedBytes, estimatedGiB: plan.estimatedBytes / 1024 ** 3, totals: plan.totals, fileCount: plan.entries.length, note: '未复制、未运行 GPU；加 --apply 执行独立封装。' };
  if (fs.existsSync(plan.destination)) throw Error('目标已存在，为保留已有版本未覆盖：' + plan.destination);
  for (const source of [plan.sourceProject, plan.pythonBase, plan.runtime.modelDirectory]) if (isInside(source, plan.destination) && !isInside(path.join(plan.sourceProject, 'dist'), plan.destination)) throw Error('打包目标不能位于待复制资源内部。');
  const target = plan.destination + '.building-' + randomUUID(); fs.mkdirSync(target, { recursive: true });
  const keys = localDeepSeekKeys(plan.sourceProject), manifest = [], capturedAt = new Date().toISOString();
  let bytes = 0;
  for (const entry of plan.entries) {
    if (['trial-record','early-diagnostic','worker-diagnostic','native-build-record','reproduction-source','documentation'].includes(entry.kind)) secretCheck(entry.source, keys);
    const output = absoluteArtifact(target, entry.relative); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(entry.source, output, fs.constants.COPYFILE_EXCL);
    manifest.push({ file: entry.relative.replaceAll('\\','/'), source: entry.source, kind: entry.kind, bytes: fs.statSync(output).size, sha256: fileHash(output) }); bytes += entry.bytes;
  }
  const stage = path.join(plan.sourceProject, 'dist', 'gpu-operator-sdk-' + randomUUID()); stageSpeech({ sourceProject: plan.sourceProject, destination: stage });
  for (const source of walk(stage)) { const relative = path.join('module', path.relative(stage, source)), output = absoluteArtifact(target, relative); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(source, output); }
  for (const implementation of [plan.winnerImplementation, plan.nativeImplementation].filter(Boolean)) {
    for (const file of implementation.files) {
      const source = path.join(implementation.snapshotDirectory, file.file);
      if (fileHash(source) !== file.sha256) throw Error('验证源码快照被修改：' + file.file);
      const output = path.join(target, 'verified-source', implementation.revision, file.file); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(source, output);
    }
    fs.writeFileSync(path.join(target, 'verified-source', implementation.revision, 'implementation.json'), JSON.stringify(implementation, null, 2));
  }
  for (const moved of plan.relocation) {
    const variant = path.join(target, 'resources/speech/gpu-v1/variants', moved.variant);
    const relocated = { ...moved.originalManifest, dllDirectories: ['gpu-libs'], relocatedAt: capturedAt, relocation: { originalDirectories: moved.originalDirectories, originalReadySha256: moved.originalReadySha256, gpuTestedAfterRelocation: false } };
    fs.writeFileSync(path.join(variant, 'variant.original.json'), JSON.stringify(moved.originalManifest, null, 2));
    fs.writeFileSync(path.join(variant, 'variant.json'), JSON.stringify(relocated, null, 2));
    const originalReady = json(path.join(variant, 'READY.json')); fs.writeFileSync(path.join(variant, 'READY.original.json'), JSON.stringify(originalReady, null, 2));
    fs.writeFileSync(path.join(variant, 'READY.json'), JSON.stringify({ ...originalReady, relocatedAt: capturedAt, originalReadySha256: moved.originalReadySha256, relocationVerifiedByGpu: false }, null, 2));
  }
  const { normalizePlan } = require(path.join(stage, 'src/speech/gpu-file.cjs'));
  const profiles = {};
  for (const [name, method] of [['winner', plan.winner], ['native30', plan.native]]) {
    const variantReady = path.join(target, 'resources/speech/gpu-v1/variants', method.plan.runtimeVariant, 'READY.json');
    const frozen = normalizePlan({ ...method.plan, runtimeRevision: fileHash(variantReady) });
    fs.mkdirSync(path.join(target, 'profiles'), { recursive: true }); fs.writeFileSync(path.join(target, 'profiles', name + '.json'), JSON.stringify(frozen, null, 2));
    fs.writeFileSync(path.join(target, 'profiles', name + '.verification-original.json'), JSON.stringify({ plan: method.plan, medianSeconds: method.medianSeconds, validRuns: method.validRuns,
      packagedPlan: frozen, packagedSdkIsLatest: true, requiresPackagedEntryValidation: true }, null, 2));
    profiles[name] = { planFile: 'profiles/' + name + '.json', verifiedOriginalPlanId: method.plan.id, medianSeconds: method.medianSeconds };
  }
  const machine = { version: 1, createdAt: capturedAt, resourcesRoot: 'resources', pythonExecutable: 'resources/speech/python/python.exe', modelDirectory: 'resources/speech/model',
    model: plan.runtime.model, ffmpeg: 'bin/ffmpeg.exe', node: 'bin/node.exe', originalVideo: plan.sourceVideo, profiles,
    hardware: { system: 'Windows x64', gpu: 'NVIDIA RTX 2070', driverRequired: true }, validation: { englishOnly: true, latestPackagedEntryRequiresFullVideoValidation: true } };
  fs.writeFileSync(path.join(target, 'machine.json'), JSON.stringify(machine, null, 2));
  const pythonVersion = path.basename(plan.pythonBase).match(/3\.(\d+)/)?.[1] || '11';
  fs.writeFileSync(path.join(target, 'resources/speech/python', 'python3' + pythonVersion + '._pth'), 'python3' + pythonVersion + '.zip\n.\nDLLs\nLib\nLib/site-packages\n../../../module/src/speech\nimport site\n');
  fs.writeFileSync(path.join(target, 'operator.cjs'), operatorSource); fs.writeFileSync(path.join(target, 'run.mjs'), runnerSource);
  fs.writeFileSync(path.join(target, 'run.cmd'), '@echo off\r\n"%~dp0bin\\node.exe" "%~dp0run.mjs" %*\r\n');
  fs.writeFileSync(path.join(target, 'example.cjs'), "const {transcribeFile}=require('./operator.cjs');\ntranscribeFile({source:process.argv[2],outputDirectory:process.argv[3],onProgress:console.log}).then(r=>console.log(r.transcriptFile)).catch(e=>{console.error(e.message);process.exitCode=1;});\n");
  fs.writeFileSync(path.join(target, 'README.md'), `# 本机 GPU 转写算子\n\n默认正式榜首：${plan.winner.plan.id}；独立两轮中位 ${plan.winner.medianSeconds} 秒（2806.0373125 秒黄仁勋英语音轨）。备用 Native30：${plan.native.plan.id}。\n\n本文件夹包含 Node、独立 Python 基础解释器和依赖、模型、FFmpeg、CUDA 用户态库、最新 SDK、已验证源码快照、全部 ASR 试验文本记录与榜单。系统 Windows/NVIDIA 驱动仍为本机前提。原视频不复制。\n\n## 调用\n\nPowerShell：\n\n\`\`\`powershell\n& ".\\run.cmd" "视频绝对路径" "输出目录绝对路径"\n& ".\\run.cmd" "视频绝对路径" "备用输出目录" --profile native30\n\`\`\`\n\nNode API：\n\n\`\`\`js\nconst { transcribeFile } = require('./operator.cjs');\nconst result = await transcribeFile({ source: '视频绝对路径', outputDirectory: '输出绝对路径' });\nconsole.log(result.transcriptFile);\n\`\`\`\n\n默认语言 en，验证范围为本次英语采访。显式 --language auto 会清除方案 en 覆盖，--language zh 尊重调用；auto/zh 未接受本次英语全片质量和速度验收。\n\n机器路径在 machine.json 中全部相对包目录；运行资源位于 resources。原项目删除后无需它的 Python、模型或 API 配置。可整体移动文件夹。不要单独搬某个 DLL。\n\n## 验证与记录\n\nprofiles 中同时保存原始验证 plan 和规范化冻结 plan。module 是导出时最新 SDK（含 lease/稳定性修复），verified-source 是当时真实运行快照，二者不冒充同一 hash；最终包入口尚待根任务整段验收。Native13 三主库已复制并将 manifest 改为包内相对路径，保留原 manifest/READY 及搬迁 hash，备用入口需要搬迁后验收。\n\nrecords 保存所有 GPU 轮次原始 JSONL、检查点、逐字稿、错题、时间线、榜单、早期叹号错误原文、Windows TDR 和构建记录；去掉重复 audio.s16le、原视频、Notion 页面配置/快照及凭据。旧记录保持原文，原路径通过 RECORD-INDEX.json 映射到包内文件。\n\nQUALITY-AND-LIMITS.md 与 NEXT-OPTIMIZATIONS.md 如已生成将一并收录。打包后可用 bin/node.exe run.mjs --describe 查看解析后的目录。\n`);
  fs.mkdirSync(path.join(target, 'records'), { recursive: true });
  fs.writeFileSync(path.join(target, 'records', 'RECORD-INDEX.json'), JSON.stringify({ capturedAt, entries: manifest.filter(entry => /record|diagnostic|source/.test(entry.kind)) }, null, 2));
  fs.writeFileSync(path.join(target, 'licenses', 'REFERENCES.md'), '# 依赖与源码引用\n\n- CTranslate2 v4.8.5，MIT：https://github.com/OpenNMT/CTranslate2/tree/v4.8.5\n- faster-whisper：https://github.com/SYSTRAN/faster-whisper\n- CPython：https://docs.python.org/3/license.html\n- Node.js：https://github.com/nodejs/node/blob/main/LICENSE\n- FFmpeg：https://ffmpeg.org/legal.html\n- NVIDIA CUDA/cuDNN：本机用户态库备份；许可见 NVIDIA Toolkit/cuDNN 安装及其发行说明。GPU 驱动不随包复制。\n- Whisper large-v3-turbo：https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo\n');
  const allFiles = walk(target); const packagedFiles = [];
  for (const file of allFiles) { if (textExtensions.test(file) && !file.includes(path.join('resources','speech','python','Lib'))) secretCheck(file, keys); packagedFiles.push({ file: path.relative(target, file).replaceAll('\\','/'), bytes: fs.statSync(file).size, sha256: fileHash(file) }); }
  fs.writeFileSync(path.join(target, 'PACKAGE-MANIFEST.json'), JSON.stringify({ version: 1, createdAt: capturedAt, winner: plan.winner.plan.id, backup: plan.native.plan.id, originalProjectRequired: false,
    includesPython: true, includesModel: true, includesCudaUserLibraries: true, includesDriver: false, originalVideoCopied: false, packagedEntryGpuValidated: false,
    files: packagedFiles, totalBytes: packagedFiles.reduce((sum, file) => sum + file.bytes, 0), relocation: plan.relocation.map(item => ({ variant: item.variant, originalReadySha256: item.originalReadySha256,
      relocatedReadySha256: fileHash(path.join(target, 'resources/speech/gpu-v1/variants', item.variant, 'READY.json')) })) }, null, 2));
  fs.renameSync(target, plan.destination);
  return { destination: plan.destination, bytes, fileCount: packagedFiles.length, champion: plan.winner.plan.id, requiresFullVideoEntryValidation: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) { if (args[i] === '--apply') options.apply = true; else if (['--destination','--video'].includes(args[i])) { const key = args[i].slice(2); if (!args[i+1]) throw Error('缺少参数：'+args[i]); options[key] = args[++i]; } else throw Error('用法：node scripts/export-gpu-operator.mjs [--destination 新目录] [--video 原视频绝对路径] [--apply]'); }
  console.log(JSON.stringify(await exportGpuOperator(options), null, 2));
}
