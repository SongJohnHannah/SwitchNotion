import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertDistributionFiles, localDeepSeekKeys } from './package-safety.mjs';
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeScripts = ['asar.mjs', 'native-fs.mjs', 'desktop-compat.mjs', 'runtime-update.mjs', 'runtime-health.mjs', 'source-discovery.mjs', 'find-notion.mjs', 'bootstrap-windows.ps1', 'launch.ps1', 'launch-lock.mjs', 'prepare-desktop.mjs', 'start-desktop.mjs', 'open-notion.mjs', 'open-settings.mjs', 'open-collection.mjs', 'open-update.mjs', 'update-helper.mjs', 'login-helper.cjs', 'check-windows.mjs'];
const documentation = ['CONTENT-COLLECTION.md', 'MAC-CHECKLIST-ACCEPTANCE-2026-10-29.md', 'WINDOWS-VALIDATION-CHECKLIST.md', 'AI-REFERENCE-COVERAGE.md', 'AI-INTEGRATION-AUDIT.md', 'NATIVE-FORMULA-INTERFACE.md', 'NATIVE-AUTOFILL-INTERFACE.md', 'NATIVE-AI-BLOCK-INTERFACE.md', 'NATIVE-DATABASE-BUILD-INTERFACE.md', 'NATIVE-INSTRUCTIONS-INTERFACE.md', 'WEB-SOURCES-INTERFACE.md', 'AI-MEETING-NOTES-INTERFACE.md',
  'NATIVE-RESEARCH-INTERFACE.md', 'NATIVE-DOCUMENTS-INTERFACE.md', 'NATIVE-OCR-INTERFACE.md', 'MCP-CONNECTIONS.md', 'NATIVE-CALENDAR-INTERFACE.md', 'AI-APPROVALS.md', 'AI-CHAT-SHARING.md', 'OFFLINE-SPEECH.md', 'SPEECH-INTERFACE.md', 'MEETING-SUMMARY-INTERFACE.md', 'AUTOMATIC-COMPATIBILITY.md', 'PLATFORM-INTERFACE.md'];
const publicFiles = ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'WINDOWS-使用说明.md', 'MAC-使用说明.md', 'package.json', 'NotionSwitch 启动.vbs', 'NotionSwitch 配置.vbs', 'NotionSwitch 更新.vbs',
  ...documentation.map(name => 'docs/' + name)];
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function buildLaunchers(destination, sourceProject) {
  const file = path.join(destination, 'NotionSwitch.exe');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(sourceProject, 'scripts', 'compile-launcher.ps1'), '-Source', path.join(sourceProject, 'scripts', 'windows-launcher.cs'), '-Destination', file], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
  for (const name of ['Switch Notion.exe', 'NotionSwitch 配置.exe', 'NotionSwitch 更新.exe']) fs.copyFileSync(file, path.join(destination, name));
}
function descendants(root) {
  const files = [];
  function visit(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name); if (entry.isSymbolicLink()) throw Error('迁移包输入目录含链接，已停止打包。');
    if (entry.isDirectory()) visit(full); else files.push(full);
  } } visit(root); return files;
}
export function stageWindows({ sourceProject = project, destination, nodeExecutable = fs.realpathSync(process.execPath), nodeLicense = path.join(path.dirname(nodeExecutable), 'LICENSE'), launcherBuilder = buildLaunchers }) {
  const relative = path.relative(path.join(sourceProject, 'dist'), path.resolve(destination));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.existsSync(destination)) throw Error('打包目标必须是 dist 内的新目录。');
  const keys = localDeepSeekKeys(sourceProject);
  assertDistributionFiles(sourceProject, [...publicFiles.map(file => path.join(sourceProject, file)), ...runtimeScripts.map(file => path.join(sourceProject, 'scripts', file)), ...descendants(path.join(sourceProject, 'src'))], keys);
  fs.mkdirSync(path.join(destination, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(destination, 'bin')); fs.mkdirSync(path.join(destination, 'licenses'));
  for (const file of publicFiles) {
    fs.mkdirSync(path.dirname(path.join(destination, file)), { recursive: true });
    fs.copyFileSync(path.join(sourceProject, file), path.join(destination, file));
  }
  for (const file of runtimeScripts) fs.copyFileSync(path.join(sourceProject, 'scripts', file), path.join(destination, 'scripts', file));
  descendants(path.join(sourceProject, 'src'));
  fs.cpSync(path.join(sourceProject, 'src'), path.join(destination, 'src'), { recursive: true });
  fs.copyFileSync(nodeExecutable, path.join(destination, 'bin', 'node.exe'));
  fs.copyFileSync(nodeLicense, path.join(destination, 'licenses', 'NODE-LICENSE.txt'));
  launcherBuilder(destination, sourceProject);
  assertDistributionFiles(destination, descendants(destination), keys);
  const manifest = descendants(destination).map(file => ({ file: path.relative(destination, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size, sha256: hash(file) })).sort((a, b) => a.file.localeCompare(b.file));
  if (manifest.some(entry => entry.file.split('/').some(part => ['.notion-switch', 'runtime', 'profile', 'research', 'tests', 'app.asar', 'Notion.exe'].includes(part)))) throw Error('迁移包包含非分发内容。');
  const metadata = { name: 'NotionSwitch', version: JSON.parse(fs.readFileSync(path.join(sourceProject, 'package.json'), 'utf8')).version, platform: 'win32', architecture: 'x64', nodeVersion: process.version, requiresOfficialNotion: true, includesUserData: false, license: 'MIT', files: manifest };
  fs.writeFileSync(path.join(destination, 'package-manifest.json'), JSON.stringify(metadata, null, 2));
  return metadata;
}
export function packageWindows() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('请在 Windows x64 构建此迁移包。');
  const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('无效分发版本。');
  const dist = path.join(project, 'dist'), stage = path.join(dist, '.build-' + randomUUID()), directory = path.join(stage, 'NotionSwitch');
  const archive = path.join(dist, `NotionSwitch-${version}-windows-x64.zip`);
  const metadata = stageWindows({ destination: directory });
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'scripts', 'pack-zip.ps1'), '-Source', directory, '-Destination', archive], { windowsHide: true, timeout: 180000, stdio: 'pipe' });
  fs.writeFileSync(archive + '.sha256', hash(archive) + '  ' + path.basename(archive) + '\n');
  const resolvedStage = fs.realpathSync(stage);
  if (path.dirname(resolvedStage).toLowerCase() !== fs.realpathSync(dist).toLowerCase() || !/^\.build-[\da-f-]{36}$/.test(path.basename(resolvedStage))) throw Error('打包暂存目录校验失败，已保留文件。');
  fs.rmSync(resolvedStage, { recursive: true });
  return { archive, bytes: fs.statSync(archive).size, fileCount: metadata.files.length, includesUserData: false, includesNotion: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(packageWindows(), null, 2));
