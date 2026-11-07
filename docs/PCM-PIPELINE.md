# 音频准备与GPU转写流水线原型

此原型仅新增 `src/speech/pcm-pipeline.cjs`，没有直接改动已验收的Native30算子、收集入口或GPU数学运算。必须由主任务接入一个新的实验版本并完整验收后才能晋级。

## 本机检查事实

2026-11-06，本机FFprobe读取黄仁勋原视频：VP9、1920×1080；音轨为Opus、48kHz、双声道。容器时长2806.061秒，文件1,175,308,951字节。目标PCM16参考为44,896,597样本/89,793,194字节，SHA256 `c42d69c8317656aae25a3edbd9ee8c9df402b07c89bbad4b2ce195a92e7e93bd`。

本机FFmpeg编译列表有cuda硬件接口与h264_nvenc/hevc_nvenc编码器。h264_nvenc帮助列出P1–P7等预设；这不证明已成功初始化本机硬件编码。Opus解码器帮助列出无内部线程能力。此检查没有调用GPU模型或执行硬件编解码。

视频转逐字稿时，`-map 0:a:0 -vn`只选择音轨，无需解码VP9画面。NVDEC不应被当作Opus/AAC音轨解码加速器；额外解码无用画面会占用资源。要优化的是首次音频准备、连续分段和GPU模型调用之间的等待。

## API与不变量

```js
const {openPcmPipeline} = require('./src/speech/pcm-pipeline.cjs');
const audio = await openPcmPipeline({
  source, cacheFile: output + '/audio.s16le',
  markerFile: output + '/audio-source.json',
  sourceIdentity, ffmpeg, chunkSamples: 30 * 16000, signal,
});
try {
  // 此时FFmpeg已开始工作；模型warmup可并行启动，仍由既有GPU lease串行保护。
  await speech.probe({signal});
  for await (const part of audio) {
    // part={index,startSample,samples,pcm16}; Float32转换与CUDA识别留给原算子。
    await recognizeOnGpu(part);
  }
  const cache = await audio.completion;
} finally { await audio.close(); }
```

整个输入仅启动一次FFmpeg，以stdout连续输出16kHz/单声道/PCM16；先完整写入磁盘spool，再允许读取对应字节。首个30秒块写完即可识别，后续音频仍在准备。FFmpeg输出使用stream背压逐块写入；消费者慢时积压保存在文件里，不建立整片PCM的RAM队列。消费块大小可配置，尾段保持精确样本数。

最终缓存仅在FFmpeg退出0、样本为完整PCM16、原文件size/mtime未变后发布。解码失败或中断保留唯一`.partial`，不能产生成功marker，上一份有效缓存不受解码失败影响。数据与marker分别原子发布，不宣称两个文件是一笔原子事务；若数据发布后marker写入失败，调用仍失败，之后须重新核验identity/长度/SHA，不能当作已完成缓存复用。读取与原子rename有磁盘操作队列，避免Windows对未关闭读句柄的rename失败。

缓存自身使用独立filesystem lease，避免同路径两个生产者互相覆盖；此lease的root与GPU资源root不同，不占用CUDA队列。`completion`只表示音频缓存完成，不表示逐字稿完成。若循环正常结束或提前break，iterator自动释放；若创建后不消费，调用者必须在finally执行close。

## 验证与计时

`node --test tests/speech-pcm-pipeline.test.mjs`覆盖真实子进程的任意字节边界、先首块后完成、慢消费者、非零退出、奇数尾字节、取消、缓存校验、失败替换保留旧缓存、消费提前结束与并发缓存互斥。

可由主GPU队列在合适时间单独运行CPU音频准备探针：

```powershell
node scripts/probe-pcm-pipeline.mjs "原视频绝对路径" "全新诊断输出目录" "ffmpeg绝对路径" "c42d69c8317656aae25a3edbd9ee8c9df402b07c89bbad4b2ce195a92e7e93bd"
```

探针没有加载ASR模型；其结果不能当GPU转写性能。实际流水线需分别记录冷任务开始、首块就绪、模型就绪、首次GPU识别、最终逐字稿完成。原194.092秒榜单是engine-ready→complete，准备阶段提速应单列端到端时间，不能混算百分比。

## 真正需要视频格式转换时

1. 先检查目标播放器接受哪些容器与codec。若原VP9/Opus已可播放，直接使用原文件；若仅容器不合适且目标接受原codec，可remux/stream-copy，避免重编码和画质损失。
2. 需要H.264/AAC兼容格式时，可由统一GPU队列先短测`h264_nvenc`，再比较软件路径的时长、文件大小、音画时长、帧数和视觉质量。P1更快但质量较低，不能只比速度；码率上限/质量参数需以实际输出验证。
3. VP9→H.264的NVDEC+NVENC已在本机完成2806秒整片硬件验证，端到端384.481秒，但CQ19输出比VP9源更大，不能据此声称压缩有效。NVENC虽使用专用硬件，同卡的显存、带宽和功耗仍与ASR共享；继续由同一GPU队列顺序执行。

此处不承诺50%/60%的收益，也没有将硬件编码候选设为生产默认。

## Native30流水线实验入口

`src/speech/gpu-pipelined-file.cjs`实现与`transcribeGpuFile`相同的调用/结果接口，且只接受Native、FP16、单实例greedy路径。它使用原`providerFor`与GPU lease，未复制或修改神经计算实现。新增`audioFactory`注入仅用于契约测试；生产默认调用上面的真实PCM spool。

启动顺序为：启动音轨decode及首块Promise → 等待GPU lease → 模型probe → 模型与首块都ready后记录raw start → 逐块GPU识别与检查点 → 核对解码成功及所有样本 → 输出成功结果。即使GPU已处理前缀，后续FFmpeg失败也不会生成成功结果。检查点identity包含独立pipeline版本，不与原full-predecode路径混用。

`metrics.json`记录coldTaskStarted、audioStarted、firstChunkReady、gpuQueueStarted/gpuAcquired、modelReady、audioComplete、completed、resourcesReleased、waitQueueSeconds、recognitionSeconds、endToEndSeconds和endToEndIncludingCleanupSeconds。缓存复用时，audioComplete指本次校验就绪时间；原缓存建立时间单独记audioCacheCompletedAt。raw start只在model-ready和首块-ready之后写入，其后可能包含等待后续音轨；必须连同端到端时间一起比较。

入口测试：`node --test tests/speech-gpu-pipelined-file.test.mjs`。测试以真实子进程输出PCM、mock神经提供器，验证GPU首请求先于整音轨decode完成、精确尾段、解码后续失败/取消无complete，以及CPU/其他神经路径拒绝。

2026-11-06 真正GPU配对整片验收已另行完成两组，PCM和最终文本均与Native30参考完全一致，无模型错误/恢复。对照含审查任务245.791/257.188秒，流水线243.357/254.060秒，仅约1.106%降幅。原state把含审查的计时误标成API纯返回，最新榜单已注明真实范围，原始state保留。交付包提供显式 `profile:'native30-streaming'` 可调用入口；默认winner不变。源证据为 `experiments/runs-2026-11-06T11-23-44-846Z/state.json`。
