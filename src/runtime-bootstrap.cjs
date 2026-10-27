const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function isFile(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }

function initializeRuntime({ app, dialog, platform, env = process.env, resourcesPath = process.resourcesPath, spawnImpl = spawn }) {
  const validRoot = root => typeof root === 'string' && path.isAbsolute(root) && resourcesPath &&
    readJson(path.join(root, 'prepared.json')) && platform.samePath(platform.runtimeLayout(path.join(root, 'runtime')).resources, resourcesPath);
  if (validRoot(env.NOTION_SWITCH_ROOT)) return env.NOTION_SWITCH_ROOT;

  // Explorer/Finder and stale shortcuts do not carry the launch environment.
  // Return to the root launch flow, then exit before Notion loads its profile.
  const root = resourcesPath && path.resolve(resourcesPath, platform.id === 'darwin' ? '../../../..' : '../..');
  const launcher = root && validRoot(root) && readJson(path.join(root, 'launcher.local.json'));
  if (launcher && typeof launcher.projectDirectory === 'string' && path.isAbsolute(launcher.projectDirectory) && platform.isNodeExecutable(launcher.nodeExecutable)) {
    const script = path.join(launcher.projectDirectory, 'scripts', 'open-notion.mjs');
    if (isFile(script)) {
      try {
        const child = spawnImpl(launcher.nodeExecutable, [script], { cwd: launcher.projectDirectory, detached: true, windowsHide: true, stdio: 'ignore',
          env: { ...env, NOTION_SWITCH_ROOT: root, NOTION_SWITCH_PROJECT: launcher.projectDirectory } });
        child.on('error', () => {});
        if (!Number.isSafeInteger(child.pid)) throw Error('Launcher unavailable');
        child.unref(); app.exit(0); return null;
      } catch {}
    }
  }
  dialog.showErrorBox('Switch Notion', '请回到项目根目录，双击 Switch Notion.exe（Windows）或 Switch Notion.app（Mac）启动。请保持 scripts、src 和 bin 文件夹完整。');
  app.exit(1); return null;
}

function disableBuiltinUpdates(root) {
  const profile = path.join(root, 'profile'), file = path.join(profile, 'state.json');
  // The copied installer feed is removed during preparation too. This local
  // preference suppresses polling without manufacturing a partial Notion state.
  if (fs.lstatSync(profile, { throwIfNoEntry: false })?.isSymbolicLink() || fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
  const state = readJson(file), preferences = state?.appState?.preferences;
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences) || preferences.isAutoUpdaterDisabled === true) return false;
  preferences.isAutoUpdaterDisabled = true;
  const temporary = file + '.tmp-' + randomUUID();
  try { fs.writeFileSync(temporary, JSON.stringify(state, null, '\t'), { mode: 0o600 }); fs.renameSync(temporary, file); return true; }
  catch { return false; }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

module.exports = { initializeRuntime, disableBuiltinUpdates };
