import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { transcribeGpuFile } = require('../src/speech/gpu-file.cjs');
const { CollectionBinaries } = require('../src/collection/binaries.cjs');
const [source, outputDirectory, planFile] = process.argv.slice(2);
if (!source || !outputDirectory) throw Error('用法：node scripts/transcribe-gpu.mjs <音视频绝对路径> <独立输出目录绝对路径> [方案 JSON]');
const root = path.resolve(import.meta.dirname, '../.notion-switch');
const ffmpeg = new CollectionBinaries({ root }).find('ffmpeg');
if (!ffmpeg) throw Error('未找到本机 FFmpeg，请先准备媒体处理组件。');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort(Error('已停止，检查点已保留。')));
const result = await transcribeGpuFile({ source: path.resolve(source), outputDirectory: path.resolve(outputDirectory), root, ffmpeg,
  plan: planFile ? JSON.parse(fs.readFileSync(path.resolve(planFile))) : undefined, signal: controller.signal,
  onProgress: event => console.log(JSON.stringify(event)) });
console.log(JSON.stringify({ complete: result.complete, device: result.device, duration: result.duration, transcriptFile: result.transcriptFile, eventsFile: result.eventsFile }));
