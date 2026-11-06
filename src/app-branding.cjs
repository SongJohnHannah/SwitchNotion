const path = require('node:path');
const { taskbarIds } = require('./platform/windows-identity.cjs');
const icons = { main: path.join(__dirname, 'app-icon.png'), settings: path.join(__dirname, 'settings', 'app-icon.png') };
const branded = new WeakSet(), installed = new WeakMap();

function appImage(nativeImage, kind = 'main', size) {
  let image = nativeImage.createFromPath(icons[kind] || icons.main);
  if (size) image = image.resize({ width: size, height: size });
  branded.add(image);
  return image;
}
function installAppBranding(electron, { moduleLoader = require('node:module'), platform = process.platform, project = process.env.NOTION_SWITCH_PROJECT } = {}) {
  if (installed.has(electron)) return installed.get(electron);
  const { app, nativeImage } = electron;
  // The upstream desktop client creates a tray in addition to our settings
  // tray. Replace its supplied images too, including later setImage calls.
  // Explicitly branded images retain the settings cog instead of the bear.
  const NativeTray = electron.Tray, descriptor = Object.getOwnPropertyDescriptor(electron, 'Tray');
  let exported = electron;
  if (platform === 'win32' && typeof NativeTray === 'function') {
    const choose = value => value && typeof value === 'object' && branded.has(value) ? value : appImage(nativeImage, 'main', 32);
    // Current Electron exports Tray through a non-configurable getter.
    // Preserve those native exports and give later imports our own facade.
    if (descriptor && !descriptor.configurable) exported = Object.create(electron);
    Object.defineProperty(exported, 'Tray', { configurable: true, enumerable: true, value: new Proxy(NativeTray, {
      construct(Target, args, NewTarget) {
        const tray = Reflect.construct(Target, [choose(args[0])], NewTarget), setImage = tray.setImage.bind(tray);
        tray.setImage = image => setImage(choose(image));
        return tray;
      }
    }) });
    if (exported !== electron) {
      // Electron's built-in loader bypasses CommonJS cache replacement.
      // Intercept only its two main-process import names in this isolated app.
      const load = moduleLoader._load;
      moduleLoader._load = function(name, ...args) {
        if (name === 'electron' || name === 'electron/main') return exported;
        return Reflect.apply(load, this, [name, ...args]);
      };
    }
  }
  installed.set(electron, exported); installed.set(exported, exported);
  app.on('browser-window-created', (_event, window) => {
    const kind = /配置/.test(window.getTitle?.() || '') ? 'settings' : 'main';
    if (platform === 'win32' && window.setAppDetails) {
      const setDetails = window.setAppDetails.bind(window);
      const details = { appId: taskbarIds[kind],
        appIconPath: icons[kind].replace(/\.png$/, '.ico'), appIconIndex: 0 };
      if (typeof project === 'string' && path.isAbsolute(project)) {
        details.relaunchCommand = '"' + path.join(project, kind === 'settings' ? 'NotionSwitch 配置.exe' : 'SwitchNotion.exe') + '"';
        details.relaunchDisplayName = kind === 'settings' ? 'NotionSwitch 配置' : 'Switch Notion';
      }
      window.setAppDetails = value => setDetails({ ...value, ...details });
    }
    const apply = () => {
      if (window.isDestroyed?.()) return;
      window.setIcon?.(appImage(nativeImage, kind));
      if (platform === 'win32') window.setAppDetails?.({});
    };
    apply(); window.once('ready-to-show', apply);
  });
  app.whenReady().then(() => { app.dock?.setIcon(appImage(nativeImage, 'main', 512)); }).catch(() => {});
  return exported;
}
module.exports = { icons, appImage, installAppBranding };
