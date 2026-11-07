import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNvidiaXml, sampleGpuHealth } from '../scripts/watch-gpu-health.mjs';

const xml = `<nvidia_smi_log><gpu id="00000000:01:00.0"><product_name>RTX 2070</product_name><uuid>GPU-test</uuid>
<fb_memory_usage><total>16384 MiB</total><used>4500 MiB</used><free>11884 MiB</free></fb_memory_usage>
<bar1_memory_usage><used>256 MiB</used></bar1_memory_usage><utilization><gpu_util>74 %</gpu_util></utilization>
<temperature><gpu_temp>62 C</gpu_temp></temperature><gpu_power_readings><instant_power_draw>103.4 W</instant_power_draw></gpu_power_readings>
<processes><process_info><pid>321</pid><process_name>C:\\runtime\\python.exe</process_name><type>C</type><used_memory>N/A</used_memory></process_info>
<process_info><pid>999</pid><process_name>C:\\Chrome\\chrome.exe</process_name><type>G</type><used_memory>200 MiB</used_memory></process_info></processes>
</gpu></nvidia_smi_log>`;

test('health parser separates framebuffer memory from BAR1 and keeps unavailable process VRAM unknown', () => {
  const [gpu] = parseNvidiaXml(xml);
  assert.equal(gpu.vramUsedMiB, 4500); assert.equal(gpu.vramFreeMiB, 11884);
  assert.equal(gpu.utilizationPercent, 74); assert.equal(gpu.powerW, 103.4); assert.equal(gpu.temperatureC, 62);
  assert.deepEqual(gpu.pythonProcesses.map(process => process.pid), [321]);
  assert.equal(gpu.pythonProcesses[0].gpuMemoryMiB, null);
});

test('driver query unknown values are preserved instead of being reported as zero utilization', () => {
  const [gpu] = parseNvidiaXml(xml.replace('74 %', '[Unknown Error]').replace('11884 MiB', 'N/A'));
  assert.equal(gpu.utilizationPercent, null); assert.equal(gpu.vramFreeMiB, null);
  assert.equal(gpu.raw.gpuUtil, '[Unknown Error]');
});

test('health sampling collects host data even when a fresh GPU query fails', async () => {
  const record = await sampleGpuHealth({ stateFile: '/nonexistent-queue-state.json', gpuQuery: async () => { throw Error('NVML query failed'); }, processQuery: async () => [] });
  assert.ok(record.host.totalBytes > 0); assert.ok(record.host.availableBytes >= 0);
  assert.equal(record.gpus.length, 0); assert.equal(record.errors[0].stage, 'gpu-query');
});
