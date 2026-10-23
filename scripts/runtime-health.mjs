import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export async function waitForRuntime({ root, pid, timeoutMs = 15000, fetchImpl = fetch, delay = sleep, alive = id => { try { process.kill(id, 0); return true; } catch { return false; } } }) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!alive(pid)) return false;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(root, 'control.json'), 'utf8'));
      if (info.pid === pid) {
        const response = await fetchImpl(`http://127.0.0.1:${info.port}/status`, { headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(750) });
        if (response.ok) { const status = await response.json(); if (status.pid === pid && status.appReady && status.windows?.length) return true; }
      }
    } catch {}
    await delay(200);
  }
  return false;
}
