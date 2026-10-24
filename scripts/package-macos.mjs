import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertDistributionFiles, localDeepSeekKeys } from './package-safety.mjs';
import { zipDirectory } from './portable-zip.mjs';

const project = path.resolve(import.meta.dirname, '..');
const scripts = ['asar.mjs', 'native-fs.mjs', 'desktop-compat.mjs', 'runtime-update.mjs', 'runtime-health.mjs',
  'source-discovery.mjs', 'find-notion.mjs', 'launch-lock.mjs', 'prepare-desktop.mjs', 'start-desktop.mjs',
  'open-notion.mjs', 'open-settings.mjs', 'open-update.mjs', 'update-helper.mjs', 'launch-macos.sh', 'launch-macos.mjs'];
function descendants(root) {
  const files = [];
  function visit(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name); if (item.isSymbolicLink()) throw Error('分发源包含链接。');
    if (item.isDirectory()) visit(file); else files.push(file);
  } } visit(root); return files;
}
export function stageMac({ sourceProject = project, destination }) {
  const target = path.resolve(destination), relative = path.relative(path.join(sourceProject, 'dist'), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.existsSync(target)) throw Error('Mac 分发目标必须是 dist 内的新目录。');
  const sources = ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'MAC-使用说明.md', 'package.json', 'assets/notion.icns',
    'Switch Notion 启动.command', 'Switch Notion 配置.command', ...scripts.map(f => 'scripts/' + f),
    ...descendants(path.join(sourceProject, 'src')).map(f => path.relative(sourceProject, f))];
  const keys = localDeepSeekKeys(sourceProject);
  assertDistributionFiles(sourceProject, sources.map(f => path.join(sourceProject, f)), keys);
  const app = path.join(target, 'Switch Notion.app'), resources = path.join(app, 'Contents/Resources'), payload = path.join(resources, 'project');
  for (const file of sources) {
    const out = path.join(payload, file); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.copyFileSync(path.join(sourceProject, file), out);
    if (/\.(?:command|sh)$/.test(file)) fs.chmodSync(out, 0o755);
  }
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.copyFileSync(path.join(sourceProject, 'assets/notion.icns'), path.join(resources, 'notion.icns'));
  fs.copyFileSync(path.join(sourceProject, 'MAC-使用说明.md'), path.join(target, '使用说明.md'));
  const version = JSON.parse(fs.readFileSync(path.join(sourceProject, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Switch Notion</string><key>CFBundleDisplayName</key><string>Switch Notion</string>
<key>CFBundleIdentifier</key><string>com.notionswitch.launcher</string><key>CFBundleExecutable</key><string>SwitchNotion</string>
<key>CFBundleIconFile</key><string>notion.icns</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/></dict></plist>\n`);
  const entry = path.join(app, 'Contents/MacOS/SwitchNotion');
  fs.writeFileSync(entry, '#!/bin/sh\nset -eu\nbase=$(CDPATH= cd "$(dirname "$0")/../Resources/project" && pwd -P)\nexport NOTION_SWITCH_ROOT="$HOME/Library/Application Support/Switch Notion"\nexec /bin/sh "$base/scripts/launch-macos.sh" notion "$base"\n', { mode: 0o755 });
  fs.chmodSync(entry, 0o755);
  for (const [name, targetMode] of [['Switch Notion 启动.command', 'notion'], ['Switch Notion 配置.command', 'settings']]) {
    const launcher = path.join(target, name);
    fs.writeFileSync(launcher, '#!/bin/sh\nset -eu\nbase=$(CDPATH= cd "$(dirname "$0")/Switch Notion.app/Contents/Resources/project" && pwd -P)\nexport NOTION_SWITCH_ROOT="$HOME/Library/Application Support/Switch Notion"\nexec /bin/sh "$base/scripts/launch-macos.sh" ' + targetMode + ' "$base"\n', { mode: 0o755 });
    fs.chmodSync(launcher, 0o755);
  }
  const output = descendants(target); assertDistributionFiles(target, output, keys);
  const manifest = { name: 'Switch Notion', platform: 'darwin', architecture: 'arm64', version,
    includesNotion: false, includesUserData: false, includesModels: false, includesNode: false, notarized: false,
    files: output.map(file => ({ file: path.relative(target, file).replaceAll('\\', '/'), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') })) };
  fs.writeFileSync(path.join(target, 'package-manifest.json'), JSON.stringify(manifest, null, 2));
  return { directory: target, app, ...Object.fromEntries(Object.entries(manifest).filter(([key]) => key.startsWith('includes') || key === 'notarized')) };
}
export function packageMac() {
  fs.mkdirSync(path.join(project, 'dist'), { recursive: true });
  const staged = stageMac({ destination: path.join(project, 'dist', 'Switch-Notion-mac-arm64-' + Date.now()) });
  const archive = staged.directory + '.zip', zipped = zipDirectory({ directory: staged.directory, output: archive });
  fs.writeFileSync(archive + '.sha256', createHash('sha256').update(fs.readFileSync(archive)).digest('hex') + '  ' + path.basename(archive) + '\n');
  return { ...staged, archive, ...zipped };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(packageMac(), null, 2));
