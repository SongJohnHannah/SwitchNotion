const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// This small loader stays inside the signed bundle. Adapter-only updates live
// in verified snapshots beside the profile, so they do not change its CDHash.
function adapterDigest(directory) {
  const hash = createHash('sha256'); let bytes = 0;
  function read(file) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > 16 * 1024 * 1024 || (bytes += info.size) > 64 * 1024 * 1024) throw Error('接管组件文件无效。');
    return fs.readFileSync(file);
  }
  function visit(dir) {
    if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw Error('接管组件目录含链接。');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error('接管组件目录含链接。');
      if (entry.isDirectory()) visit(file);
      else { hash.update(path.relative(directory, file)); hash.update(read(file)); }
    }
  }
  visit(path.join(directory, 'src')); hash.update(read(path.join(directory, 'desktop-compat.mjs')));
  return hash.digest('hex');
}

function resolveMacAdapter({ resourcesPath = process.resourcesPath, env = process.env } = {}) {
  if (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath)) throw Error('Mac 运行目录无效。');
  const root = path.resolve(resourcesPath, '../../../..');
  const relative = path.relative(path.join(root, 'runtime'), resourcesPath);
  if (!['SwitchNotion.app', 'Notion.app'].some(bundle => relative === path.join(bundle, 'Contents', 'Resources')) ||
      fs.realpathSync(root) !== root || fs.realpathSync(resourcesPath) !== path.resolve(resourcesPath) ||
      env.NOTION_SWITCH_ROOT && path.resolve(env.NOTION_SWITCH_ROOT) !== root) throw Error('Mac 运行目录校验失败。');
  const prepared = JSON.parse(fs.readFileSync(path.join(root, 'prepared.json'), 'utf8'));
  if (prepared.platform !== 'darwin' || prepared.runtime !== path.join(root, 'runtime') ||
      !/^[a-f\d]{64}$/.test(prepared.adapterHash || '')) throw Error('Mac 接管组件版本无效。');
  const directory = path.join(root, 'adapters', prepared.adapterHash);
  if (fs.realpathSync(directory) !== directory || adapterDigest(directory) !== prepared.adapterHash) throw Error('Mac 接管组件完整性检查失败，请从项目入口重新启动修复。');
  return path.join(directory, 'src', 'desktop-hook.cjs');
}

function loadMacAdapter() {
  try { require(resolveMacAdapter()); }
  catch (error) {
    const { app, dialog } = require('electron');
    dialog.showErrorBox('SwitchNotion', error.message);
    app.exit(1); throw error;
  }
}
module.exports = { adapterDigest, resolveMacAdapter, loadMacAdapter };
