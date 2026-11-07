# Windows 项目内 GPU 算子接入

Windows 应用从本项目加载算子代码和资源，不再默认调用下载目录中的外部独立包。文件转写、实时录音、录音测试和 GPU 视频转码使用同一套本地资源；识别固定 Large-v3 Turbo、Native CUDA13/sm75、FP16、同步 greedy1。Apple Silicon Mac 继续原来的 provider、安装和 CPU INT8 路径，不加载这套 Windows DLL。

## 代码与资源

| 位置 | 用途 | Git / 分发 |
| --- | --- | --- |
| `src/speech/windows-operator/` | 算子入口、方案、冻结 SDK、资源锁 `asset-lock.json` | 随代码提交 |
| `assets/windows-gpu-native/` | 本机编译的 Native CT2 DLL/PYD、配套代码与许可证 | 随代码提交 |
| `.notion-switch/windows-gpu-operator/` | 完整 Python、模型、CUDA 用户态库、FFmpeg/ffprobe 与本机运行记录 | Git 忽略；Windows 打包时按锁校验并纳入已安装资源 |

应用适配器加载编译代码旁的 `speech/windows-operator`，资源根按应用状态目录解析为 `<stateRoot>/windows-gpu-operator`。源码运行时通常就是本项目 `.notion-switch/windows-gpu-operator`。运行时不需要原始复制来源仍然存在。

新 checkout 已含受版本控制的代码和 Native 库，通过 `scripts/prepare-windows-gpu-runtime.mjs --source <绝对目录> [--project <绝对目录>]` 按已有资源锁补齐未跟踪运行资源。来源须显式指定已准备的独立包，不设外部盘符默认值，也不覆盖现有代码。

`vendor-windows-gpu-operator.mjs` 仅供维护者首次导入整套代码、Native 和运行资源，已有任一输出根便拒绝覆盖。资源清单与文件 SHA/字节数一起保存。详细命令见 [算子用法](GPU-OPERATOR-README.md)。两者都是本机复制工具，不是云端资源自动下载器。

Windows 分发包含项目内算子代码、自定义 Native 库，以及存在并通过锁校验的本机资源。没有安装资源的源码 checkout 不会凭空带有模型。Mac 分发保留原路线，不纳入 Windows GPU 资源；本次便携测试不等于 Mac 真机验收。

## 应用入口与调用

`src/speech/operator-client.cjs` 使用项目内工厂 `createFileOperator({home, assetHome})`，将代码根与资源根分开；`OperatorSessionClient` 从同一个实例创建实时会话。应用入口包括：

- 内容收集的网页媒体和本地音视频：`CollectionMedia.transcript`。
- 设置中的“选择音频或视频生成逐字稿”：`MediaTranscript.request('transcript.start')`。
- Notion 媒体附件、页面文件和本地附件引用：经 `MediaTranscript.parse` 进入同一文件接口。
- Windows 原生录音、录音测试与流式 PCM：`OperatorSessionClient`。
- Windows 上传视频的必要重编码：`GpuOperatorClient.transcodeVideo`。

```js
const { CollectionMedia } = require('./src/collection/media.cjs');
const media = new CollectionMedia({ root: absoluteProjectStateDirectory });
const result = await media.transcript(
  { path: absoluteVideoPath, kind: 'video', audio: true },
  { directory: freshOutputDirectory, language: 'auto', signal, progress: console.log },
);
// result: { text, note, device: 'cuda', operator: { ...原始记录路径 } }
```

普通用户文件显式使用 `language:'auto'`；历史英语采访基准使用 `en`。语言参数和方案均逐次传递，不改后续调用。实验仍须显式指定候选 `profile` 和 `allowExperimental:true`，失败或待复核方案不会自动成为默认。

生产任务未传输出目录时，适配器把结果放在 `<stateRoot>/collection/transcriptions/<source-routing-hash>/<profile-hash>`。路由键只定位目录，最终来源身份、方案和检查点仍由算子校验。独立基准使用全新输出目录，不能复用旧检查点计时。

返回的 `operator` 包含来源身份、语言、方案、输出目录、原始 JSONL、检查点、逐字稿路径及哈希；逐段时间戳保存在 `checkpoint.json` 的 `parts[].segments`。会话原始结果、PCM 身份与 worker PID 保存在本地资源根的会话记录中。

## 排队、恢复与错误

本项目内的入口按同一资源根的 GPU lease 排队，持有者在请求结束且 worker 关闭后释放。其他项目如果仍使用旧独立包的资源根，其队列与本项目分开；本次迁移不等于两个项目仍共用一条队列，也没有修改外部 Transcriber。

此前的 `export`、`finalize` 和独立包实验脚本仍用于手动维护历史包，不是应用运行依赖；其中的旧盘符和历史命令不代表当前应用会从外部加载。维护历史包时须先核对这些工具的目标目录。

文件接口保留原始结果、检查点、解码音轨和失败记录。GPU 出错或取消向上传递，不在应用层盲重试，不切 CPU，也不以旧成功文本代替本次结果。设备不是 `cuda`、结果未完成或存在异常标点重复时不接受为成功。内容收集在转写未成功时暂停 AI 总结。

旧 `transcript-progress.json` 和 `audio-transcript-v1` 不作为这条路径的检查点。旧收集稿重新处理时移至 `analysis.transcriptHistory`；新转写失败不会把旧稿放回当前结果。直接选择的本地文件不为每次任务再复制一份大视频，完成后复验来源身份。

## 桌面与更新

Windows 桌面进程从 `<stateRoot>/runtime/resources/notion-switch` 加载已复制的应用代码。修改 workspace 或刷新页面不会热替换主进程模块。正常更新流程复制源码和项目内算子代码，校验后替换运行副本再启动；本机模型等资源按状态目录定位，不依赖旧下载路径。

更新前退出录音并结束活动任务。`scripts/open-update.mjs` 使用正常检查、准备和重启流程；`open-notion.mjs` 复用已有窗口不等于代码已同步。Git 更新保留现有工作区与回退检查，不覆盖本地未提交修改。

## 视频上传压缩

`transcodeVideo()` 使用同一项目内资源和 lease。收集入口要求硬解，核对 `engine:'h264_nvenc'`、`decodeEngine:'*_cuvid'` 和完整结果；显式 API 可选择 CPU 解码配 GPU 编码。无需重编码的原文件或 stream-copy 仍优先复用。

转码后复验原文件身份、输出独立路径、视频和音轨时长，只有更小的有效输出才用于压缩上传。必要分段先尝试 `-c copy`；必须重编码时从原片生成关键帧，并核对实际返回的间隔与 `forcedIdr`。失败保留原片和记录，不切到 `libx264`。`original` 保留尺寸，仍是有损 NVENC 编码。

记录位于 `<stateRoot>/collection/video-transcodes` 的独立目录。Mac 压缩/分段保留原软件路径。历史采访的 VP9 硬解/H264 硬编耗时 384.481 秒，CQ19 输出大于原片，因此不是压缩收益证明。

## 历史验收与本次迁移范围

2026-11-06 的独立包位于 `D:\迅雷下载\notionSwitch\GPU转写算子`。当时 NotionSwitch 与外部 Transcriber 共用该包，两应用文件入口及实时 PCM 都完成同一采访的整片识别。这是迁移前的真实记录，不代表本次迁移后再次完成同样的实机验收。

原 Native30 双轮为 193.326 / 194.858 秒，中位 **194.092 秒**；计时不含准备、载模或排队。应用接入、会话、固定 PCM 和原文哈希的历史证据见 [对照记录](TRANSCRIBER-COMPARISON.md)。旧独立包与外部 Transcriber 本次不修改。

本次路径、协议和分发测试使用便携测试与注入边界，不自动加载 GPU；新部署的整片、麦克风控件和 Mac 实机验收须单独记录。原输入覆盖、与机器参考一致和短测通过，都不能代替人工 WER 或所有语音零漏字保证。

2026-11-07 的实际项目内 GPU 复测、原始记录位置和仍待解决的文字差异见[本次迁移验收](WINDOWS-GPU-MIGRATION-VALIDATION.md)。这份记录区分已完成运行与严格内容校验，不能用历史成绩替代本次结果。
