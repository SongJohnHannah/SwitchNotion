// Read existing evidence and write only the two requested independent documents.
// Never starts an application, configures a model, or invokes GPU inference.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const project = String.raw`D:\www\claude\notionSwitch`;
const bundle = String.raw`D:\迅雷下载\notionSwitch\GPU转写算子`;
const runtime = path.join(project, '.notion-switch/runtime/resources/notion-switch');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const textSha = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const relative = file => path.relative(bundle, file).replaceAll('\\', '/');
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const ensure = (value, message) => { if (!value) throw Error(message); };

async function currentStatus() {
  const control = read(path.join(project, '.notion-switch/control.json'));
  // The credential stays in memory for the localhost request. Do not serialize
  // control or the full status; they may contain unrelated account information.
  const response = await fetch(`http://127.0.0.1:${control.port}/status`, {
    headers: { authorization: `Bearer ${control.token}` }, signal: AbortSignal.timeout(5000),
  });
  ensure(response.ok, 'Notion status read failed');
  const status = await response.json();
  const notion = { pid: status.pid, appReady: status.appReady,
    speech: pick(status.speech, ['provider', 'model', 'device', 'computeType', 'configured', 'resourcesReady',
      'ready', 'loaded', 'busy', 'operatorSession', 'sharedOperator', 'runtimeVariant', 'decodingPolicy', 'enabled']) };
  const transcriberResponse = await fetch('http://127.0.0.1:3066/api/system', { signal: AbortSignal.timeout(5000) });
  ensure(transcriberResponse.ok, 'Transcriber status read failed');
  const transcriber = pick(await transcriberResponse.json(), ['model_name', 'device_required', 'resources_ready',
    'gpu_verified', 'gpu_probe_performed', 'cpu_fallback']);
  ensure(notion.appReady && notion.speech.model === 'large-v3-turbo' && notion.speech.device === 'cuda' &&
    notion.speech.operatorSession && notion.speech.sharedOperator && notion.speech.configured && notion.speech.resourcesReady,
  'Live Notion facade is not configured to the shared Turbo CUDA operator');
  ensure(transcriber.model_name === 'large-v3-turbo' && transcriber.device_required === 'cuda' &&
    transcriber.resources_ready && transcriber.cpu_fallback === false, 'Transcriber is not configured to the shared Turbo CUDA operator');
  return { checkedAt: new Date().toISOString(), selectedFieldsOnly: true, controlCredentialSaved: false, notion, transcriber };
}

function appFiles() {
  const files = ['collection/media.cjs', 'collection/service.cjs', 'media-transcript.cjs', 'settings/index.html',
    'settings/settings.js', 'settings/speech-presentation.js', 'speech/operator-client.cjs',
    'speech/operator-session-client.cjs', 'speech/settings.cjs'];
  const records = files.map(file => ({ file, sourceSha256: sha(path.join(project, 'src', file)),
    runtimeSha256: sha(path.join(runtime, file)) }));
  ensure(records.every(record => record.sourceSha256 === record.runtimeSha256), 'Selected app file mismatch');
  return { scope: 'only-the-nine-listed-app-facade-files', runtimeDirectory: runtime,
    runtimeHasSrcLayer: false, matches: records.length, files: records,
    limitation: 'This does not assert all current src files match. Experimental worker/gpu-file/type changes are separate; app inference uses the bundle frozen entry.' };
}

function auditRun(directory, name) {
  const result = read(path.join(directory, 'result.json'));
  const checkpoint = read(path.join(directory, 'checkpoint.json'));
  const events = fs.readFileSync(path.join(directory, 'raw-results.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const first = events.find(event => event.event === 'start');
  const last = [...events].reverse().find(event => event.event === 'complete');
  ensure(first && last, `${name}: missing start/complete`);
  let samples = 0;
  const issues = [];
  checkpoint.parts.forEach((part, index) => {
    if (part.index !== index || part.startSample !== samples || part.device !== 'cuda' || !Number.isSafeInteger(part.samples) || part.samples <= 0) issues.push(index);
    samples += part.samples;
  });
  const text = result.text;
  ensure(result.complete === true && result.device === 'cuda' && !issues.length && samples === result.totalSamples, `${name}: incomplete GPU audio coverage`);
  const artifacts = ['result.json', 'checkpoint.json', 'raw-results.jsonl', 'transcript.txt', 'audio.s16le', 'audio-source.json', 'app-entry.json', 'transcriber-result.json']
    .filter(file => fs.existsSync(path.join(directory, file))).map(file => ({ path: relative(path.join(directory, file)), sha256: sha(path.join(directory, file)) }));
  const out = { name, directory: relative(directory), complete: result.complete, device: result.device,
    language: checkpoint.language, policy: result.policy, plan: result.plan, sourceIdentity: result.sourceIdentity,
    totalSamples: samples, sampleRate: 16000, durationSeconds: result.duration, chunks: checkpoint.parts.length,
    segments: checkpoint.parts.reduce((sum, part) => sum + (part.segments?.length || 0), 0),
    characters: text.length, textSha256: textSha(text), transcriptFileSha256: sha(path.join(directory, 'transcript.txt')),
    pcm16Sha256: sha(path.join(directory, 'audio.s16le')),
    rawStartToCompleteSeconds: (Date.parse(last.at) - Date.parse(first.at)) / 1000,
    recognitionElapsedSeconds: events.filter(event => event.event === 'result').reduce((sum, event) => sum + (event.result?.elapsedMs || 0), 0) / 1000,
    resumedChunks: first.resumedChunks, recoveries: result.recoveries, nativeExits: result.nativeExits,
    rawErrorCount: events.filter(event => ['error', 'failed'].includes(event.event)).length,
    partContinuityIssues: issues,
    workerPids: [...new Set(events.filter(event => event.event === 'result').map(event => event.result?.workerPid || event.workerPid).filter(Number.isInteger))],
    finalPart: pick(checkpoint.parts.at(-1), ['index', 'startSample', 'samples', 'device']), artifacts };
  if (fs.existsSync(path.join(directory, 'app-entry.json'))) {
    const entry = read(path.join(directory, 'app-entry.json'));
    out.appEntry = pick(entry, ['entry', 'language', 'adapterWallSeconds', 'timingScope', 'complete', 'device', 'verifiedAt']);
  }
  if (fs.existsSync(path.join(directory, 'quality-report.json'))) {
    out.machineQualityComparison = pick(read(path.join(directory, 'quality-report.json')), ['status', 'referenceKind', 'anomalyCount', 'structureIssues', 'mappingWarnings', 'method']);
  }
  if (fs.existsSync(path.join(directory, 'transcriber-result.json'))) {
    const exported = read(path.join(directory, 'transcriber-result.json'));
    const txt = fs.readFileSync(exported.exportTranscriptFile, 'utf8');
    const srt = fs.readFileSync(exported.exportSrtFile, 'utf8');
    ensure(txt.replaceAll('\r\n', '\n') === result.text && exported.segments.length === out.segments, 'Transcriber export differs from operator result');
    out.transcriberExports = { byteTextEqualsOperator: txt === result.text,
      normalizedNewlineTextEqualsOperator: true, crlfCount: [...txt.matchAll(/\r\n/g)].length,
      explanation: 'Windows Python text export converts LF to CRLF. Only newline normalization was applied for comparison; no word/whitespace rewriting.', segmentCount: exported.segments.length,
      srtCueCount: [...srt.matchAll(/^\d+\r?$/gm)].length,
      files: [exported.exportTranscriptFile, exported.exportSrtFile].map(file => ({ path: relative(file), sha256: sha(file) })) };
    ensure(out.transcriberExports.srtCueCount === out.segments, 'Transcriber SRT cue count mismatch');
  }
  return out;
}

function recording() {
  const directory = path.join(bundle, 'tests/recording-2026-11-06T12-44-55-738Z');
  const verification = read(path.join(directory, 'VERIFICATION.json'));
  const raw = read(path.join(directory, 'raw-result.json'));
  ensure(verification.complete && verification.device === 'cuda' && raw.recordingDecode?.samples === 960216, 'Recording evidence mismatch');
  return { directory: relative(directory), ...pick(verification, ['complete', 'api', 'device', 'timingIncludesGpuQueue',
    'taskSeconds', 'language', 'recordingDecode', 'workerPid', 'validationScope']),
    decodedDurationSeconds: raw.recordingDecode.samples / 16000, tailSamplesBeyond60Seconds: raw.recordingDecode.samples - 60 * 16000,
    rawRecognitionElapsedSeconds: raw.elapsedMs / 1000, characters: raw.text.length,
    textSha256: textSha(raw.text), segments: raw.segments.length, cudaMemory: raw.cudaMemory,
    artifacts: ['VERIFICATION.json', 'raw-result.json', 'transcript.txt', 'jensen-first-minute.webm'].map(file => ({ path: relative(path.join(directory, file)), sha256: sha(path.join(directory, file)) })) };
}

const statuses = await currentStatus();
const facadeFiles = appFiles();
const t1Root = path.join(bundle, 'tests/apps-190239/t1');
const t1Directory = fs.readdirSync(t1Root, { withFileTypes: true }).find(item => item.isDirectory() && item.name.startsWith('.gpu-operator_'));
ensure(t1Directory, 'Missing Transcriber operator output directory');
const runs = [auditRun(path.join(bundle, 'tests/apps-190239/n1'), 'notion-file-entry-n1'),
  auditRun(path.join(t1Root, t1Directory.name), 'transcriber-file-entry-t1'),
  auditRun(path.join(bundle, 'tests/live-2026-11-06T12-01-22-546Z'), 'notion-session-pcm-full-audio')];
ensure(runs.every(run => run.totalSamples === 44896597 && run.chunks === 94 && run.resumedChunks === 0 &&
  run.recoveries === 0 && run.nativeExits === 0 && run.rawErrorCount === 0), 'Unexpected full-audio run facts');
ensure(new Set(runs.map(run => run.pcm16Sha256)).size === 1 && new Set(runs.map(run => run.textSha256)).size === 1, 'Run inputs/text hashes differ');
const recordingSmoke = recording();
const transcriberManifest = read(path.join(project, 'integrations/transcriber/deployment-manifest.json'));
const transcriberFiles = transcriberManifest.files.map(file => ({ file: file.path,
  expectedSha256: file.stagedSha256, deployedSha256: sha(path.join(String.raw`D:\www\claude\transcriber`, file.path)) }));
ensure(transcriberFiles.every(file => file.expectedSha256 === file.deployedSha256), 'Transcriber deployment hash mismatch');
const validation = { version: 1, generatedAt: new Date().toISOString(),
  scope: 'final-integration-validation-from-existing-artifacts-and-read-only-local-status',
  newGpuInferenceExecutedByThisAudit: false, applicationStartedByThisAudit: false,
  bundleDirectory: bundle, statuses, appFacadeFiles: facadeFiles,
  transcriberDeployment: { target: String.raw`D:\www\claude\transcriber`, files: transcriberFiles,
    cpuProtocolAndAdapterTestsPassed: transcriberManifest.testsPassed,
    receiptDirectory: 'records/integrations/integration-protocol-finish-20261106-203948',
    actualDescribeSmoke: read(path.join(bundle, 'records/integrations/integration-protocol-finish-20261106-203948/actual-bundle-describe-smoke.json')) },
  fullAudioRuns: runs, webmRecordingSmoke: recordingSmoke,
  commonFullAudio: { totalSamples: 44896597, sampleRate: 16000, durationSeconds: 2806.0373125,
    pcm16Sha256: runs[0].pcm16Sha256, textSha256: runs[0].textSha256, characters: runs[0].characters,
    finalRequestSamples: 256597, finalRequestDurationSeconds: 256597 / 16000 },
  qualityLimits: [
    'Matching machine transcript hashes and complete input coverage are not human WER or proof of zero omissions.',
    'The three routes use English for this saved interview validation; default auto/zh calls are separate configurations without this full-audio quality claim.',
    'Speech-segment timestamps naturally contain gaps/overlaps and are not a sample-coverage ledger.',
    'Raw start/complete timings exclude preparation/model loading; adapter wall timings include them and may include GPU lease wait.',
    'WebM smoke uses a real encoded file from the first minute of the interview, not an automated physical microphone capture or a full recording WER test.',
    'Native CUDA memory diagnostic MISSING_CUDART means no safe dynamic runtime query was performed; it does not prove zero free memory or a resolved driver/hardware cause.',
    'Only the nine listed app files were compared to runtime. Frozen operator entry/runtime differs intentionally from ongoing experimental src changes.',
  ] };

const rows = runs.map(run => `| ${run.name} | ${run.rawStartToCompleteSeconds.toFixed(3)} 秒 | ${run.chunks} | ${run.totalSamples.toLocaleString('en-US')} | ${run.characters.toLocaleString('en-US')} | ${run.workerPids.join(', ')} |`).join('\n');
const md = `# 统一 GPU 算子的最终接入与验收

保存于 ${validation.generatedAt}。此文档仅复核既有 GPU 原始记录、已部署文件哈希和应用的只读状态；本次没有启动应用或运行新 GPU 推理。机器可读证据见 [INTEGRATION-VALIDATION.json](INTEGRATION-VALIDATION.json)。

## 接入位置与当前状态

统一目录：\`${bundle}\`。NotionSwitch 的资料收集文件转写和实时语音会话，以及 Transcriber 的 Python JSONL 桥，均通过这一个独立包调用；各入口共用包内 resources 的 GPU lease。

当前 Notion PID 为 **${statuses.notion.pid}**，appReady=true；语音状态为 large-v3-turbo / CUDA，operatorSession=true、sharedOperator=true，配置和资源就绪。资源存在及 configured 不等于此刻已经载入 GPU 模型；实时的 ready/loaded 字段详见 JSON 中选取的状态。

Transcriber 位于 \`D:\\www\\claude\\transcriber\`，其本地界面为 \`http://127.0.0.1:3066\`；只提供 Turbo 稳定 GPU 路径，没有 CPU 回退。默认语言是 auto，本次已保存的全片验收明确使用 en。当前入口资源就绪；状态保留 gpu_probe_performed=${statuses.transcriber.gpu_probe_performed}，不会把静态 describe 伪装成 GPU probe。

Notion 运行文件实际位于 \`${runtime}\`，**没有额外 src 层**。只检查了 JSON 所列的9个应用入口/界面文件，均与 src 对应文件同哈希。不宣称所有 src 文件都与运行副本相同：后续实验 GPU worker、gpu-file、类型文件仍可独立演进，应用实际推理由同一包中的冻结入口负责。

Transcriber 部署清单10项均同哈希；实际部署目录的 **${transcriberManifest.testsPassed}项 CPU 协议/功能测试**通过。备份、测试、真实 describe smoke 和服务状态记录位于 \`records/integrations/integration-protocol-finish-20261106-203948\`。describe 实测约 ${validation.transcriberDeployment.actualDescribeSmoke.seconds.toFixed(3)}秒；该检查未导入 Torch/faster-whisper/CTranslate2，也未执行神经计算。

另核对了 t1 派生导出：719个 SRT cues 均保留；TXT 仅因 Windows Python 文本写出，把93个 LF 转成 CRLF，规范化换行后与算子原文逐字相同。派生 TXT 的文件哈希因此与原文不同，JSON 分别记录原始字节哈希与规范化比较，不冒称字节完全相等。

## 同一完整采访的实际记录

| 入口 | 原始 start→complete | 请求 | 输入样本 | 字符 | 实际 Python PID |
| --- | ---: | ---: | ---: | ---: | --- |
${rows}

三条输入均为 16kHz 单声道 PCM，共 **44,896,597样本 / 2806.0373125秒**；94个检查点 part 按样本连续覆盖，没有缺口或重叠，没有复用旧检查点，原始错误、恢复和原生退出均为0。最后一段是 **256,597样本 / 16.0373125秒**，没有为凑整而丢弃尾段。语音输出各有719个声学时间段；声学段的间隙/重叠不等于输入覆盖缺口。

全音轨 PCM16 SHA256：\`${runs[0].pcm16Sha256}\`。

三条结果的 text SHA256 均为 \`${runs[0].textSha256}\`，各44,258字符；transcript.txt 多末尾换行，文件哈希另列于 JSON。相同机器输出证明重复性与路线一致，**不能代替人工听校、人工 WER 或“零漏字”结论**。实时全片记录的机器参考窗口检查为 pass、0异常，并保留 index54 的时间戳映射 fallback 警告；它同样不是人工准确率。

n1 的适配器墙钟为 ${runs[0].appEntry.adapterWallSeconds.toFixed(3)}秒，包含准备、模型载入及可能的 GPU 排队；本表的原始运行口径不包括这些阶段。实时会话全片244.238秒也是它自身的原始 start→complete，不能与准备阶段或历史榜单混算成提速成绩。此文档没有修改默认方案、README、machine、榜单或原包清单。

## 真实 WebM 录音接口与尾部

\`tests/recording-2026-11-06T12-44-55-738Z\` 保存了来自这条采访前约60秒的真实 WebM/Opus 文件，经 \`OperatorSessionClient.transcribeRecording\` 解码并在 CUDA 识别。解码得到 **960,216样本 / 60.0135秒**，保留超过60秒的 **216个样本**；没有强行裁去编码器/重采样器的有界尾部。实际 worker PID=${recordingSmoke.workerPid}，识别函数 elapsed=${recordingSmoke.rawRecognitionElapsedSeconds.toFixed(3)}秒；任务墙钟=${recordingSmoke.taskSeconds.toFixed(3)}秒，包含 GPU lease 等待等额外阶段。

该实测验证了真实编码录音的接口、GPU 路径及尾部样本保留；不等于现场麦克风录制端到端自动化，更不等于录音 WER 测试。原始输入、raw-result、转录原文、解码 PCM 哈希和 VERIFICATION 均保留，完整哈希见 JSON。

## Node 调用例子：文件与实时会话

使用包内 operator.cjs；文件入口和实时会话共用 GPU lease。没有获得 lease 时排队，不额外创建旧项目的第二套 GPU 模型。以下是调用示例，保存本文时没有执行这些示例。

\`\`\`javascript
const fs = require('node:fs');
const operator = require(String.raw\`D:\\迅雷下载\\notionSwitch\\GPU转写算子\\operator.cjs\`);

(async () => {
  // WAV 须为接口支持的16kHz单声道格式；完整视频直接使用 transcribeFile。
  const session = operator.createSpeechSession();
  try {
    const text = await session.transcribeWav({
      wav: fs.readFileSync(process.argv[2]), language: 'en', chunkSeconds: 30,
    });
    fs.writeFileSync(process.argv[3], text, 'utf8');
  } finally {
    await session.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
\`\`\`

\`transcribeWav\` 内部持有会话直至整条音轨结束，每次取 \`min(剩余样本, 30秒)\`，包含最后不足30秒的尾段。连续 PCM 调用可在会话外层 \`retain()\`，完成后 \`await release()\` 和 \`await close()\`；退出确认前不能释放共享 GPU lease。录音入口 \`transcribeRecording({audio: webmBuffer, language})\` 单请求允许有界的约60秒录音及编码尾部，长视频应走文件入口。

## Python/Transcriber 调用例子

Python 只运行界面/桥接客户端，不导入旧 Torch/Whisper 双模型池。桥接使用独立包的 \`bin/node.exe bridge.mjs\`，stdin/stdout 为 UTF-8 JSONL；取消发送 \`{"type":"cancel"}\` 并保留 checkpoint。describe 发送后及收到最终结果/错误后关闭 stdin，避免等待 EOF 的协议死锁；转写进行中保持 stdin 打开以便取消。

\`\`\`powershell
& 'C:\\Users\\songf\\.pyenv\\pyenv-win\\versions\\3.12.0\\python.exe' -X utf8 -B 'D:\\www\\claude\\transcriber\\transcribe_file.py' 'D:\\path\\interview.webm' --output-dir 'D:\\path\\fresh-run' --language en
\`\`\`

每个源文件在目标目录下使用 \`.gpu-operator_<stem>-<path-hash>\` 保存原文、JSONL、checkpoint、来源身份和 transcriber-result.json；TXT/SRT/可选 IPA 是另外的派生输出。CLI 使用独立状态文件，不替换 Web 队列。默认 winner；实验 profile 只能以明确环境开关调用，界面不开放实验选项。

## 仍然存在的限制

英文完整采访、完整 PCM 会话和约60秒 WebM 均有实际 GPU 记录；auto/zh 是显式可选的其他调用配置，未冒用此次英文验收。稳定运行、相同哈希、输入覆盖与机器参考检查都不是人工真值稿。不能据此宣称全部 CUDA、驱动或硬件根因已经修复；Native 的 cudaMemory=MISSING_CUDART 表示没有获得可安全查询的动态 CUDART 读数，不表示显存为0。未验收的批量、桥接或其他实验不通过本文件自动获得可用资格。
`;

for (const file of ['INTEGRATION.md', 'INTEGRATION-VALIDATION.json']) ensure(!fs.existsSync(path.join(bundle, file)), `${file} already exists; refusing to overwrite`);
fs.writeFileSync(path.join(bundle, 'INTEGRATION-VALIDATION.json'), JSON.stringify(validation, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
fs.writeFileSync(path.join(bundle, 'INTEGRATION.md'), md, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ saved: ['INTEGRATION.md', 'INTEGRATION-VALIDATION.json'],
  notionPid: statuses.notion.pid, appFilesMatched: facadeFiles.matches, transcriberFilesMatched: transcriberFiles.length,
  fullRuns: runs.map(run => ({ name: run.name, rawSeconds: run.rawStartToCompleteSeconds, samples: run.totalSamples, chunks: run.chunks })),
  recordingSamples: recordingSmoke.recordingDecode.samples, newGpuInferenceExecuted: false }));
