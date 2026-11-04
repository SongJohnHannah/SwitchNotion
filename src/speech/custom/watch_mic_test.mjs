import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.join(repo, '.notion-switch');
const eventsFile = path.join(root, 'events.jsonl');
const stderrFile = path.join(root, 'desktop-stderr.log');
const outFile = path.join(root, process.env.WATCH_LOG || 'mic-only-watch.log');
const waitMinutes = Number(process.env.WAIT_MINUTES || 20);
const runMinutes = Number(process.env.RUN_MINUTES || 12);
const started = Date.now();
const log = line => {
  const text = `${new Date().toISOString()} ${line}`;
  fs.appendFileSync(outFile, text + '\n');
};

function eventHasConnectionSince(since) {
  try {
    const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const value = JSON.parse(lines[i]);
      if (value.type === 'offline-audio-connected' && new Date(value.time).getTime() >= since) return value;
      if (new Date(value.time).getTime() < since - 60000) break;
    }
  } catch {}
  return null;
}

async function main() {
  log(`watcher start wait=${waitMinutes}m run=${runMinutes}m`);
  let connected = null;
  while (Date.now() - started < waitMinutes * 60000) {
    connected = eventHasConnectionSince(started);
    if (connected) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (!connected) { log('no recording started within wait window'); return; }
  const recordStart = new Date(connected.time).getTime();
  log(`recording connected at ${connected.time}`);
  let stderrOffset = fs.statSync(stderrFile).size;
  let eventOffset = fs.statSync(eventsFile).size;
  const counts = {};
  const bump = key => { counts[key] = (counts[key] || 0) + 1; };
  const end = recordStart + runMinutes * 60000;
  while (Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 20000));
    const now = Date.now();
    try {
      const stat = fs.statSync(eventsFile);
      if (stat.size > eventOffset) {
        const fd = fs.openSync(eventsFile, 'r'); const buffer = Buffer.alloc(stat.size - eventOffset);
        fs.readSync(fd, buffer, 0, buffer.length, eventOffset); fs.closeSync(fd);
        eventOffset = stat.size;
        for (const line of buffer.toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          try { const value = JSON.parse(line); if (new Date(value.time).getTime() >= recordStart) bump(value.type); } catch {}
        }
      }
      const stderrStat = fs.statSync(stderrFile);
      if (stderrStat.size > stderrOffset) {
        const length = Math.min(stderrStat.size - stderrOffset, 2 * 1024 * 1024);
        const fd = fs.openSync(stderrFile, 'r'); const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, stderrStat.size - length); fs.closeSync(fd);
        stderrOffset = stderrStat.size;
        const text = buffer.toString('utf8');
        for (const key of ['sendAudioDataFailed', 'ERR_INSUFFICIENT_RESOURCES', 'failedToGetAudioProcessorToken', 'dictationFailedToStart', 'requestTimeout']) {
          const matches = text.split(key).length - 1;
          if (matches) counts[key] = (counts[key] || 0) + matches;
        }
      }
      log(`elapsed=${Math.round((now - recordStart) / 1000)}s counts=${JSON.stringify(counts)}`);
    } catch (error) { log(`sample failed: ${error.message}`); }
  }
  log(`final counts=${JSON.stringify(counts)}`);
}

await main();
