const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { windows } = require('./windows.cjs');
const { macos } = require('./macos.cjs');
const network = require('../notion-accelerator.cjs');

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
    launchRuntime({ container, stateRoot, env: launchEnv = process.env, stdio, spawnImpl = childProcess.spawn, proxyEnabled = false }) {
      requireCapability('launchRuntime');
      const layout = adapter.runtimeLayout(container);
      // 有系统代理时交给代理解析，不固定 IP；没有代理（且未强制直连）时才固定最快 IP。
      // 这样代理启动/关闭都能用，不会被加速设置绑死。
      let settings = { bypassVpn: false, autoIp: false, bestIp: '' };
      try { if (stateRoot) settings = network.read(stateRoot); } catch {}
      const bypass = settings.bypassVpn === true;
      const direct = settings.autoIp === true && (!proxyEnabled || bypass);
      const rules = direct ? network.hostRules(settings.bestIp) : '';
      // 固定了 IP 就必须直连，否则流量仍交给代理解析。
      const bypassed = bypass || rules !== '';
      const args = ['--enable-logging=stderr', ...(bypassed ? ['--proxy-bypass-list=' + network.bypassList] : []), ...(rules ? ['--host-resolver-rules=' + rules] : [])];
      const env = { ...launchEnv, NOTION_SWITCH_ROOT: stateRoot };
      // 系统代理关闭时，环境里残留的 HTTP(S)_PROXY 会让 Electron 网络栈继续尝试已经不存在的代理。
      if (!bypassed && !proxyEnabled) for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
      if (bypassed) env.NO_PROXY = [env.NO_PROXY, network.bypassEnv].filter(Boolean).join(',');
      return spawnImpl(layout.executable, args, {
        cwd: layout.appRoot, detached: true, ...adapter.launchOptions,
        env, stdio
      });
    },
    isNodeExecutable(executable) {
      return typeof executable === 'string' && path.isAbsolute(executable) && adapter.nodeName.test(path.basename(executable)) && isFile(executable);
    },
    processMatchesExecutable(pid, executable) { return adapter.processMatchesExecutable?.(pid, executable) ?? null; },
    samePath(left, right) { return id === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right); },
    configureAppIdentity: adapter.configureAppIdentity
  });
}
module.exports = { createDesktopPlatform };
