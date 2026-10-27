const path = require('node:path');
const { Worker } = require('node:worker_threads');
let worker, idle, sequence = 0; const pending = new Map();
function fail(active) {
  if (worker !== active) return;
  worker = null; clearTimeout(idle);
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject(Error('Unreviewed native client asset')); }
  pending.clear(); void active.terminate();
}
function getWorker() {
  if (worker) return worker;
  const active = new Worker(path.join(__dirname, 'worker.cjs'), { env: {}, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } });
  worker = active;
  active.on('error', () => fail(active)); active.on('exit', () => fail(active));
  active.on('message', result => {
    if (worker !== active) return;
    const job = pending.get(result.id); if (!job) return;
    pending.delete(result.id); clearTimeout(job.timer);
    result.ok ? job.resolve(result) : job.reject(Error('Unreviewed native client asset'));
    if (!pending.size) {
      active.unref(); idle = setTimeout(() => { if (worker === active && !pending.size) { worker = null; void active.terminate(); } }, 20000); idle.unref();
    }
  });
  return active;
}
function adaptInBackground(source, asset, options = {}) {
  if (typeof source !== 'string' || source.length > 2 * 1024 * 1024 || pending.size >= 8) return Promise.reject(Error('Unreviewed native client asset'));
  let active; try { active = getWorker(); } catch { return Promise.reject(Error('Unreviewed native client asset')); }
  clearTimeout(idle); active.ref(); const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(active), 30000);
    pending.set(id, { resolve, reject, timer });
    // Only public code, a loopback endpoint and booleans enter this worker.
    const input = { localSpeechEnabled: !!options.localSpeechEnabled, inputMode: options.inputMode || 'meeting', audioEndpoint: options.audioEndpoint };
    try { active.postMessage({ id, source, asset, options: input }); }
    catch { fail(active); }
  }).then(result => { for (const record of result.records) options.onAdaptation?.(record); return result.output; });
}
module.exports = { adaptInBackground };
