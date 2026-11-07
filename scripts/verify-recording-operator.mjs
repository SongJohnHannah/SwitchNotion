import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { execute } = require('../src/speech/gpu-file.cjs');
const { OperatorSessionClient } = require('../src/speech/operator-session-client.cjs');
const bundle = path.resolve(process.argv[2] || 'D:/迅雷下载/notionSwitch/GPU转写算子');
const machine = JSON.parse(fs.readFileSync(path.join(bundle, 'machine.json')));
const directory = path.join(bundle, 'tests/recording-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(directory, { recursive: true });
const audioFile = path.join(directory, 'jensen-first-minute.webm');
// Preserve the original Opus packets; never re-encode a source just for ASR.
await execute(path.join(bundle, machine.ffmpeg), ['-hide_banner', '-loglevel', 'error', '-i', machine.originalVideo,
  '-t', '60', '-map', '0:a:0', '-vn', '-c:a', 'copy', '-y', audioFile]);
const session = new OperatorSessionClient({ root: path.resolve(import.meta.dirname, '../.notion-switch'), directory: bundle });
let raw;
console.log(JSON.stringify({ event: 'recording-waiting', directory }));
try {
  const before = performance.now();
  const text = await session.transcribeRecording({ audio: fs.readFileSync(audioFile), language: 'en', onResult: value => { raw = value; } });
  const samples = raw?.recordingDecode?.samples;
  if (!Number.isSafeInteger(samples) || samples < 59 * 16000 || samples > 61 * 16000 || !/^[a-f0-9]{64}$/.test(raw.recordingDecode.pcmSha256)) throw Error('Recording decode provenance is incomplete.');
  if (!text || /!{8,}/.test(text) || !Number.isInteger(raw.workerPid)) throw Error('Recording did not return a valid GPU transcript.');
  fs.writeFileSync(path.join(directory, 'raw-result.json'), JSON.stringify(raw, null, 2));
  fs.writeFileSync(path.join(directory, 'transcript.txt'), text + '\n');
  const report = { complete: true, api: 'OperatorSessionClient.transcribeRecording', device: 'cuda',
    timingIncludesGpuQueue: true, taskSeconds: (performance.now() - before) / 1000,
    language: raw.language, recordingDecode: raw.recordingDecode, workerPid: raw.workerPid,
    inputFile: audioFile, sessionRecordDirectory: session.getSession().recordDirectory,
    validationScope: 'First 60 seconds of source Opus, decoded from real WebM through recording API. Full PCM session validated separately; this is not a recording WER benchmark.' };
  fs.writeFileSync(path.join(directory, 'VERIFICATION.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  fs.writeFileSync(path.join(directory, 'VERIFICATION-FAILED.json'), JSON.stringify({ at: new Date().toISOString(), error: error.message, raw }, null, 2));
  throw error;
} finally { await session.close(); }
