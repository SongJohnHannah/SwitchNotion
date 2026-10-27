import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stageMac } from './package-macos.mjs';
import { assertDistributionFiles, localDeepSeekKeys } from './package-safety.mjs';
const project = path.resolve(import.meta.dirname, '..');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function tree(root) {
  const result = [];
  function visit(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name); if (item.isSymbolicLink()) throw Error('启动文件夹含链接，未替换。');
    if (item.isDirectory()) visit(file); else result.push({ file: path.relative(root, file).replaceAll('\\', '/'), sha256: hash(file) });
  } } visit(root); return result.sort((a, b) => a.file.localeCompare(b.file));
}
export function prepareRootLaunchers({ sourceProject = project, host = process.platform,
  nodeExecutable = fs.existsSync(path.join(sourceProject, 'bin/node.exe')) ? path.join(sourceProject, 'bin/node.exe') : process.execPath,
  nodeLicense = path.resolve(nodeExecutable) === path.resolve(sourceProject, 'bin/node.exe') ? path.join(sourceProject, 'licenses/NODE-LICENSE.txt') : path.join(path.dirname(nodeExecutable), 'LICENSE'), compile } = {}) {
  const root = fs.realpathSync(sourceProject), state = path.join(root, '.notion-switch'), dist = path.join(root, 'dist');
  for (const dir of [state, dist]) if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('启动准备目录含链接，未生成。');
  fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(dist, { recursive: true });
  const staging = fs.mkdtempSync(path.join(dist, '.root-launchers-'));
  const app = path.join(root, 'Switch Notion.app'), exe = path.join(root, 'Switch Notion.exe'), registry = path.join(state, 'root-launchers.json');
  const safe = target => {
    const relative = path.relative(root, path.resolve(target));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('启动入口位置不在项目内。');
    for (let current = target; current !== root; current = path.dirname(current)) if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('启动入口位置含链接。');
  };
  let saved; try { saved = JSON.parse(fs.readFileSync(registry, 'utf8')); } catch {}
  safe(app); safe(exe); safe(path.join(root, 'bin/node.exe')); safe(path.join(root, 'licenses/NODE-LICENSE.txt'));
  if (fs.existsSync(app) && JSON.stringify(tree(app)) !== JSON.stringify(saved?.appFiles)) throw Error('根目录已有其他或被修改过的 Mac 应用，已保留，未覆盖。');
  const prepared = stageMac({ sourceProject: root, destination: path.join(staging, 'mac'), projectAware: true });
  const keys = localDeepSeekKeys(root);
  if (host === 'win32') {
    const built = path.join(staging, 'Switch Notion.exe');
    if (compile) compile(built);
    else execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/compile-launcher.ps1'), '-Source', path.join(root, 'scripts/windows-launcher.cs'), '-Destination', built], { windowsHide: true, stdio: 'pipe', timeout: 30000 });
    assertDistributionFiles(staging, [built], keys);
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true }); fs.mkdirSync(path.join(root, 'licenses'), { recursive: true });
    if (!fs.existsSync(path.join(root, 'bin/node.exe'))) fs.copyFileSync(nodeExecutable, path.join(root, 'bin/node.exe'));
    if (path.resolve(nodeLicense) !== path.join(root, 'licenses/NODE-LICENSE.txt')) fs.copyFileSync(nodeLicense, path.join(root, 'licenses/NODE-LICENSE.txt'));
    if (fs.existsSync(exe)) fs.renameSync(exe, path.join(staging, 'previous.exe'));
    try { fs.renameSync(built, exe); } catch (error) { if (fs.existsSync(path.join(staging, 'previous.exe'))) fs.renameSync(path.join(staging, 'previous.exe'), exe); throw error; }
  }
  if (fs.existsSync(app)) fs.renameSync(app, path.join(staging, 'previous.app'));
  try { fs.renameSync(prepared.app, app); } catch (error) { if (fs.existsSync(path.join(staging, 'previous.app'))) fs.renameSync(path.join(staging, 'previous.app'), app); throw error; }
  fs.writeFileSync(registry, JSON.stringify({ appFiles: tree(app), preparedAt: new Date().toISOString() }), { mode: 0o600 });
  if (path.dirname(fs.realpathSync(staging)) !== fs.realpathSync(dist) || !path.basename(staging).startsWith('.root-launchers-')) throw Error('启动准备暂存目录校验失败。');
  fs.rmSync(staging, { recursive: true, force: true });
  return { mac: app, windows: fs.existsSync(exe) ? exe : null, compressed: false, stateDirectory: state };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(prepareRootLaunchers(), null, 2));
