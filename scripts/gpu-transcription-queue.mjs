import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGpuQueue } from './gpu-queue-core.mjs';
export * from './gpu-queue-core.mjs';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('用法：node scripts/gpu-transcription-queue.mjs <queue-input.json>');
  await runGpuQueue({ inputFile: path.resolve(process.argv[2]) });
}
