import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { GpuOperatorClient } = require('../src/speech/operator-client.cjs');
const bundle = path.resolve(process.argv[2] || 'D:/迅雷下载/notionSwitch/GPU转写算子');
const machine = JSON.parse(fs.readFileSync(path.join(bundle, 'machine.json')));
const outputDirectory = path.join(bundle, 'tests/video-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(outputDirectory, { recursive: true });
const client = new GpuOperatorClient({ root: path.resolve(import.meta.dirname, '../.notion-switch'), directory: bundle, assetsDirectory: bundle });
const controller = new AbortController(); process.once('SIGINT', () => controller.abort(Error('GPU视频验收已停止。')));
let next = 0;
try {
  const result = await client.transcodeVideo({ source: machine.originalVideo, outputDirectory, quality: '1080p', hardwareDecode: true,
    forceKeyframeSeconds: 2, signal: controller.signal, onProgress: event => {
      if (event.stage !== 'transcoding' || event.seconds >= next) { console.log(JSON.stringify(event)); next = (event.seconds || 0) + 120; }
    } });
  fs.writeFileSync(path.join(outputDirectory, 'VERIFICATION.json'), JSON.stringify({ fullOriginalVideo: true, ...result }, null, 2));
  console.log(JSON.stringify({ complete: true, duration: result.duration, engine: result.engine, decodeEngine: result.decodeEngine,
    output: result.path, bytes: result.bytes, sourceBytes: result.sourceBytes, timing: result.timing, verification: result.verification }));
} catch (error) {
  fs.writeFileSync(path.join(outputDirectory, 'VERIFICATION-FAILED.json'), JSON.stringify({ error: error.message, at: new Date().toISOString() }, null, 2));
  console.error(error.stack); process.exitCode = 1;
}
