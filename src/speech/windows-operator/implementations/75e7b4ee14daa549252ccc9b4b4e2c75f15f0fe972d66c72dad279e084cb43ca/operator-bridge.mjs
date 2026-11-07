import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Local JSONL transport shared by non-Node callers. Neural inference remains
 * inside the single installed operator; this bridge never loads another model.
 */
export function startOperatorBridge({ input = process.stdin, output = process.stdout, operator,
  readCheckpoint = file => JSON.parse(fs.readFileSync(file, 'utf8')) } = {}) {
  const send = value => output.write(JSON.stringify(value) + '\n');
  const lines = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  const controller = new AbortController();
  let started = false, ended = false;
  return new Promise(resolve => {
    const stop = () => controller.abort(Error('已取消，检查点与原始记录已保留。'));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    function finish(code) {
      if (ended) return;
      ended = true; lines.close(); input.pause?.();
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); resolve(code);
    }
    async function dispatch(message) {
      try {
        if (!message || !['describe', 'transcribe'].includes(message.type)) throw Error('无法识别独立算子请求。');
        const api = operator || createRequire(import.meta.url)(path.join(import.meta.dirname, 'operator.cjs'));
        if (message.type === 'describe') { send({ event: 'description', result: api.describe() }); finish(0); return; }
        if (typeof message.source !== 'string' || typeof message.outputDirectory !== 'string') throw Error('独立算子需要输入文件和输出目录。');
        if (message.language !== undefined && !['auto', 'en', 'zh'].includes(message.language)) throw Error('转写语言无效。');
        if (message.allowExperimental !== undefined && typeof message.allowExperimental !== 'boolean') throw Error('实验开关无效。');
        const result = await api.transcribeFile({ source: message.source, outputDirectory: message.outputDirectory,
          ...(message.language !== undefined ? { language: message.language } : {}),
          ...(message.profile !== undefined ? { profile: message.profile } : {}),
          ...(message.allowExperimental === true ? { allowExperimental: true } : {}),
          signal: controller.signal, onProgress: value => send({ event: 'progress', ...value }) });
        if (result.complete !== true || result.device !== 'cuda') throw Error('独立算子未返回完整GPU结果，已停止。');
        const checkpoint = await readCheckpoint(result.checkpointFile);
        let samples = 0;
        if (!Array.isArray(checkpoint.parts) || !checkpoint.parts.length) throw Error('独立算子缺少完整检查点。');
        for (const [index, part] of checkpoint.parts.entries()) {
          if (part.index !== index || part.startSample !== samples || !Number.isSafeInteger(part.samples) || part.samples <= 0 || part.device !== 'cuda') throw Error('独立算子检查点音轨覆盖不完整。');
          samples += part.samples;
        }
        if (samples !== result.totalSamples) throw Error('独立算子未覆盖全部音频样本。');
        const segments = checkpoint.parts.flatMap(part => part.segments || []);
        if (segments.some(segment => !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end < segment.start || typeof segment.text !== 'string')) throw Error('独立算子时间戳无效。');
        send({ event: 'result', result: { ...result, model: api.describe().model, segments } }); finish(0);
      } catch (error) {
        const cancelled = controller.signal.aborted;
        send({ event: 'error', code: cancelled ? 'CANCELLED' : error.code || 'GPU_OPERATOR_FAILED', message: error.message });
        finish(cancelled ? 2 : 1);
      }
    }
    lines.on('line', line => {
      if (ended || !line.trim()) return;
      if (line.length > 1024 * 1024) { send({ event: 'error', code: 'INVALID_INPUT', message: '独立算子请求过大。' }); if (!started) finish(1); else stop(); return; }
      let message;
      try { message = JSON.parse(line); }
      catch { send({ event: 'error', code: 'INVALID_INPUT', message: '独立算子请求必须是JSON。' }); if (!started) finish(1); else stop(); return; }
      if (!started) { started = true; dispatch(message); }
      else if (message.type === 'cancel') stop();
      else { send({ event: 'error', code: 'BUSY', message: '此桥接进程已有转写任务。' }); }
    });
    lines.on('close', () => {
      if (!started && !ended) { send({ event: 'error', code: 'NO_INPUT', message: '没有独立算子请求。' }); finish(1); }
      else if (started && !ended) controller.abort(Error('调用方已断开，检查点与原始记录已保留。'));
    });
    lines.on('error', error => { if (started) controller.abort(error); else { send({ event: 'error', code: 'INPUT_ERROR', message: error.message }); finish(1); } });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await startOperatorBridge();
  // The bridge owns this one-request pipe. On Windows a paused, open parent
  // stdin can otherwise keep Node alive after the final JSON response. Let
  // stdout drain normally; do not use process.exit() to truncate a transcript.
  process.stdin.destroy();
}
