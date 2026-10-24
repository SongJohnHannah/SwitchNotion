const path = require('node:path');

const reviewedBuilds = Object.freeze({
  '7.40.0': 'afb4684fa08d12d7ccd3c89e2ad195de7047859d437e721689a5cbfc69403549',
  '7.40.1': '36cc65c5d17811f6bbe90aa0444be3f3f267f3151ea59988411e8f94dba9ff73'
});
function registryLocations(execFileSync) {
  // Never invoke Windows commands while inspecting this adapter on another OS.
  if (process.platform !== 'win32') return [];
  const script = "$keys=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Notion','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Notion','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Notion');$values=@(foreach($key in $keys){$p=Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue;if($p.InstallLocation){$p.InstallLocation};if($p.DisplayIcon){$p.DisplayIcon -replace ',[-0-9]+$','' -replace '^\"|\"$',''}});ConvertTo-Json -InputObject $values -Compress";
  try {
    const found = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 32768 }));
    return Array.isArray(found) ? found : [];
  } catch { return []; }
}
function windows({ env, home, execFileSync, registry }) {
  const layout = directory => {
    const appRoot = path.resolve(directory), resources = path.join(appRoot, 'resources');
    return { appRoot, executable: path.join(appRoot, 'Notion.exe'), resources, archive: path.join(resources, 'app.asar') };
  };
  return {
    id: 'win32', label: 'Windows', capabilities: { prepareRuntime: true, launchRuntime: true, syncLogin: true },
    compatibility: { enabled: true, reviewedBuilds, versionPattern: /^7\.\d+\.\d+$/, electronPattern: /^44\./ },
    installationLayout: candidate => layout(/\.exe$/i.test(candidate) ? path.dirname(candidate) : candidate),
    runtimeLayout: layout,
    candidates: () => [
      path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Notion'),
      path.join(home, 'AppData', 'Local', 'Programs', 'Notion'),
      env.ProgramFiles && path.join(env.ProgramFiles, 'Notion'),
      env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Notion')
    ],
    fallbackCandidates: registry || (() => registryLocations(execFileSync)),
    login: { strategy: 'windows-local-copy', sourceRoot: env.APPDATA ? path.resolve(env.APPDATA, 'Notion') : null },
    nodeName: /^(?:node|node\.exe)$/i,
    launchOptions: { windowsHide: true },
    stageInstallation({ source, target, copy }) { copy(source.appRoot, target.appRoot); },
    finalizeRuntime() {},
    configureAppIdentity(app) {
      if (typeof app.setAppUserModelId !== 'function') return;
      const set = app.setAppUserModelId.bind(app);
      app.setAppUserModelId = () => set('notion.switch.prototype');
    }
  };
}
module.exports = { windows, reviewedBuilds };
