# Windows 项目内 GPU 算子

当前 NotionSwitch 的 Windows 文件转写、录音和 GPU 视频转码使用项目内算子。代码在 `src/speech/windows-operator/`，自定义 Native 库在 `assets/windows-gpu-native/`，本机大资源在 `.notion-switch/windows-gpu-operator/`。应用不默认访问下载目录中的旧独立包。

识别保留已验证的 Large-v3 Turbo、Native CUDA13/sm75、FP16、同步 greedy1 路径；GPU 错误停止并保存记录，不切 CPU 识别。音频解码和文件准备可以在 CPU 完成。Mac 保留原 provider、模型准备及 CPU INT8 路线，不安装 Windows GPU 库。

## 准备资源

Git 包含算子代码、固定方案、自定义 Native DLL/PYD、许可证和 `src/speech/windows-operator/asset-lock.json`。完整 Python、模型、CUDA 和 FFmpeg 较大，保存在 Git 忽略的本机资源目录；只拉取代码尚不能直接识别。

新 checkout 已包含算子代码和自定义 Native 库；日常只需补齐 Git 未跟踪的大资源。显式指定一份已经准备好的独立算子包：

```powershell
node .\scripts\prepare-windows-gpu-runtime.mjs --source "X:\离线资源\GPU转写算子"
```

把示例来源换成实际绝对路径；`--source` 必填，没有默认下载目录。可用 `--project "项目绝对路径"` 指定目标项目，省略则使用脚本所属项目。工具按已有资源锁物理复制运行资源，不覆盖受版本控制的代码和 Native 库，也不创建指向外部包的运行依赖。目标运行资源目录须不存在；已准备的项目无需重复执行。

维护者首次导入整套代码、Native 库和运行资源时，使用 `vendor-windows-gpu-operator.mjs --source <绝对目录> [--project <绝对目录>]`。vendor 是 fresh-only 工具，任一输出根已存在便拒绝覆盖；已有代码的 checkout 应使用上面的 prepare 命令。

安装后，大资源在 `.notion-switch/windows-gpu-operator/`：`resources/speech/` 下包含 Python、模型和 Native 运行变体，`bin/` 下包含 FFmpeg/ffprobe。代码根及两类资产根保存各自的资源锁与文件校验信息。移动完整项目后，路径按项目状态目录重新解析，原复制来源可以保持离线或搬走。

目前提供的是从明确本机来源导入的流程，不是公共资源服务或云端自动下载器。新电脑需准备相应 Windows x64 资源和 NVIDIA 驱动。Windows 打包按锁纳入已安装的本地资源；Mac 包不纳入它们。

## 调用

应用的内容收集、文件逐字稿和录音设置直接使用本项目适配器，不需要另配外部包路径。代码调用可明确分开代码根与资源根：

```js
const path = require('node:path');
const { createFileOperator } = require('./src/speech/windows-operator/operator.cjs');
const operator = createFileOperator({
  home: path.resolve('src/speech/windows-operator'),
  assetHome: path.resolve('.notion-switch/windows-gpu-operator'),
});
const result = await operator.transcribeFile({
  source: absoluteVideoPath,
  outputDirectory: freshOutputDirectory,
  language: 'auto',
});
console.log(result.transcriptFile);
```

`language` 支持 `auto`、`zh`、`en`；应用普通调用使用 `auto`。历史英语采访基准显式用 `en`，不把它的质量和速度结论扩大到其他语言。默认 `profile:'winner'`；候选方案需要显式 `allowExperimental:true`，不覆盖默认方案。

`createSpeechSession()` 提供实时 PCM、WAV 和 WebM 录音接口；应用门面为 `OperatorSessionClient`。`transcodeVideo()` 提供 NVDEC/NVENC 视频转码。本项目内这些入口共用本地资源根的 lease；仍使用旧独立包的外部 Transcriber 有自己的资源根和队列，本次没有修改它。

逐字稿、检查点、原始 JSONL、音轨和失败记录保存在本机输出目录，中断后保留。不同输入、语言或方案使用不同目录。`describe()` 只描述资源与方案，不证明模型已载入或 GPU 实际成功。

## 已保留的方案与历史成绩

独立包历史 Native30 两轮为 **193.326 / 194.858 秒，中位 194.092 秒**，对应同一黄仁勋采访的 2806.0373125 秒音轨、44,896,597 个样本。识别计时从模型就绪至最终逐字稿，不含准备、载模和排队；这是既有成绩，不是本次项目内复制的重复验收或每次运行保证。

`native30-streaming` 保留音频准备与识别流水线。旧双轮的含审查任务端到端改善约 1.1%，没有作为神经网络算子提速替换默认方案。

`native120-complete` 保留 120 秒输入容器，内部最多四个 30 秒调用原稳定识别路径。既有两轮 208.627 / 201.358 秒，中位 204.9925 秒，比 194.092 秒慢约 5.6%；已核验完整输入、五处具名回归及与原稳定机器稿一致，按要求保留。这里的“完整”不是人工 WER 或所有语音零漏字保证。

历史实验相对 194.092 秒的 ≥7% 门槛为 180.50556 秒，必须两轮全新目录整片、零 GPU 错误并通过内容审查；失败、漏句或只成功一次的结果不晋级。约 104 秒的旧 batch2 因漏句已撤完整逐字稿资格。

迁移前的独立包地址 `D:\迅雷下载\notionSwitch\GPU转写算子` 仅作为证据来源保留，包内 `VALIDATION.json`、`INTEGRATION-VALIDATION.json`、榜单与原始结果没有在本次改写。更详细的接口和历史对照见 [接入说明](GPU-OPERATOR-INTEGRATION.md)、[Transcriber 对照](TRANSCRIBER-COMPARISON.md)。本次便携测试不代表新增 Mac 真机或 GPU 整片验收。
