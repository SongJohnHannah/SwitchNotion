import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runMetrics, writeTimeline } from './gpu-queue-core.mjs';
const require = createRequire(import.meta.url);
const { normalizePlan } = require('../src/speech/gpu-file.cjs');
export function submitCommand(directory, command) {
  const inbox = path.join(directory, 'inbox'); fs.mkdirSync(inbox, { recursive: true });
  const id = randomUUID(), file = path.join(inbox, id + '.json'), temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, id, createdAt: new Date().toISOString(), ...command }, null, 2), { flush: true });
  fs.renameSync(temporary, file); return { id, file };
}
export function controlQueue(args) {
  const [inputFile, action, ...rest] = args;
  if (!inputFile || !['submit', 'revise', 'prioritize', 'stop', 'status', 'resume', 'timeline'].includes(action)) throw Error('用法：node scripts/gpu-queue-control.mjs <queue-input.json> submit <plan.json> [--reason 依据]；另支持 revise <旧ID> <plan.json>、prioritize <方案ID>、status、stop、resume、timeline。');
  const directory = path.dirname(path.resolve(inputFile));
  if (action === 'status') return JSON.parse(fs.readFileSync(path.join(directory, 'queue-state.json')));
  if (action === 'timeline') {
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'queue-state.json')));
    const runs = [...state.runs, ...(state.current ? [{ ...state.current, active: true }] : [])].map(run => ({ ...run, metrics: runMetrics(run, { directory }) }));
    writeTimeline(directory, runs);
    return { file: path.join(directory, 'TIMELINE.md'), runs: runs.map(run => ({ id: run.plan.id, active: !!run.active, passed: run.passed, metrics: run.metrics })) };
  }
  if (action === 'resume') { const stop = path.join(directory, 'STOP'); if (fs.existsSync(stop)) fs.unlinkSync(stop); return { resumed: true, note: '已清除停止标记；若队列进程已退出，需重新隐藏启动。' }; }
  if (action === 'stop') return submitCommand(directory, { action: 'stop', reason: rest.join(' ') });
  if (action === 'prioritize') { if (!rest[0]) throw Error('缺少待优先的方案 ID。'); return submitCommand(directory, { action, planId: rest[0], reason: rest.slice(1).join(' ') || '优先复验单轮最快方案' }); }
  const replaces = action === 'revise' ? rest.shift() : undefined, file = rest.shift();
  if (!file || action === 'revise' && !replaces) throw Error('缺少方案 JSON 文件或待替换 ID。');
  const reasonAt = rest.indexOf('--reason'), reason = reasonAt >= 0 ? rest.slice(reasonAt + 1).join(' ') : '提交新 GPU 执行路径';
  return submitCommand(directory, { action, ...(replaces ? { replaces } : {}), plan: normalizePlan(JSON.parse(fs.readFileSync(path.resolve(file)))), reason });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(controlQueue(process.argv.slice(2)), null, 2));
