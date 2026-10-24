# Windows 离线语音转写

当前实现使用本机已有的 faster-whisper 1.2.1、CTranslate2 4.8.1、Whisper Medium 多语言模型。Windows x64 使用 NVIDIA CUDA GPU / FP16，已实测；Apple Silicon Mac（M1 等）已实现 CPU INT8 后端和平台检测，尚未实机验证。不会把 CUDA 当作 Metal 使用。稳定接口、迁移准备和独立模块分发见 [跨平台转写接口](SPEECH-INTERFACE.md)。

配置窗口的“离线语音”提供检测、直接录音测试、启用原生速记和释放资源。已有环境优先复用；检测不到时自动下载独立 Python、faster-whisper、Medium 模型及必要运行库。自动下载保存在本机状态目录，不修改原有 Python，不依赖 Codex。首次准备联网，识别阶段不联网。录音测试由用户点击开始，停止后转写，最多 60 秒。

本机配置保存在 `.notion-switch/speech.local.json`；保存平台、架构、程序、模型及 Windows DLL 位置，不包含模型服务 API Key。不把本机配置、音频、模型缓存或登录资料放入源码分发包。换电脑后需在当地准备对应离线组件并重新检测；Mac 不沿用 Windows 路径。

## 独立调用接口

```js
const { SpeechProvider } = require('./src/speech-provider.cjs');
const provider = new SpeechProvider({ root: absoluteLocalStateDirectory });
try {
  await provider.probe();
  const text = await provider.transcribe({
    pcm, // Buffer: 16000 Hz, 单声道、Float32 little-endian，单段最多 60 秒
    language: 'auto', // auto / zh / en
    signal
  });
} finally {
  provider.close();
}
```

`transcribeWav({ wav, language, signal })` 接受不超过 10 分钟的 PCM16/Float32 WAV，并逐段识别。`retain()` / `release()` 可在连续录音期间保留模型；空闲 20 秒后结束进程释放显存。`close()` 立即取消自己的工作进程，不影响原有 Whisper 程序。

Node 与 Python 通过版本化 JSONL 协议传递内存中的音频，不创建录音文件。工作进程启用 Hugging Face 离线模式，只从本机路径载入模型，并禁止 Python socket 连接；不传入 DeepSeek/Notion/Codex 凭据。Windows GPU 不可用会报错；Mac 自动选择 CPU INT8。均不静默改为云端。

## Notion 原生速记适配

已审核的原生音频连接模块改为本机回环地址，通过 Engine.IO 4 / Primus 承接音频 RPC。临时随机令牌、Notion Origin 检查和连接限制保护本机通道。录音连接不再等待模型冷启动：先返回本机令牌、建立音频连接，再后台预热；引擎载入失败会通知原生界面并结束连接。未知原生代码版本不进行盲目替换，未通过适配时不会提供本机录音令牌。

保留工作区限制及管理员禁止转写的设置。客户端继续使用原有记录写入逻辑；本机 ASR 不直接调用 Notion 内容 API。停止录音时处理尾段；取消会停止待处理任务。已确认的重复请求不重复追加音频。

这是按短片段更新的转写，不是严格逐字的流式识别。优先在短暂停顿后处理积累的片段；连续说话达到约 12 秒时分段，停止时处理剩余片段。静音结果以 ignore 事件返回，避免生成空白段落。实际延迟还包含模型首次加载、片段积累和推理时间，长时间不断句时仍可能发生分段处识别偏差。

本地转写不会自动上传给云端总结。原生自动会议总结请求在此模式下被阻止；需要 DeepSeek 总结时，可在既有 AI 侧栏手动要求总结页面，这一步需要联网。Notion 页面自身的登录、加载与同步仍由 Notion 管理。

## 验证与实机边界

自动测试覆盖协议握手、尾段处理、重复请求、错误输入、取消、进程复用、空闲释放和原生代码兼容检查。真实 GPU 已完成中文、英文文件转写。Notion 麦克风录音的实际控件体验仍须单独验收，协议测试不代表已完成一次真人会议录制。

本机性能对照记录位于私有研究目录 `research/whisper-offline/comparison.json`；原版与 faster-whisper 使用同一个 Medium 模型系列、同一 RTX 2070、同样的两个公开 WAV、beam size 5。短样本速度不代表所有会议和所有语言的准确率。

模型与软件各自遵循原有许可：[faster-whisper](https://github.com/SYSTRAN/faster-whisper)、[CTranslate2](https://github.com/OpenNMT/CTranslate2)、[Whisper](https://github.com/openai/whisper)。
