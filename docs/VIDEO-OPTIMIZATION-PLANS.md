# 新视频优化候选：不覆盖已测版本

`src/speech/video-transcode-plan.cjs`为纯计划/参数builder；未改已测`video-transcode.cjs`，也未由本子任务运行任何GPU编码。全部计划status为unvalidated-experiment、visualQualityVerified=false，保留完整原参数、码率估算来源和指纹。

## 当前实测起点

现有GPU转码记录位于交付目录`tests/video-2026-11-06T11-55-40-885Z/video-transcode-2026-11-06T11-55-40-950Z-96be08cf-38ed-4024-92aa-f31e8a3a69a4`。

- 完整时长2806.037秒、1920×1080，NVDEC VP9→NVENC H264成功。
- p5/hq、CQ19、VBR但b:v=0、lookahead0、2秒强制IDR；同尺寸仍运行scale_cuda/Lanczos/passthrough=0。
- 端到端384.481秒，其中编码378.967秒；输出2,686,633,804字节，原片1,175,308,951字节，反而约2.286倍。
- 这一结果证明硬件路径可运行，不证明压缩有效；它也不是与CPU方案等画质比较所得的加速百分比。

若以384.481秒为完整转码基准，再降低50%/60%耗时分别要求<=192.2405秒/153.7924秒。目前没有本helper的新硬件实测支撑这两个结果。

## 候选及应分别验证的变量

| 改动 | 有根据的潜力 | 不可省略的检查 |
| --- | --- | --- |
| 有界VBR：1080p视频1.8Mbps，720p0.9Mbps，音轨每路192kbps；maxrate1.5×，bufsize2× | 避免CQ19让H264输出大于高效VP9源；主要改善文件大小与上传耗时 | 字节预测不是承诺；必须测实际码率、大小和与原片的画质 |
| p5→p3→p1，先保持码率/GOP/缩放一致 | 减少NVENC搜索/质量计算可能加快 | p1更快通常伴随画质代价，不称免费50%；同片段SSIM/VMAF与视觉复核 |
| 同尺寸直接CUDA/NVDEC→NVENC，跳过冗余scale_cuda | 避免每帧Lanczos处理与额外GPU帧搬运/分配 | 需要实际测试解码池/编码器帧持有、像素格式、整片时长/帧数 |
| 不需要分段时取消2秒强制IDR；需要时按附件字节预算取更长间隔 | 减少I帧频率、码率与编码开销 | 随机访问/分段仍须可用；不能为了变小而切掉帧或尾段 |
| 1080p→720p，GPU缩放可另比较Lanczos/双线性 | 分辨率/插值工作下降，有更大吞吐潜力 | 这是用户选择画质下降的路线，不能当“同画质”加速 |

建议控制变量顺序：p5+有界VBR+原GOP/原scale；再p3；再p1。另做p3+同尺寸跳过scale+按需求GOP的组合版本。一个版本通过不等于其他组合通过，晋级前保存全片稳定性与画质证据。

本片按文件平均码率估算总码率约3.351Mbps。当前计划1080p约705,696,281字节（原片60.0%），720p约386,857,600字节（32.9%）。该估算含1%封装余量、假设一路AAC192k；不是实际编码结果，也不代表达到相同视觉质量。

低码率片源若预测不到8%体积收益且不需缩放，建议保留原片或copy分段，避免再花数分钟生成更大的有损副本。

## 无重编码路径与项目证据

项目`src/collection/media.cjs`的prepareUpload已将`.mp4/.mov/.webm`视为无需转封装的扩展；不压缩且未超附件限制时直接返回原文件。超限制时先尝试`-c copy`分段。`src/collection/notion.cjs`明确把`.webm`映射为video/webm，媒体附件类型表也接受webm。

这证明原WebM已有“保留原文件”的应用路径。若目标仅是上传可播放而不要求H264兼容或压小，直接保留/复制分段不需6分钟编码；但网络上传总量仍约1.175GB，不能把省去编码时间当作上传链路已加快50%。分段还需核验全部时长、关键帧边界与Opus预滚/起始丢弃元数据。

代码中没有找到对`video/mp4; codecs="vp09…,opus"`的canPlayType/isTypeSupported或实际播放验收。MP4扩展名/MIME白名单并不能证明VP9+Opus在本机Notion Chromium已播放成功。因此VP9/Opus→MP4 stream-copy只列实验候选，默认返回needs-playback-validation；不能自动宣称它已适配Notion。

完整remux如需实测，应保留原片，使用唯一输出目录，`-map 0:v:0 -map 0:a? -c copy -movflags +faststart`，比较FFprobe codec/时长/音轨、每流压缩packet payload hash与音频解码PCM hash，再在实际Notion播放。容器元数据/时间戳变化不等于重新编码；哈希检查也不能替代目标播放器验证。本子任务未擅自在主GPU计时期间执行全片remux，以免磁盘争用污染结果。

## API

```js
const {buildVideoRatePlan, plannedNvencEncodingArgs, decideVideoCopyRoute} = require('./src/speech/video-transcode-plan.cjs');
const plan = buildVideoRatePlan({source,quality:'1080p',preset:'p3',hardwareDecode:true});
const args = plannedNvencEncodingArgs(plan);
// 仅由新的实验entry执行，保存plan与新的质量/速度结果；不能仍把结果标记成旧CQ19。
const route = decideVideoCopyRoute({source,uploadLimitBytes,requireMp4:false});
```

CPU测试：`node --test tests/speech-video-transcode-plan.test.mjs`。

## 单候选独立runner

`scripts/benchmark-video-optimization.mjs`每次只执行一个命名候选，共用独立包resources下的GPU lease作计时隔离；原样/copy/remux不调用GPU codec。它不会改动已验收的CQ19 helper默认值。NVENC实验分别保存新plan/指纹/码率，不冒称旧CQ19画质。

```powershell
node scripts/benchmark-video-optimization.mjs --bundle "D:\迅雷下载\notionSwitch\GPU转写算子" --source "原视频绝对路径" --out "全新输出目录" --candidate p3-1080p
node scripts/benchmark-video-optimization.mjs --bundle "D:\迅雷下载\notionSwitch\GPU转写算子" --source "原视频绝对路径" --out "另一个全新输出目录" --candidate remux-mp4
```

可选候选为copy-original、copy-webm、remux-mp4、p1/p3/p5-1080p、p1/p3/p5-720p；`--plan-only`只生成计划，不取得GPU lease/执行编码。`--force-keyframes`可显式控制GOP，`--limit-bytes`给字节预算。`--ffmpeg/--ffprobe`可传绝对路径。

把runner搬进独立包时，使用`--helpers`指向包含video-transcode-plan.cjs、video-transcode.cjs、gpu-lease.cjs、atomic-json.cjs的目录；`--bundle`负责查找machine.json/资源根/bin下FFmpeg，而不是猜其他项目路径。

每次输出目录必须不存在，保留命令JSONL、所有stdout/progress/stderr、源/输出probe、plan、timing以及result或failure。输出通过完整时长、所有音轨数/元数据时长、目标几何、codec和容器核验后才发布。copy/remux额外对比所有主视频/音轨压缩payload SHA，以及所有音轨解码成16k mono PCM16后的SHA；任一不符即content-review，不当作成功无损复制。源文件size/mtime也要保持未变。

NVENC结果始终visualQualityVerified=false，必须另外比较同一片段SSIM/VMAF与视觉内容；单轮文件核验不授予晋级资格。copy/remux的“省掉重编码”与“同画质压缩编码快多少”分开计时，MP4 VP9/Opus仍保留播放未验收标记。本子任务只做了runner CPU契约测试，没有执行任何实际大IO remux或GPU候选。

runner测试：`node --test tests/video-optimization-benchmark.test.mjs`。
