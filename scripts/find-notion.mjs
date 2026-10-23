import fs from 'node:fs';
import path from 'node:path';
import { stateRoot } from './runtime-update.mjs';
import { findNotion, notionDirectory } from './source-discovery.mjs';
import { inspectDesktop } from './desktop-compat.mjs';
const existing = fs.existsSync(path.join(stateRoot, 'runtime', 'Notion.exe')) && fs.existsSync(path.join(stateRoot, 'prepared.json'));
try {
  if (process.argv.length > 4 || process.argv[2] && process.argv[2] !== '--select') throw Error('无法识别安装位置操作。');
  const source = process.argv[2] === '--select' ? notionDirectory(path.resolve(process.argv[3] || ''), stateRoot) : findNotion(stateRoot);
  if (!source) console.log(JSON.stringify({ found: false, canUseExistingRuntime: existing, message: '未找到官网桌面版 Notion，可以安装后重新检测，或选择已安装的 Notion.exe。' }));
  else {
    const build = inspectDesktop(fs.readFileSync(path.join(source, 'resources', 'app.asar')));
    fs.mkdirSync(stateRoot, { recursive: true }); fs.writeFileSync(path.join(stateRoot, 'installation.local.json'), JSON.stringify({ source }));
    console.log(JSON.stringify({ found: true, source, version: build.version, canUseExistingRuntime: existing }));
  }
} catch (error) { console.log(JSON.stringify({ found: false, canUseExistingRuntime: existing, message: error.message })); }
