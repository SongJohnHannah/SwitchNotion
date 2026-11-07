import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OperatorSessionClient } = require('../src/speech/operator-session-client.cjs');
const { writeAtomicJson } = require('../src/speech/atomic-json.cjs');
const { auditRunQuality } = require('../src/speech/content-window-gate.cjs');
const bundle = path.resolve(process.argv[2] || 'D:/迅雷下载/notionSwitch/GPU转写算子');
const referenceDirectory = path.join(bundle, 'validation/round-1');
const source = JSON.parse(fs.readFileSync(path.join(referenceDirectory, 'result.json')));
const bytes = fs.readFileSync(path.join(referenceDirectory, 'audio.s16le'));
const sha = value => createHash('sha256').update(value).digest('hex');
if (bytes.length / 2 !== 44896597 || sha(bytes) !== 'c42d69c8317656aae25a3edbd9ee8c9df402b07c89bbad4b2ce195a92e7e93bd') throw Error('完整采访输入不一致。');
const outputDirectory = path.join(bundle, 'tests/live-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(outputDirectory, { recursive: true }); fs.copyFileSync(path.join(referenceDirectory, 'audio.s16le'), path.join(outputDirectory, 'audio.s16le'));
const eventsFile = path.join(outputDirectory, 'raw-results.jsonl'), checkpointFile = path.join(outputDirectory, 'checkpoint.json');
const record = row => fs.appendFileSync(eventsFile, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
const session = new OperatorSessionClient({ root: path.resolve(import.meta.dirname, '../.notion-switch'), directory: bundle });
const controller = new AbortController(); process.once('SIGINT', () => { controller.abort(Error('实时会话验收已取消。')); session.close(); });
const plan = session.getSession().plan;
const checkpoint = { version: 1, sourceIdentity: source.sourceIdentity, plan, language: 'en', policy: 'stable-gpu-v1-greedy', parts: [], totalSamples: bytes.length / 2 };
const totalChunks = Math.ceil(checkpoint.totalSamples / 480000);
session.retain();
console.log(JSON.stringify({ event: 'session-preparing', outputDirectory, status: session.status() }));
try {
  await session.configure(); await session.probe({ signal: controller.signal });
  record({ event: 'start', device: 'cuda', resumedChunks: 0, totalSamples: checkpoint.totalSamples, totalChunks,
    sourceIdentity: source.sourceIdentity, runtime: session.runtime, api: 'notionSwitch.OperatorSessionClient.transcribeDetailed' });
  for (let index = 0, startSample = 0; startSample < checkpoint.totalSamples; index++, startSample += 480000) {
    controller.signal.throwIfAborted();
    const samples = Math.min(480000, checkpoint.totalSamples - startSample), pcm = Buffer.alloc(samples * 4);
    for (let at = 0; at < samples; at++) pcm.writeFloatLE(bytes.readInt16LE((startSample + at) * 2) / 32768, at * 4);
    let raw;
    const result = await session.transcribeDetailed({ pcm, language: 'en', signal: controller.signal, onResult: value => { raw = value; } });
    if (!raw || raw.text !== result.text) throw Error('实时原始结果不一致。');
    record({ event: 'result', index, startSample, samples, device: 'cuda', workerPid: raw.workerPid, pcmSha256: sha(pcm), result: raw });
    checkpoint.parts.push({ index, startSample, samples, text: raw.text, device: 'cuda',
      segments: raw.segments.map(segment => ({ ...segment, start: segment.start + startSample / 16000, end: segment.end + startSample / 16000 })) });
    await writeAtomicJson(checkpointFile, checkpoint);
    if (index % 12 === 0) console.log(JSON.stringify({ event: 'progress', index, totalChunks, audioSeconds: startSample / 16000 }));
  }
  const text = checkpoint.parts.map(part => part.text.trim()).filter(Boolean).join('\n'), transcriptSha256 = sha(text);
  if (transcriptSha256 !== source.transcriptSha256) throw Error('实时整片原文与已验证Native30不一致，需要内容复核。');
  const transcriptFile = path.join(outputDirectory, 'transcript.txt'); fs.writeFileSync(transcriptFile, text + '\n');
  const result = { complete: true, device: 'cuda', policy: 'stable-gpu-v1-greedy', sourceIdentity: source.sourceIdentity,
    plan, totalSamples: checkpoint.totalSamples, duration: checkpoint.totalSamples / 16000, chunks: totalChunks,
    recoveries: 0, nativeExits: 0, text, transcriptSha256, transcriptFile, eventsFile, checkpointFile,
    sessionRecordDirectory: session.getSession().recordDirectory };
  fs.writeFileSync(path.join(outputDirectory, 'result.json'), JSON.stringify(result, null, 2));
  record({ event: 'complete', totalSamples: checkpoint.totalSamples, totalChunks, transcriptSha256 });
  const quality = await auditRunQuality({ referenceDirectory, candidateDirectory: outputDirectory });
  fs.writeFileSync(path.join(outputDirectory, 'quality-report.json'), JSON.stringify(quality, null, 2));
  if (quality.status !== 'pass' || quality.runtimeStatus !== 'pass') throw Error('实时整片质量验收未通过。');
  console.log(JSON.stringify({ event: 'complete', outputDirectory, transcriptSha256, quality: quality.status, runtime: quality.runtime }));
} catch (error) { record({ event: 'failed', error: error.message }); throw error; }
finally { await session.release(); await session.close(); }
