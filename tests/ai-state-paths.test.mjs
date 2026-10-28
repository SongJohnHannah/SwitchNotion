import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

for (const layout of ['app-support', 'project-mac-arm64']) test(`AI uploads, PDF resources and restored state use the explicit Unicode ${layout} profile from another cwd`, t => {
  const parent = path.resolve('.notion-switch'), base = fs.mkdtempSync(path.join(parent, 'test-ai-state-paths-'));
  t.after(() => { assert.equal(path.dirname(base), parent); fs.rmSync(base, { recursive: true, force: true }); });
  const cwd = path.join(base, '另一个 工作目录'), root = layout === 'app-support' ? path.join(base, '用户 甲', 'Library', 'Application Support', 'Switch Notion') : path.join(base, '用户 甲', '项目 空格', '.notion-switch', 'mac-arm64'); fs.mkdirSync(cwd);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./helpers/ai-state-paths.mjs', import.meta.url)), root], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16384 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim()); assert.equal(report.status, 'passed'); assert.equal(report.modelFixtureCalls, 3);
  assert.equal(report.explicitProfileLayout, layout);
  assert.equal(report.filesWrittenToCwd, 0); assert.equal(report.bundledPdfCmapLoaded, true);
});
