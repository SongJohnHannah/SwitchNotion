import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const { openPcmPipeline } = require('../src/speech/pcm-pipeline.cjs');
const { CollectionBinaries } = require('../src/collection/binaries.cjs');
const [source, directory, executable, expectedSha256] = process.argv.slice(2);
if (!source || !directory || !path.isAbsolute(source) || !path.isAbsolute(directory)) throw Error('用法：node scripts/probe-pcm-pipeline.mjs <源音视频绝对路径> <全新输出目录绝对路径> [ffmpeg绝对路径] [预期PCM16 SHA256]');
if (fs.existsSync(directory)) throw Error('为保证独立测试，输出目录必须是全新目录。');
fs.mkdirSync(directory, { recursive: true });
const ffmpeg = executable || new CollectionBinaries({ root: path.resolve(import.meta.dirname, '../.notion-switch') }).find('ffmpeg');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort(Error('已停止，未完成缓存不会标为成功。')));
const start = performance.now(), pipeline = await openPcmPipeline({ source, cacheFile: path.join(directory, 'audio.s16le'),
  markerFile: path.join(directory, 'audio-source.json'), ffmpeg, signal: controller.signal });
const hash = createHash('sha256'); let samples = 0, chunks = 0, firstChunkMs;
try {
  for await (const chunk of pipeline) {
    if (chunk.index !== chunks || chunk.startSample !== samples || chunk.pcm16.length !== chunk.samples * 2) throw Error('流水线样本位置或长度不连续。');
    firstChunkMs ??= performance.now() - start;
    hash.update(chunk.pcm16); samples += chunk.samples; chunks++;
  }
  const prepared = await pipeline.completion, measuredSha = hash.digest('hex');
  if (measuredSha !== prepared.pcmSha256 || prepared.totalSamples !== samples) throw Error('消费者读到的音频与完整缓存不一致。');
  if (expectedSha256 && measuredSha !== expectedSha256) throw Error('流水线PCM与已验证音轨不一致。');
  const report = { version: 1, measuredAt: new Date().toISOString(), kind: 'audio-preparation-only-no-model-or-gpu',
    source, ffmpeg, firstChunkMs, totalMs: performance.now() - start, chunks, samples, pcmSha256: measuredSha,
    expectedSha256: expectedSha256 || null, expectedMatches: expectedSha256 ? measuredSha === expectedSha256 : null, prepared };
  fs.writeFileSync(path.join(directory, 'preparation-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await pipeline.close(); }
