import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadGpuImplementation } from './gpu-runtime-snapshot.mjs';
import { checkWhole120Coverage } from './check-whole120-coverage.mjs';
const require = createRequire(import.meta.url);
const { acquireGpuLease } = require('../src/speech/gpu-lease.cjs');
const bundle = path.resolve(process.argv[2] || 'D:/迅雷下载/notionSwitch/GPU转写算子');
const modes = (process.argv[3] || 'vad-on,vad-off').split(',');
if (modes.some(mode => !['vad-on', 'vad-off', 'vad-off-clips30', 'vad-off-no-timestamps'].includes(mode))) throw Error('Invalid diagnostic mode.');
const machine = JSON.parse(fs.readFileSync(path.join(bundle, 'machine.json')));
const root = path.join(bundle, machine.resourcesRoot);
const frozen = loadGpuImplementation({ root, cacheDirectory: path.join(bundle, 'experiments/implementations') });
const plan = frozen.normalizePlan(JSON.parse(fs.readFileSync(path.join(bundle, machine.profiles.native30.planFile))));
const runtime = { pythonExecutable: path.join(bundle, machine.pythonExecutable), modelDirectory: path.join(bundle, machine.modelDirectory),
  model: machine.model, platform: 'win32', architecture: 'x64', device: 'cuda', computeType: 'float16', cpuThreads: 4, dllDirectories: [] };
const pcm = fs.readFileSync(path.join(bundle, 'validation/round-1/audio.s16le'));
const sha = value => createHash('sha256').update(value).digest('hex');
if (sha(pcm) !== 'c42d69c8317656aae25a3edbd9ee8c9df402b07c89bbad4b2ce195a92e7e93bd') throw Error('Interview PCM changed.');
const directory = path.join(bundle, 'experiments/whole120-repair/probe-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(directory, { recursive: true });
const eventsFile = path.join(directory, 'raw-results.jsonl');
const state = { version: 1, source: machine.originalVideo, inputPcmSha256: sha(pcm), implementationRevision: frozen.revision,
  createdAt: new Date().toISOString(), scope: 'Selected original 120-second windows; NOT a full-video benchmark', cases: [], active: null };
const save = () => fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(state, null, 2));
const record = row => fs.appendFileSync(eventsFile, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', { flush: true });
const controller = new AbortController(); process.once('SIGINT', () => controller.abort(Error('Probe cancelled.')));
let lease, provider;
console.log(JSON.stringify({ event: 'probe-created', directory, implementationRevision: frozen.revision }));
try {
  lease = await acquireGpuLease({ root, signal: controller.signal, onWait: owner => console.log(JSON.stringify({ event: 'waiting-gpu', ownerPid: owner.pid })) });
  provider = frozen.providerFor({ root, runtime, plan }); provider.retain();
  await provider.probe({ signal: controller.signal });
  for (const mode of modes) for (const start of [0, 1440, 2160, 2640, 2760]) {
    const startSample = start * 16000, count = Math.min(120 * 16000, pcm.length / 2 - startSample);
    const source = new Int16Array(pcm.buffer, pcm.byteOffset + startSample * 2, count);
    const floats = new Float32Array(count); for (let i = 0; i < count; i++) floats[i] = source[i] / 32768;
    const audio = Buffer.from(floats.buffer);
    state.active = { mode, start, duration: count / 16000 }; save();
    record({ event: 'input', mode, startSample, samples: count, pcmFloat32Sha256: sha(audio) });
    console.log(JSON.stringify({ event: 'case-start', ...state.active }));
    const before = performance.now();
    let raw;
    const result = await provider.request('transcribe', { audio: audio.toString('base64'), language: 'en', context: '',
      decodingPolicy: 'stable-gpu-v1-window-diagnostic', diagnosticMode: mode }, controller.signal,
      value => { raw = value; record({ event: 'result', mode, startSample, samples: count, result: value }); });
    if (raw !== result || typeof result.text !== 'string' || !Number.isInteger(result.workerPid)) throw Error('Invalid GPU diagnostic result.');
    const name = `${mode}-${start}`;
    fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify({ ...result, sourceStartSeconds: start,
      sourceEndSeconds: start + count / 16000, absoluteSegments: result.segments.map(segment => ({ ...segment, start: segment.start + start, end: segment.end + start })) }, null, 2));
    const caseDirectory = path.join(directory, name); fs.mkdirSync(caseDirectory);
    fs.writeFileSync(path.join(caseDirectory, 'checkpoint.json'), JSON.stringify({ version: 1, totalSamples: count,
      sourceStartSeconds: start, completeVideo: false, parts: [{ index: 0, startSample: 0, samples: count,
        device: 'cuda', text: result.text, segments: result.segments }] }, null, 2));
    const coverage = checkWhole120Coverage({ directory: caseDirectory, offsetSeconds: start });
    fs.writeFileSync(path.join(caseDirectory, 'named-coverage.json'), JSON.stringify(coverage, null, 2));
    state.cases.push({ mode, start, samples: count, workerPid: result.workerPid, elapsedSeconds: (performance.now() - before) / 1000,
      textSha256: sha(result.text), resultFile: name + '.json', coverageStatus: coverage.status, failedChecks: coverage.failedChecks });
    state.active = null; save(); console.log(JSON.stringify({ event: 'case-complete', ...state.cases.at(-1) }));
  }
  state.complete = true; state.completedAt = new Date().toISOString(); save();
} catch (error) {
  state.error = error.message; state.workerStderr = provider?.stderrTail || ''; state.complete = false; save();
  record({ event: 'failed', error: error.message, workerStderr: state.workerStderr }); throw error;
} finally {
  await provider?.close(); await lease?.release();
  state.resourcesReleasedAt = new Date().toISOString(); save();
}
