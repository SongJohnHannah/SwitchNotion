import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url), { MediaOcr } = require('../src/mediaocr.cjs'), { McpClient } = require('../src/mcp-client.cjs');
const options = {}, args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  if (!['--frames', '--out', '--workers', '--rounds'].includes(args[index]) || !args[index + 1]) throw Error('Use --frames DIRECTORY --out NEW_DIRECTORY [--workers 2,3] [--rounds 2]');
  options[args[index]] = args[index + 1];
}
if (!options['--frames'] || !options['--out']) throw Error('Frames and output directories are required.');
const directory = fs.realpathSync(options['--frames']), output = path.resolve(options['--out']);
const counts = [...new Set((options['--workers'] || '2,3').split(',').map(Number))], rounds = Number(options['--rounds'] || 2);
if (!counts.length || counts.some(value => ![1, 2, 3, 4].includes(value)) || ![1, 2].includes(rounds) || fs.existsSync(output)) throw Error('Use 1–4 workers, 1–2 rounds and a new output directory.');
const files = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && /\.(?:png|jpg|jpeg|webp)$/i.test(entry.name))
  .map(entry => path.join(directory, entry.name)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
if (!files.length) throw Error('No local images found.');
const fingerprint = () => { const hash = createHash('sha256'); for (const file of files) { hash.update(path.basename(file)); hash.update(fs.readFileSync(file)); } return hash.digest('hex'); };
const summary = { frames: files.length, workers: counts, rounds, inputFingerprint: fingerprint(), startedAt: new Date().toISOString(), runs: [] };
const controller = new AbortController(), signal = controller.signal;
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort(Error('Benchmark stopped: ' + name)));
fs.mkdirSync(output, { recursive: true });
const save = () => fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const log = event => { fs.appendFileSync(path.join(output, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'); console.log(JSON.stringify(event)); };
try {
  for (let round = 0; round < rounds; round++) for (const workers of round % 2 ? [...counts].reverse() : counts) {
    signal.throwIfAborted(); const pids = []; let active = 0, maximum = 0, session;
    const ocr = new MediaOcr({ root: path.resolve(import.meta.dirname, '../.notion-switch'), clientFactory: (config, clientOptions) => {
      const client = new McpClient(config, clientOptions), start = client.start.bind(client), request = client.request.bind(client);
      client.start = async () => { const pending = start(); pids.push(client.child.pid); return pending; };
      client.request = async (method, ...values) => {
        if (method === 'tools/call') { active++; maximum = Math.max(maximum, active); }
        try { return await request(method, ...values); } finally { if (method === 'tools/call') active--; }
      }; return client;
    } });
    log({ stage: 'start', round: round + 1, workers }); const started = performance.now(); let row;
    try {
      session = await ocr.openSession({ workers, signal }); const ready = performance.now();
      if (!session) throw Error('OCR is not prepared.');
      const texts = await session.recognizeMany(files, { signal }), completed = performance.now();
      const textFile = path.join(output, `ocr-r${round + 1}-${workers}.json`); fs.writeFileSync(textFile, JSON.stringify(texts, null, 2) + '\n');
      row = { round: round + 1, workers, frames: texts.length, elapsedSeconds: (completed - started) / 1000,
        recognitionSeconds: (completed - ready) / 1000, concurrentRequests: maximum, processesStarted: pids.length, textFile };
    } catch (error) { row = { round: round + 1, workers, error: error.message }; }
    finally { await session?.close(); }
    row.remainingOwnedLaunchers = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } });
    summary.runs.push(row); save(); log({ stage: row.error ? 'failed' : 'complete-run', ...row });
  }
  const baseline = summary.runs.find(row => !row.error);
  if (baseline) {
    const reference = JSON.parse(fs.readFileSync(baseline.textFile));
    for (const row of summary.runs.filter(row => !row.error)) row.differentFrames = JSON.parse(fs.readFileSync(row.textFile)).flatMap((text, index) => text === reference[index] ? [] : [index]);
  }
  summary.inputUnchanged = fingerprint() === summary.inputFingerprint; summary.completedAt = new Date().toISOString(); save();
  if (!summary.inputUnchanged || summary.runs.some(row => row.error || row.remainingOwnedLaunchers.length || row.differentFrames.length)) process.exitCode = 1;
  log({ stage: 'complete', summary: path.join(output, 'summary.json') });
} catch (error) { summary.error = error.message; save(); throw error; }
