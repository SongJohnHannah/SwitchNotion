# 本机 GPU 文件转写 V1

当前可交付主方案：Native sm75 / CUDA13.3 + FP16 + 英文 + greedy 同步 + 30秒连续外层请求。整段 2806.0373125 秒音轨两轮耗时 212.988 / 219.449 秒，中位数 216.2185 秒，两轮逐字稿 SHA256 均为 `d5e26d3b8a829eb19573809dd8c3b2eb5f6e94182ee2057a12115c184a68d113`。当前正式榜首及后续更新以本机 `gpu-v1/leaderboard.json` 为准。

Pinned2×30秒批量方案曾达到105.001 / 104.261秒，但质量复核发现1470–1500秒只输出“Roasted.”，同窗 Native30 和 Pinned20 均有连续多句内容，故两轮均标记 `content-review-needed`，已撤下可交付榜首。保留速度和原始输出，不把输入样本覆盖误报为逐字内容完整。

这证明本机这段音轨的连续完成与输出一致性，不是对任意音频永不失败或人工逐字准确率的保证。批量方案的时间戳是原始30秒片段边界，不是逐词时间戳。原609.089秒基准第二轮失败，仅作计时锚点，不能作为稳定备用。

## 验收条件

1. 识别必须使用 NVIDIA CUDA；拒绝 CPU 提供器，不做 CPU 回退。
2. 从音轨首样本到末样本全部处理；检查点记录每段起始样本和长度，完成时核对样本总数。
3. 保留分段原始返回值、错误、设备、工作进程 PID、方案和运行路径。
4. 重复叹号等异常不得作为成功文字送入总结。完整运行发生恢复事件的方案不能直接登记为稳定方案。
5. 不同方案使用独立目录；修改过参数不能冒用旧检查点。重复验收使用新目录实际重跑。

## 独立调用

公共方法 `transcribeGpuFile` 从 `src/speech-provider.cjs` 导出，具体实现位于 `src/speech/gpu-file.cjs`。它只需要 Node、本机 Python 模型与 FFmpeg，不依赖 Notion、浏览器、Electron、云服务或登录。

```powershell
node D:\www\claude\notionSwitch\scripts\transcribe-gpu.mjs "视频绝对路径" "独立输出目录绝对路径" "通过验收的方案 JSON 绝对路径"
```

```js
const { transcribeGpuFile } = require('D:/www/claude/notionSwitch/src/speech-provider.cjs');
const result = await transcribeGpuFile({
  source, outputDirectory, root, ffmpeg, runtime, plan,
  onProgress: event => console.log(event),
});
// result.transcriptFile、eventsFile、checkpointFile 均为实际文件绝对路径。
```

`root` 是本机资源目录；缺省 runtime 从它的 `speech.local.json` 读取。运行路径不写死到算法里；本机版本和路径保存在 `.notion-switch/speech/gpu-v1/machine.json`。

## 执行路径

FFmpeg 将完整音轨预解码为 16kHz 单声道 PCM16 → 按样本连续切段 → 独立 Python CUDA 工作进程 → Whisper 声学分段与 GPU 解码 → 原始结果落盘 → 内容检查 → 接受后保存检查点 → 全样本覆盖检查 → 最终逐字稿。

已验证方案使用单候选 greedy、零温度、无前文提示；进程和运行库环境由独立方法选择，不借用桌面应用的共享语音工作进程。Native30 主方案使用针对本机 sm75 构建的 CUDA13.3/CTranslate2 4.8.5，关闭 cuDNN。Native 重新编译了官方实现，没有声称已重写 CUDA 数学内核。Pinned20 标量备用方案固定实际加载的 CUDA12/cuDNN9.19 依赖，独立两轮中位230.2285秒；未达到比Native30快7%的门槛。

完整音频的预解码和读写仍需要 CPU。队列串行衔接 GPU 识别任务，不插入人为等待；GPU 硬件利用率会随声学处理、数据传输和解码阶段变化，不能将“全程 100% 利用率”当作完整转写的证据。

## 原始记录

每次运行目录包含：

- `audio.s16le`、`audio-source.json`：预解码音轨及来源标识。
- `raw-results.jsonl`：逐次识别返回值、时间、音频位置、方案、PID、重试和错误。
- `checkpoint.json`：仅保存被接受的分段，用于断点续写。
- `transcript.txt`、`result.json`：全部样本处理成功后才生成的结果与校验信息。

队列目录 `.notion-switch/speech/gpu-v1` 包含 `queue-state.json`、`FAILURES.md`、`verified-methods.json`、各方案 JSON 和完整运行目录。`repeatVerified=true` 表示在两个独立目录完整重跑通过。创建 `STOP` 文件可在保留进度的前提下停止队列。

## 已踩过的坑

| 实验 | 实际结果 | 后续约束 |
| --- | --- | --- |
| 只检查 CUDA probe、进度或文字长度 | 未发现 55,377 字符中有 31,808 个叹号 | 必须保存原始返回值并核验内容 |
| 将 CTranslate2 4.8.5 单次通过当作根因已修复 | 连续运行仍出现 `0xc0000409` | 版本升级不等于稳定验收；不能排除其他层面 |
| CUDA FP16、8 候选 | 同一批音频第三段返回 224 个叹号 | 记录为失败配置，不原样重排 |
| 只改为 5 候选、保留异步分配器 | 短测通过，连续运行仍有退出与错误文本 | 只能列为短测有效，不能列为稳定方案 |
| GPU FP32 或 5 候选短测 | 故障片段能得到正常英文，整段后仍失败 | 短测不能代表稳定，必须完整实测 |
| CUDA 运行库路径推断 | 实际加载的 cuDNN 来自 CTranslate2 自带 9.10.2，cuBLAS 来自 Torch 目录 | 必须记录实际库路径，不能只根据配置目录断言所有库一致 |
| CPU INT8 对照 | 单个 10 秒片段耗时约 107 秒，整组超时 | 不纳入 GPU 方案，不改变生产 GPU 要求 |
| GPU FP32 / 缓存分配器整段 | 音频 21分40秒处失败；同秒 NVIDIA UCodeReset/Resetting/Reset/Restarting TDR | 不只排查文字解码；保存系统事件 |
| 固定 CUDA12/cuDNN9.19 的 FP32 | 音频 16分10秒处在 `detect_language → encode → self.model.encode` 非法地址 | 不能归因仅为解码器，也不能凭路径一致认定已修复 |
| 固定库、FP32、greedy、同步 | 在编码矩阵运算报 `CUBLAS_STATUS_EXECUTION_FAILED` | 转向本机 sm75 / CUDA13 原生构建与其他真实执行路径 |

已失败的精度、分配器、重启组合不原样重试。新候选包括 greedy 搜索路径、固定依赖库变体，以及为本机 sm75 / CUDA13.3 构建的原生变体；每次调整写明依据。未构建完成的依赖不算 GPU 测试失败。运行库版本用 READY 摘要区分，不能仅修改方案名字重排同一失败配置。

另一个生命周期问题已修正：Windows venv 的 python.exe 可能只是启动器。停止和超时现在结束本方法拥有的进程树，并等待清理后再载入下一 CUDA 上下文。不同轮次区分启动器 PID 与实际 Python PID，防止残留进程或审计错配。

用户已取消 CPU 对照。当前只比较同一整段音轨的 GPU 方案：两次新目录独立完成、无错误、无异常连续标点、全样本覆盖且没有明显文字量下降。榜首更替要求中位耗时比当前榜首至少降低7%。完整覆盖表示音频均送入模型，并不等于模型一定识别出每个单词。

后续优化方向与可调用版本分开保存。已经失败的大编码批次、INT8、异步路径不因改名而反复入队；新路径须记录具体变化并重新接受完整验收。所有源代码按每次运行冻结哈希，运行中编辑不会改变已开始的方案。

## 依据

[CTranslate2 环境变量](https://opennmt.net/CTranslate2/environment_variables.html) 定义内存分配器与 FP16 GEMM 累加开关；[4.8.5 更新记录](https://github.com/OpenNMT/CTranslate2/releases/tag/v4.8.5) 包含注意力精度及分配器修复。两者均不能直接证明本机退出的唯一根因。
