import fs from './native-fs.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import platformModule from '../src/platform/index.cjs';

const manifests = ['vendor/document-parser.manifest.json', 'vendor/web-parser.manifest.json'];
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const safeRelative = value => typeof value === 'string' && value.length < 512 && value.length > 0 &&
  !/[\\:\u0000-\u001f]/.test(value) && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..');

// Read-only. Reports disk synchronization separately from live process state.
// It does not prepare a runtime, read provider keys, or restart any application.
export async function checkAiRuntime({ projectDirectory = project, root, platform = platformModule.createDesktopPlatform(),
  fsImpl = fs, fetchImpl = fetch, env = process.env } = {}) {
  root ||= env.NOTION_SWITCH_ROOT || path.join(projectDirectory, '.notion-switch', ...(platform.id === 'darwin' ? ['mac-arm64'] : []));
  if (!path.isAbsolute(projectDirectory) || !path.isAbsolute(root)) throw Error('项目和资料目录必须为绝对路径。');
  const source = path.join(projectDirectory, 'src'), target = path.join(platform.runtimeLayout(path.join(root, 'runtime')).resources, 'notion-switch');
  const report = { platform: platform.id, scope: 'src-tree-and-bundled-resources', filesCompared: 0, identical: 0, changed: [], missing: [], invalidSource: [],
    runtimeRecordValid: false, runtimePlatformMatches: false, sourceAndDiskRuntimeMatch: false, control: { reachable: false },
    note: '只读磁盘对比不能证明当前进程已经加载这些文件，也不能替代原生 AI 控件验收。' };
  const readJson = (file, maximum) => {
    const stat = fsImpl.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw Error('Invalid local record');
    return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  };
  let prepared;
  try { prepared = readJson(path.join(root, 'prepared.json'), 65536); } catch {}
  report.runtimeRecordValid = !!prepared && typeof prepared === 'object' && !Array.isArray(prepared);
  report.runtimePlatformMatches = report.runtimeRecordValid && (prepared.platform === platform.id || prepared.platform === undefined && platform.id === 'win32');
  // The updater copies the entire src tree. Audit it rather than approving a
  // fixed list while an imported helper or newly added asset is still stale.
  const files = [];
  const visit = (directory, depth = 0) => {
    if (depth > 32) throw Error('Source nesting limit');
    for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), name = path.relative(source, file).split(path.sep).join('/');
      if (!safeRelative(name) || entry.isSymbolicLink()) report.invalidSource.push(name);
      else if (entry.isDirectory()) visit(file, depth + 1);
      else { files.push(name); if (files.length > 10000) throw Error('Source file count limit'); }
    }
  };
  try { visit(source); } catch { report.invalidSource.push('src'); }
  for (const manifest of manifests) {
    files.push(manifest);
    try {
      const items = readJson(path.join(source, manifest), 1024 * 1024);
      if (!Array.isArray(items) || items.length > 20) throw Error('Invalid manifest');
      const expanded = [];
      for (const item of items) {
        if (!/^[a-z][a-z\d-]{0,63}$/.test(item?.name || '') || !Array.isArray(item.files) || item.files.length > 2048) throw Error('Invalid manifest');
        for (const entry of item.files) {
          if (!safeRelative(entry?.file)) throw Error('Invalid manifest path');
          expanded.push(path.posix.join('vendor', item.name, entry.file));
        }
      }
      files.push(...expanded);
    } catch { report.invalidSource.push(manifest); }
  }
  for (const name of new Set(files)) {
    let original;
    try {
      const file = path.join(source, name), stat = fsImpl.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw Error('Invalid source');
      original = fsImpl.readFileSync(file);
    } catch { if (!report.invalidSource.includes(name)) report.invalidSource.push(name); continue; }
    report.filesCompared++;
    try {
      const file = path.join(target, name), stat = fsImpl.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw Error('Invalid runtime file');
      if (createHash('sha256').update(original).digest('hex') === createHash('sha256').update(fsImpl.readFileSync(file)).digest('hex')) report.identical++;
      else report.changed.push(name);
    } catch { report.missing.push(name); }
  }
  if (report.runtimePlatformMatches) try {
    const info = readJson(path.join(root, 'control.json'), 8192);
    if (!Number.isSafeInteger(info.port) || info.port < 1 || info.port > 65535 || !/^[a-f\d]{64}$/.test(info.token || '')) throw Error('Invalid control record');
    const response = await fetchImpl('http://127.0.0.1:' + info.port + '/status', { method: 'GET', headers: { authorization: 'Bearer ' + info.token }, signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (response.ok) {
      const value = await response.json();
      report.control = { reachable: true, appReady: value.appReady === true,
        activeTurns: Number.isSafeInteger(value.activeTurns) && value.activeTurns >= 0 ? value.activeTurns : null,
        unsupportedFrontendAssets: Array.isArray(value.compatibility?.unsupportedAssets) ? value.compatibility.unsupportedAssets.length : null };
    }
  } catch {}
  report.sourceAndDiskRuntimeMatch = report.runtimePlatformMatches && report.invalidSource.length === 0 && report.changed.length === 0 && report.missing.length === 0;
  report.ok = report.sourceAndDiskRuntimeMatch;
  if (!report.runtimeRecordValid) report.action = '隔离副本标记缺失或无法核对，请使用当前项目的正常启动入口。';
  else if (!report.runtimePlatformMatches) report.action = '此资料目录属于其他系统，请使用当前系统的独立资料目录。';
  else if (!report.ok) report.action = '磁盘运行副本尚未同步；保存页面并正常退出后，从原启动入口重新打开。';
  else report.action = '磁盘 AI 文件一致；继续核对本次启动和原生控件。';
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--root')) throw Error('Unknown arguments');
    const result = await checkAiRuntime({ ...(args.length ? { root: args[1] } : {}) }); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1;
  } catch { console.log(JSON.stringify({ ok: false, error: '只读检查未完成，请核对当前系统、项目和资料目录。' })); process.exitCode = 1; }
}
