const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { windows } = require('./windows.cjs');
const { macos } = require('./macos.cjs');

function unsupported(id, capability) {
  const error = Error(`${id === 'darwin' ? 'macOS' : id} 的${capability === 'syncLogin' ? '登录同步' : '桌面运行'}尚未实现或验证。`);
  error.code = 'PLATFORM_CAPABILITY_UNAVAILABLE'; error.platform = id; error.capability = capability;
  return error;
}
function createDesktopPlatform({ id = process.platform, arch = process.arch, env = process.env, home = os.homedir(), fs,
  execFileSync = childProcess.execFileSync, registry } = {}) {
  // Electron virtualizes app.asar through fs. Installation discovery must use
  // the physical filesystem, just like archive inspection in runtime-update.
  fs ||= process.versions.electron ? require('original-fs') : require('node:fs');
  const factory = id === 'win32' ? windows : id === 'darwin' ? macos : null;
  if (!factory) throw unsupported(id, 'prepareRuntime');
  const adapter = factory({ env, home, arch, fs, execFileSync, registry });
  const capabilities = Object.freeze({ ...adapter.capabilities });
  const requireCapability = capability => { if (capabilities[capability] !== true) throw unsupported(id, capability); };
  const json = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  function findInstallation(candidate, stateRoot) {
    if (typeof candidate !== 'string' || !candidate || candidate.includes('\0') || !path.isAbsolute(candidate)) return null;
    const value = adapter.installationLayout(candidate);
    const outside = (base, target) => { const r = path.relative(base, target); return r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r); };
    try {
      // Check resolved paths too: an alias of the isolated runtime is not a
      // valid update source. Do not resolve symlinks during pure layout calls.
      const real = fs.realpathSync(value.appRoot);
      if (stateRoot && (!outside(path.resolve(stateRoot), value.appRoot) || !outside(fs.existsSync(stateRoot) ? fs.realpathSync(stateRoot) : path.resolve(stateRoot), real))) return null;
      return isFile(value.executable) && isFile(value.archive) ? value : null;
    } catch { return null; }
  }
  function discoverInstallation(stateRoot) {
    for (const candidate of [json(path.join(stateRoot, 'installation.local.json'))?.source, ...adapter.candidates(), json(path.join(stateRoot, 'prepared.json'))?.source]) {
      const result = findInstallation(candidate, stateRoot); if (result) return result;
    }
    for (const candidate of adapter.fallbackCandidates()) { const result = findInstallation(candidate, stateRoot); if (result) return result; }
    return null;
  }
  return Object.freeze({
    id, label: adapter.label, capabilities, compatibility: Object.freeze(adapter.compatibility), login: Object.freeze(adapter.login),
    requireCapability, installationLayout: adapter.installationLayout, runtimeLayout: adapter.runtimeLayout,
    findInstallation, discoverInstallation,
    stageInstallation({ source, container, copy }) {
      requireCapability('prepareRuntime');
      const target = adapter.runtimeLayout(container);
      adapter.stageInstallation({ source, target, copy });
      if (!isFile(target.executable) || !isFile(target.archive)) throw Error('Notion 安装文件不完整。');
      return target;
    },
    finalizeRuntime(layout) {
      requireCapability('prepareRuntime');
      // Future macOS adapter signs the already patched bundle here, before the
      // updater promotes it. Signing failure must preserve the working runtime.
      adapter.finalizeRuntime(layout);
    },
    launchRuntime({ container, stateRoot, env: launchEnv = process.env, stdio, spawnImpl = childProcess.spawn }) {
      requireCapability('launchRuntime');
      const layout = adapter.runtimeLayout(container);
      return spawnImpl(layout.executable, ['--enable-logging=stderr'], {
        cwd: layout.appRoot, detached: true, ...adapter.launchOptions,
        env: { ...launchEnv, NOTION_SWITCH_ROOT: stateRoot }, stdio
      });
    },
    isNodeExecutable(executable) {
      return typeof executable === 'string' && path.isAbsolute(executable) && adapter.nodeName.test(path.basename(executable)) && isFile(executable);
    },
    samePath(left, right) { return id === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right); },
    configureAppIdentity: adapter.configureAppIdentity
  });
}
module.exports = { createDesktopPlatform };
