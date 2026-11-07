# 离线转写接口：Windows / Apple Silicon Mac

Windows 应用使用项目内的 GPU 算子；实时入口为 `OperatorSessionClient`，文件入口为 `GpuOperatorClient`。Apple Silicon Mac 继续原有 `SpeechProvider`、环境安装和模型发现路线。二者保留相近的调用接口，不要求调用端处理 CUDA 或 CPU 细节。

| 系统 | 当前路径 | 验证范围 |
| --- | --- | --- |
| Windows x64 + NVIDIA | 项目内 Large-v3 Turbo / Native30 CUDA FP16，录音和文件共用本地资源 | 保留既有英语整片、实时 PCM 和录音文件记录；本次路径迁移的便携测试另计 |
| Apple Silicon Mac | 原 faster-whisper Medium / Turbo、CPU INT8、4 线程 | 保留原实现；本次仅便携契约与打包测试，没有新增 Mac 真机验收 |
| Intel Mac / Rosetta x64 进程 | 拒绝启动该语音后端 | 不属于本次支持范围 |

Mac 不安装 Windows DLL，也不通过 CUDA 使用 Apple GPU；当前路线没有启用 Metal、MLX 或 Neural Engine。Windows 缺资源或 GPU 失败不会切到旧 CPU provider。模块不需要 Notion、DeepSeek、Codex 的登录或密钥。

## 应用调用

```js
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve('.notion-switch');
const speech = process.platform === 'win32'
  ? new (require('./src/speech/operator-session-client.cjs').OperatorSessionClient)({ root })
  : new (require('./src/speech-provider.cjs').SpeechProvider)({ root });
try {
  await speech.probe();
  const text = await speech.transcribeWav({
    wav: fs.readFileSync(absoluteRecordingPath),
    language: 'auto',
  });
  console.log(text);
} finally {
  await speech.close();
}
```

Windows 的 `root` 为本项目可写状态目录；适配器从代码旁的 `windows-operator` 和 `<root>/windows-gpu-operator` 创建本地算子。录音采集由调用端负责；示例不会开启麦克风。

| 方法 | 约定 |
| --- | --- |
| `status()` | 返回设备、模型、就绪/忙碌状态；区分资源存在与 GPU 模型已载入 |
| `configure()` | 验证/准备本地配置，不自动下载 Windows 大资源 |
| `probe({signal}?)` | 检测资源并实际载入模型；只读描述不代替 probe |
| `transcribe({pcm,language?,context?,signal?})` | 16 kHz 单声道 Float32 LE Buffer，范围 [-1,1]，单次最多 60 秒；返回文字 |
| `transcribeDetailed(...)` | 返回 `{text,context,language}`；Windows 稳定会话不把输入 context 喂给下一段解码 |
| `transcribeWav({wav,language?,signal?,onProgress?,chunkSeconds?})` | PCM16 / Float32、单/双声道、8–48 kHz WAV；保留尾段。Windows 每次分段 1–30 秒，默认 30；文件收集走整文件 API |
| `transcribeRecording({audio,language?,signal?})` | Windows 会话接受 WebM/Opus 录音；保存编码输入及解码 PCM 身份，保留受限 codec 尾部 |
| `retain()` / `await release()` | 连续录音时配对保留模型；Windows 等请求排空和 worker 关闭后释放同一资源根的 GPU lease |
| `await close()` | 取消自己的工作、等待清理；不关闭其他项目的 Whisper 进程 |

Windows 无 retain 的请求完成后及时释放 worker，避免空闲模型长期挡住文件队列。Mac 保留原 provider 的空闲释放策略。排队请求可独立取消；取消正在运行的识别会结束自己的 worker，下次请求重新加载。

`language` 支持 `auto`、`zh`、`en`。应用普通调用默认 auto，保留语音原语言，不翻译或润色；历史英语基准显式 en。上下文只应来自同一音源：Mac 兼容 provider 保留原可靠上下文规则，Windows 冻结 greedy 会话传空提示，防止跨段引入文字。

## Windows 代码与资源

- 代码、固定方案和冻结 SDK：`src/speech/windows-operator/`。
- 自定义 Native CT2 DLL/PYD、配套代码与许可：`assets/windows-gpu-native/`。
- 完整 Python、模型、CUDA、FFmpeg/ffprobe：`.notion-switch/windows-gpu-operator/`，Git 忽略。
- 规范资源锁：`src/speech/windows-operator/asset-lock.json`；两类资产根也保存各自锁清单。

新 checkout 已包含代码与 Native 库。使用 `node scripts/prepare-windows-gpu-runtime.mjs --source "已准备的独立包绝对路径"` 按现有资源锁物理安装未跟踪运行资源；`--source` 必填，可用 `--project` 选择目标项目，不覆盖版本控制下的代码和 Native 库。运行路径从项目状态目录和相对清单生成，不需要原复制来源，也不自动联网下载。

`vendor-windows-gpu-operator.mjs` 是维护者首次导入代码、Native 和资源的 fresh-only 工具，已有输出根时拒绝覆盖，不用于给普通 checkout 补资源。

Windows 分发按资源锁收录已安装的项目内资源；Mac 分发不带 Windows GPU 资源。Git 中没有模型、完整 Python/CUDA、私人音视频、转录和日志，拉取仓库后仍需准备大资源。文件接口示例见 [GPU 算子用法](GPU-OPERATOR-README.md)。

本项目文件、录音和视频转码共用本地资源根的 lease。旧外部独立包及其他项目使用自己的资源根，当前不能宣称跨项目仍统一排队。

## Mac 原有准备与迁移

Mac 的配置模型选择和 `src/speech/install.cjs` 自动准备流程保持原样：准备阶段可以联网获取独立 Python、固定依赖和模型；识别阶段从本机加载，不静默改云端。独立 `SpeechProvider.probe()` 不下载；省略 model 保持 Medium 兼容默认值，显式 `model:'large-v3-turbo'` 选择 Turbo。

M1 等机器需要原生 ARM64 Node 22+、Python 3.11 及 `src/speech/requirements.txt`。保留 `root/speech/python/bin/python3`、`root/speech/venv/bin/python3`，再到 Homebrew、pyenv 和 PATH 的发现顺序；特殊位置可用 `NOTION_SWITCH_SPEECH_PYTHON`。不复用 Windows Python、DLL 或本机配置，不在 Rosetta x64 下运行。

CTranslate2 模型目录需要 `model.bin`、`config.json`、`tokenizer.json` 和词表；原版 Whisper 的 `.pt` 不能直接替换。模型定义与 revision 在 `src/speech/models.json`，各平台运行环境分别准备。平台与架构不匹配的配置会重新检测。

原生音频按固定 20 毫秒小窗检测停顿，满约 4 秒且静音约 0.8 秒时分段，连续讲话最多约 20 秒，尾段保留。Windows 稳定会话使用同步 greedy1/零温度；Mac 保留原有解码规则。分段更新不等于逐字即时输出，模型载入与积累音频均有延迟。

`npm run package:speech` 导出兼容语音模块与接口文档，不包含完整 Python、模型、CUDA、用户数据或 Notion。这个兼容导出不等于带齐资源的 Windows 项目内算子；Mac 可继续按原接口集成，不能从 Windows 资源清单推导 Mac 已可运行。

## 原始记录与验证

Windows 原始结果先保存，再执行文本质量检查；异常文字和失败仍留作排查，记录包含 PCM 身份与 worker PID。文件转写另保留原始 JSONL、检查点、逐字稿和音轨。GPU 失败不返回旧成功文本；内容收集未完成转写时暂停总结。会议录音保存/上传是独立功能，见 [离线语音](OFFLINE-SPEECH.md)。

Node/Python 使用版本化 JSONL 请求，按整数 id 匹配回复并核对 configure 的平台、设备、模型和协议字段。工作进程只使用本机识别资源，不接收模型服务密钥。

`node --test tests/speech.test.mjs tests/speech-platform.test.mjs` 与对应 Python 契约测试检查接口、路径发现、跨平台隔离、取消和释放；Windows 算子和打包有独立测试。这些便携测试不启动真实 Mac 推理，也不替代新部署的 GPU 整片或现场麦克风验收。既有成绩与边界见 [历史对照](TRANSCRIBER-COMPARISON.md)。
