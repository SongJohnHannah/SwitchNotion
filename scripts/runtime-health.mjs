import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export async function waitForRuntime({ root, pid, timeoutMs = 15000, requireVisibleWindow = false, onObservation = () => {}, fetchImpl = fetch, delay = sleep, alive = id => { try { process.kill(id, 0); return true; } catch { return false; } } }) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const end = Date.now() + timeoutMs;
  let activationAttempts = 0, nextActivation = 0;
  while (Date.now() < end) {
    if (!alive(pid)) { onObservation({ state: 'process-exited', pid }); return false; }
    try {
      const info = JSON.parse(fs.readFileSync(path.join(root, 'control.json'), 'utf8'));
      if (info.pid === pid) {
        const response = await fetchImpl(`http://127.0.0.1:${info.port}/status`, { headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(750) });
        if (response.ok) {
          const status = await response.json();
          onObservation({ state: 'status', pid, reportedPid: status.pid, ready: !!status.appReady,
            windows: status.windows?.map(window => ({ visible: window.visible, minimized: window.minimized, destroyed: window.destroyed })) });
          if (status.pid === pid && status.appReady && status.windows?.length) {
            if (!requireVisibleWindow || status.windows.some(window => window.visible === true && !window.destroyed)) return true;
            if (activationAttempts < 3 && Date.now() >= nextActivation) {
              activationAttempts++; nextActivation = Date.now() + 500;
              await fetchImpl(`http://127.0.0.1:${info.port}/notion/open`, { method: 'POST',
                headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(1500) });
            }
          }
        }
      } else onObservation({ state: 'control-pid-mismatch', pid, reportedPid: info.pid });
    } catch (error) { onObservation({ state: 'control-unreachable', pid, code: error.cause?.code || error.code || error.name }); }
    await delay(200);
  }
  return false;
}
