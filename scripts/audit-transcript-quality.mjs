import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { auditRunQuality, assessBenchmarkSeries } = require('../src/speech/content-window-gate.cjs');

const args = process.argv.slice(2);
const values = {};
for (let index = 0; index < args.length; index++) {
  if (!args[index].startsWith('--') || !args[index + 1]) throw new Error('Expected --name value arguments');
  values[args[index].slice(2)] = args[++index];
}
let report;
if (values.series) {
  const spec = JSON.parse(await fs.readFile(values.series, 'utf8'));
  const base = path.dirname(path.resolve(values.series));
  const attempts = await Promise.all(spec.attemptReports.map(file => fs.readFile(path.resolve(base, file), 'utf8').then(JSON.parse)));
  report = assessBenchmarkSeries({ ...spec, attempts });
} else {
  if (!values.reference || !values.candidate) throw new Error('Usage: node scripts/audit-transcript-quality.mjs --reference RUN_DIR --candidate RUN_DIR [--range 1470:1500] [--out REPORT.json]; or --series manifest.json');
  const range = values.range ? Object.fromEntries(values.range.split(':').map((value, index) => [index ? 'end' : 'start', Number(value)])) : undefined;
  report = await auditRunQuality({ referenceDirectory: values.reference, candidateDirectory: values.candidate, range });
}
if (values.out) {
  await fs.mkdir(path.dirname(path.resolve(values.out)), { recursive: true });
  await fs.writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ status: report.status, anomalyCount: report.anomalyCount,
  identityIssues: report.identityIssues, runtimeStatus: report.runtimeStatus,
  out: values.out ? path.resolve(values.out) : undefined,
  ...(!values.out ? { report } : {}) }));
if (!['pass', 'eligible'].includes(report.status)) process.exitCode = 2;
