# 离线转写模块：Windows / Apple Silicon Mac

稳定入口为 `src/speech-provider.cjs`，类型声明为 `src/speech-provider.d.cts`。模块只依赖 Node 内置模块及本机 Python 转写环境，不依赖 Electron、Notion、Codex、DeepSeek 或它们的登录信息。相同接口用于文件转写和原生速记音频。

| 系统 | 默认运行方式 | 验证状态 |
| --- | --- | --- |
| Windows x64 + NVIDIA | faster-whisper Medium / Large-v3 Turbo，CUDA FP16 | RTX 2070 中文、英文文件转写已实测 |
| Apple Silicon Mac（包括 M1） | faster-whisper Medium / Large-v3 Turbo，CPU INT8，4 线程 | 已实现平台检测和后端选择，通过模拟契约测试；未实机验证 |
| Intel Mac / Rosetta x64 进程 | 拒绝启动 | 不属于本次支持范围 |

M1 的 GPU 不通过 CUDA 使用。本模块没有启用 Metal、MLX 或 Neural Engine，不承诺 M1 达到 Windows GPU 的测试速度。[CTranslate2 的 macOS ARM64 支持及 GPU 限制](https://opennmt.net/CTranslate2/installation.html)、[硬件支持](https://opennmt.net/CTranslate2/hardware_support.html)。

## 调用示例

```js
const { SpeechProvider } = require('./src/speech-provider.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.join(os.homedir(), '.notion-switch-speech');
fs.mkdirSync(root, { recursive: true });
const speech = new SpeechProvider({ root });
try {
  await speech.probe(); // 自动识别本机系统、检测本机环境并载入模型
  const text = await speech.transcribeWav({
    wav: fs.readFileSync('/absolute/path/recording.wav'),
    language: 'auto', // auto / zh / en
  });
  console.log(text);
} finally {
  speech.close();
}
```

`root` 必须为本机可写的绝对目录。示例中的录音路径需要换成本机路径，模块不会采集麦克风；录音采集由调用端负责。

| 方法 | 约定 |
| --- | --- |
| `status()` | 返回系统、架构、运行设备、精度、就绪/忙碌状态；不暴露程序和模型路径 |
| `probe({signal}?)` | 检测并实际载入模型；缺少组件报错，不自动下载，不静默切换云端 |
| `transcribe({pcm,language?,context?,signal?})` | 输入单声道 16 kHz Float32 LE Buffer，数值范围 [-1,1]，最多 60 秒；返回文字 |
| `transcribeDetailed({pcm,language?,context?,signal?})` | 返回 `{text,context,language}`；context 仅含高置信度文本，最多 120 字，供调用方在同一音源的下一段复用 |
| `transcribeWav({wav,language?,signal?,onProgress?})` | PCM16 / Float32、单/双声道、8–48 kHz WAV，最多 10 分钟 / 128 MiB；自动重采样、分段，返回文字 |
| `retain()` / `release()` | 连续录音期间保留模型；配对使用，空闲默认 20 秒释放进程及内存/显存 |
| `close()` | 中止自己的工作进程及排队请求；不关闭其他 Whisper 程序；下次调用可重新启动 |

调用可排队执行。取消正在运行的任务会结束当前工作进程，之后重新加载；已排队但尚未开始的任务可独立取消。分段识别不等于逐字流式识别。首次加载包含额外延迟，CPU 转写较慢时调用端应限制积压音频。

## 运行环境与迁移

项目的 `npm run package:speech` 生成独立模块文件夹，包含代码、类型、依赖清单和本文档；不包含 Python、模型、CUDA、Notion 客户端、密钥、登录或音频。这个文件夹可直接交给 Mac 接入者，无需复制整个 NotionSwitch 项目。模块可离开 Codex 独立运行。

应用配置页现已支持选择模型和自动准备：优先复用已有环境，缺少时下载独立 Python、固定版本的 faster-whisper/CTranslate2 和固定 revision 的所选模型；Windows 仅在缺少可用运行库时下载 CUDA 依赖。准备阶段联网，所有安装、缓存和模型保存在传入的本机状态目录。底层 `SpeechProvider.probe()` 继续保持不联网的约定，自动下载由 `src/speech/install.cjs` 的 `install({root,platform,onProgress,signal})` 完成。独立调用时用 `new SpeechProvider({root,model:'large-v3-turbo'})` 或 `createSpeechPlatform({model:'large-v3-turbo'})` 选择 Turbo，省略则保持 Medium 兼容默认值。

默认 `language:'auto'` 按双语语音输入处理，中文和英文保留原语言，任务始终为 `transcribe`。每段按 20 毫秒小窗检测停顿，满 4 秒且静音约 0.8 秒时分段，连续讲话最多 20 秒一段，所有采样及尾段完整保留；规则集中在 `src/speech/segmentation.json`。批量音频与会议流使用相同规则，音频传输包边界不影响声学分段。

自动模式不把 `context` 或中文书写提示用于下一段解码，避免上一句中文干扰下一句英文；显式 `zh` / `en` 请求仍传入限定语言及最多 120 字的可靠上下文。上下文只能来自同一会议的同一音源，切换会议后应清空。不调用文本模型修写录音，不做固定单词替换。模型名称、来源和 revision 在 `src/speech/models.json` 中固定；Turbo 的原始模型说明见 [OpenAI 发布说明](https://github.com/openai/whisper/discussions/2363)，CTranslate2 权重见 [模型仓库](https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo)。识别准确率仍取决于实际录音，短测试样本不代表全部会议。

M1 端准备原生 ARM64 Node 22+、原生 ARM64 Python 3.11 独立环境，以及 `src/speech/requirements.txt` 中的依赖。不要在 Rosetta 的 x64 Node/Python 下运行。依赖安装属于准备阶段，可在联网电脑准备相应 ARM64 安装包后离线安装；识别阶段不联网。

默认优先查找 `root/speech/python/bin/python3`、`root/speech/venv/bin/python3`，再查找 Homebrew、用户 pyenv 和 PATH 中的 Python。特殊安装位置可通过调用进程的 `NOTION_SWITCH_SPEECH_PYTHON` 指定绝对路径。Windows 则查找对应的 `python.exe` 和 CUDA 环境。

把已转换的 faster-whisper Medium 模型文件夹放在 `root/speech/faster-whisper-medium/`，至少包含 `model.bin`、`config.json`、`tokenizer.json` 及其原有词表文件。也支持本机已有的 Hugging Face 缓存。不要拿原版 Whisper 的 `medium.pt` 直接替换。相同的 CTranslate2 模型文件可在不同系统/架构间使用，但 Python、动态库及本机配置必须重新准备。[模型格式与可移植性](https://opennmt.net/CTranslate2/conversion.html)。

NotionSwitch 配置保存平台和架构，复制来的 Windows 配置会在 Mac 上失效并重新检测。不要打包 `.notion-switch/` 或 `speech.local.json`。

## 后续接入 Mac 原生 Notion

语音模块的 M1 CPU 实现与 Mac Notion 桌面启动分别验证。Mac 的双击启动、`.app` 分发、隔离副本和本机签名流程已实现，见项目 `MAC-使用说明.md`；应用启动、登录和 Notion 原生控件仍待 M1 真机验收。

Notion 原生桥接通过 `SpeechProvider` 的统一接口取得文字；其余 Agent 和页面工具不需要增加 CPU/CUDA 判断。若以后接入 Apple GPU，保留上述外部接口，在 `src/speech/platform.cjs` 和 `src/speech/faster_backend.py` 处替换具体运行实现，并重新通过契约及真实音频测试。

内部 Node/Python 使用版本 1 的 JSONL 协议：configure → probe / transcribe，按整数 id 匹配结果。configure 必须返回 `protocolVersion`、provider、model、platform、architecture、device、computeType；任何不匹配会在发送音频前结束进程。协议走标准输入输出，不开放公网端口；不写录音文件，不传入 API Key，工作进程禁止网络连接。

## 验证

`node --test tests/speech.test.mjs tests/speech-platform.test.mjs` 检查接口、M1 路径发现、跨系统配置隔离、平台握手、取消和资源释放。`python -B tests/speech_backend_test.py` 检查 Python 后端契约。这些测试不代表完成 M1 硬件推理或 Mac Notion 实录验收。
