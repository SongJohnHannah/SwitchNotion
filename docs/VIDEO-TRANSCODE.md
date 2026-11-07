# GPU视频重编码 helper

入口：`src/speech/video-transcode.cjs`，导出`transcodeVideo`与`nvencEncodingArgs`。2026-11-06 已完成同一采访的整片硬件验证：VP9 NVDEC → H.264 NVENC，1920×1080、2806.037秒；端到端384.481秒，其中编码378.967秒。证据在交付目录 `tests/video-2026-11-06T11-55-40-885Z/VERIFICATION.json`。这证明硬件路径能运行，未证明与CPU等画质相比快多少。

本次CQ19输出2,686,633,804字节，原片1,175,308,951字节，反而更大；收集入口会保留原片用于上传。另一次无重编码准备测试工作6.751秒，含完整payload/音轨指纹审查89.405秒；两类指纹均一致，见 `tests/video-copy-20261106-204826/result.json`。它不属于同画质压缩编码的加速百分比。

```js
const {transcodeVideo} = require('./src/speech/video-transcode.cjs');
const result = await transcodeVideo({
  source, outputDirectory, root: sharedOperatorResources,
  ffmpeg, ffprobe, quality: '1080p',
  hardwareDecode: true, signal, onProgress,
});
```

`quality`为`original|1080p|720p`。original表示保持输入画幅（奇数尺寸修为偶数），仍是有损重编码，不等于原文件或无损画质；原样保存、兼容容器的remux应继续使用原有stream-copy路线。1080p/720p不主动放大小片源，横竖屏分别适配目标长短边。

NVENC固定最小方案：H.264、p5/hq、VBR、CQ19、lookahead0，音轨映射全部源音轨并转AAC 192kbps。参数已在本机FFmpeg帮助中核对，不宣称CQ19等于libx264任何CRF画质。输出可能比高效VP9源更大，返回sourceBytes/outputToSourceRatio供实际判断，不承诺一定压小。

hardwareDecode=false为显式CPU视频解码+NVENC编码；true使用指定`*_cuvid`解码器、CUDA输出与scale_cuda，源编码无显式路径时停止。显式解码器是为了避免只写`-hwaccel cuda`后遇不支持编码而实际走软件解码。初始化失败、GPU错误及质量核验失败均保留错误并停止，不自动重试libx264或退CPU编码。HDR与旋转NVDEC路径目前未验证，遇到实际此类输入会保留原片并停止。

使用与ASR相同root的GPU lease，从编码前持有至FFmpeg完全退出及验证结束。默认runner隐藏启动所有子进程，取消/超时只结束拥有的进程树，等待close后才释放；不枚举或结束其他程序。测试注入的runImpl也必须遵守“返回前所属子进程已结束”的合同。

每次调用在outputDirectory下创建唯一记录目录，编码临时文件绝不使用原片路径。记录包含命令JSONL、完整stdout/progress与stderr、source/output探测JSON、failure或result、timing。只有输出MP4/H264/AAC、整片时长差<=0.5s、所有音轨数量/可取得的音轨时长、目标偶数画幅与显示宽高比通过后，才把唯一临时文件发布为output.mp4。这里没有把片段时间/元数据验证冒充人工逐帧画质检查。

`transcodeVideo`可选`forceKeyframeSeconds`，仅接受有限数值0.25–600秒；给出时增加`-force_key_frames expr:gte(t,n_forced*seconds) -forced-idr 1`并在result.nvenc中记录。`-forced-idr`已在本机h264_nvenc帮助确认；未给出时不改变默认关键帧策略。转码后可由调用方stream-copy分段，仍须核对每段和整体时长。

`nvencEncodingArgs({width,height,hardwareDecode,forceKeyframeSeconds})`也可给二次分段编码复用，仍需调用方取得同一GPU lease、保存日志并核对全部分段时长。它不会自动替换原stream-copy首选路线。

测试：`node --test tests/speech-video-transcode.test.mjs`。包括NVENC命令/全音轨映射、NVDEC失败无CPU编码回退、时长/尺寸/音轨核验、取消后释放次序，以及真实Node子进程的隐藏runner取消与日志保留。没有使用GPU模型或硬件编码器。
