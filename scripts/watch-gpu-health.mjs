import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultDirectory = path.join(project, '.notion-switch/speech/gpu-v1');
const decodeXml = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const block = (xml, tag) => xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`))?.[1] || '';
const text = (xml, tag) => decodeXml(block(xml, tag).trim());
const number = value => { const result = Number.parseFloat(value.replace(/,/g, '')); return Number.isFinite(result) ? result : null; };

export function parseNvidiaXml(xml) {
  return [...xml.matchAll(/<gpu\b([^>]*)>([\s\S]*?)<\/gpu>/g)].map(([, attributes, gpu], index) => {
    const memory = block(gpu, 'fb_memory_usage');
    const utilization = block(gpu, 'utilization');
    const temperature = block(gpu, 'temperature');
    const power = block(gpu, 'gpu_power_readings') || block(gpu, 'power_readings');
    const raw = { gpuUtil: text(utilization, 'gpu_util'), memoryTotal: text(memory, 'total'),
      memoryUsed: text(memory, 'used'), memoryFree: text(memory, 'free'),
      temperature: text(temperature, 'gpu_temp'), power: text(power, 'instant_power_draw') || text(power, 'power_draw') || text(power, 'average_power_draw') };
    const pythonProcesses = [...block(gpu, 'processes').matchAll(/<process_info>([\s\S]*?)<\/process_info>/g)].map(([, process]) => ({
      pid: number(text(process, 'pid')), name: text(process, 'process_name'), type: text(process, 'type'),
      gpuMemoryMiB: number(text(process, 'used_memory')), rawGpuMemory: text(process, 'used_memory')
    })).filter(process => Number.isInteger(process.pid) && process.pid > 0 && /(?:^|[\\/])python(?:w)?(?:\d+(?:\.\d+)*)?\.exe$/i.test(process.name));
    return { index, busId: attributes.match(/\bid="([^"]+)"/)?.[1] || null, name: text(gpu, 'product_name'), uuid: text(gpu, 'uuid'),
      utilizationPercent: number(raw.gpuUtil), vramTotalMiB: number(raw.memoryTotal), vramUsedMiB: number(raw.memoryUsed), vramFreeMiB: number(raw.memoryFree),
      temperatureC: number(raw.temperature), powerW: number(raw.power), raw, pythonProcesses };
  });
}

function readQueue(stateFile) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const current = state.current, progress = current?.progress;
    return { stateFile, plan: current?.plan?.id || null, stage: progress?.stage || state.stage || null,
      index: progress?.index ?? null, totalChunks: progress?.totalChunks ?? null, seconds: progress?.seconds ?? null,
      totalSeconds: progress?.totalSeconds ?? null, startedAt: current?.startedAt || null, updatedAt: state.updatedAt || null,
      queuedPlans: state.queue?.length || 0, completedPlans: state.runs?.length || 0,
      outputDirectory: current?.outputDirectory || null };
  } catch (error) { return { stateFile, error: error.message }; }
}

function recentWorkerPid(outputDirectory) {
  if (!outputDirectory) return null;
  let fd;
  try {
    const file = path.join(outputDirectory, 'raw-results.jsonl'), size = fs.statSync(file).size;
    const bytes = Buffer.alloc(Math.min(65536, size)); fd = fs.openSync(file, 'r');
    fs.readSync(fd, bytes, 0, bytes.length, size - bytes.length);
    const lines = bytes.toString('utf8').split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index--) {
      try { const value = JSON.parse(lines[index]); if (Number.isInteger(value.workerPid) && value.workerPid > 0) return value.workerPid; } catch {}
    }
  } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

async function queryGpu() {
  // A new process/NVML handle each sample survives a previous TDR. No --loop.
  const result = await execFileAsync(process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi', ['-q', '-x'],
    { windowsHide: true, timeout: 4000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  return result.stdout;
}

async function queryPythonMemory(pids, workerPid) {
  if (process.platform !== 'win32' || !pids.length && !workerPid) return [];
  const gpuPids = pids.filter(pid => Number.isInteger(pid) && pid > 0);
  const related = workerPid && Number.isInteger(workerPid) ? workerPid : 0;
  const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference='Stop'
$gpuPids=@(${gpuPids.join(',')})
$workerPid=${related}
$pythonProcesses=@(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'")
$rows=@($pythonProcesses | Where-Object { $gpuPids -contains [int]$_.ProcessId -or $_.ProcessId -eq $workerPid -or $_.ParentProcessId -eq $workerPid } | ForEach-Object {
  $taskProcess=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  if ($taskProcess) { [PSCustomObject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;privateBytes=[double]$taskProcess.PrivateMemorySize64;workingSetBytes=[double]$taskProcess.WorkingSet64;gpuListed=($gpuPids -contains [int]$_.ProcessId)} }
})
ConvertTo-Json -InputObject $rows -Compress`;
  const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 4000, maxBuffer: 131072, encoding: 'utf8' });
  const value = JSON.parse(result.stdout.trim() || '[]');
  return Array.isArray(value) ? value : [value];
}

export async function sampleGpuHealth({ stateFile = path.join(defaultDirectory, 'queue-state.json'), gpuQuery = queryGpu, processQuery = queryPythonMemory } = {}) {
  const sampledAt = new Date().toISOString(), started = performance.now();
  const queue = readQueue(stateFile), workerPid = recentWorkerPid(queue.outputDirectory);
  const totalBytes = os.totalmem(), availableBytes = os.freemem();
  const record = { version: 1, sampledAt, host: { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes }, queue,
    recentWorkerPid: workerPid, gpus: [], pythonProcesses: [], errors: [] };
  try {
    record.gpus = parseNvidiaXml(await gpuQuery());
    if (!record.gpus.length) record.errors.push({ stage: 'gpu-query', error: 'No GPU elements in nvidia-smi XML' });
  } catch (error) { record.errors.push({ stage: 'gpu-query', error: error.message, code: error.code || null, stderr: error.stderr?.slice(-1000) || '' }); }
  const pids = [...new Set(record.gpus.flatMap(gpu => gpu.pythonProcesses.map(process => process.pid)))];
  try { record.pythonProcesses = await processQuery(pids, workerPid); }
  catch (error) { record.errors.push({ stage: 'python-memory', error: error.message, code: error.code || null, stderr: error.stderr?.slice(-1000) || '' }); }
  record.pythonPidsNotObserved = pids.filter(pid => !record.pythonProcesses.some(process => process.pid === pid));
  record.completedAt = new Date().toISOString(); record.sampleDurationMs = Math.round(performance.now() - started);
  return record;
}

async function main(args) {
  const options = { interval: 5000, once: false, untilIdle: false, stateFile: path.join(defaultDirectory, 'queue-state.json'), out: path.join(defaultDirectory, 'health.jsonl') };
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--once') options.once = true;
    else if (value === '--until-queue-idle') options.untilIdle = true;
    else if (value === '--interval') options.interval = Number(args[++index]);
    else if (value === '--state') options.stateFile = path.resolve(args[++index]);
    else if (value === '--out') options.out = path.resolve(args[++index]);
    else throw Error('Unknown GPU health option: ' + value);
  }
  if (!Number.isInteger(options.interval) || options.interval < 5000 || options.interval > 60000) throw Error('Health sample interval must be 5000..60000 ms');
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  const stopFile = path.join(path.dirname(options.out), 'HEALTH-STOP'), lockFile = options.out + '.lock';
  let stopped = false, ownsLock = false;
  if (!options.once) {
    try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' }); ownsLock = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse(fs.readFileSync(lockFile));
      try { process.kill(owner.pid, 0); throw Error('GPU health monitor already running: ' + owner.pid); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; fs.unlinkSync(lockFile); fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), { flag: 'wx' }); ownsLock = true; }
    }
  }
  process.once('SIGINT', () => { stopped = true; }); process.once('SIGTERM', () => { stopped = true; });
  let next = Date.now();
  try {
    do {
      if (fs.existsSync(stopFile) || stopped) break;
      const record = await sampleGpuHealth({ stateFile: options.stateFile });
      record.intervalMs = options.interval;
      const line = JSON.stringify(record) + '\n'; fs.appendFileSync(options.out, line); process.stdout.write(line);
      if (options.once || options.untilIdle && !record.queue.plan && record.queue.queuedPlans === 0) break;
      next += options.interval;
      if (next < Date.now()) next = Date.now() + options.interval;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, next - Date.now())));
    } while (!stopped);
  } finally { if (ownsLock) { try { if (JSON.parse(fs.readFileSync(lockFile)).pid === process.pid) fs.unlinkSync(lockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; } } }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
