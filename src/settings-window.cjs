const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, Menu, MenuItem, Tray, shell, nativeImage } = require('electron');
const { SettingsService } = require('./settings-service.cjs');
const { LoginService } = require('./login-state.cjs');
const { UpdateService } = require('./update-service.cjs');
const { createDesktopPlatform } = require('./platform/index.cjs');
const { SpeechSettings } = require('./speech/settings.cjs');
const { microphonePermission } = require('./speech/microphone-permission.cjs');
const marker = '--notion-switch-settings';
const settingsContents = new WeakSet();
let constructingSettings = false;
function isSettings(contents) { return constructingSettings || settingsContents.has(contents); }
function setupSettings({ root, platform = createDesktopPlatform(), isBusy = () => false, getCompatibility = () => ({}), speech }) {
  const service = new SettingsService({ root });
  speech ||= new SpeechSettings({ root, isBusy });
  const isTaskBusy = isBusy;
  isBusy = () => isTaskBusy() || speech.preparing || speech.provider.status().busy || speech.provider.leases > 0;
  app.on('will-quit', () => speech.close());
  const login = new LoginService({ root, platform, isBusy, onRestart: () => setTimeout(() => app.quit(), 300), getTargetLoginStatus: async () => {
    await app.whenReady();
    const { session } = require('electron');
    const sessions = [session.defaultSession, session.fromPartition('persist:notion')];
    let hasLogin = false;
    for (const entry of sessions) {
      const cookies = await entry.cookies.get({ name: 'token_v2' });
      if (cookies.some(cookie => /(^|\.)notion\.(so|com)$/.test(cookie.domain) && !!cookie.value && (cookie.session || !cookie.expirationDate || cookie.expirationDate > Date.now() / 1000))) hasLogin = true;
    }
    return { hasLogin, targetLoginKnown: true };
  } });
  const updates = new UpdateService({ root, platform, getCompatibility, isBusy: () => isBusy() || login.syncing, onRestart: () => setTimeout(() => app.quit(), 300) });
  const file = path.join(__dirname, 'settings', 'index.html'), url = pathToFileURL(file).href;
  let window, tray;
  async function openNotion() {
    await app.whenReady();
    let main = BrowserWindow.getAllWindows().find(w => !isSettings(w.webContents));
    if (!main) {
      app.emit('activate', {}, false);
      await new Promise(resolve => setTimeout(resolve, 300));
      main = BrowserWindow.getAllWindows().find(w => !isSettings(w.webContents));
    }
    if (!main) return false;
    if (main.isMinimized()) main.restore(); main.show(); main.focus();
    return true;
  }
  async function open() {
    await app.whenReady();
    if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return; }
    constructingSettings = true;
    try {
      window = new BrowserWindow({ width: 1080, height: 760, minWidth: 880, minHeight: 640, title: 'NotionSwitch 配置', backgroundColor: '#f6f8fb', show: false, autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'settings-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'notion-switch-settings', additionalArguments: [marker], spellcheck: false } });
      settingsContents.add(window.webContents);
    } finally { constructingSettings = false; }
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    const permitted = (contents, permission, details) => microphonePermission({ contents, expected: window?.webContents, url, permission, details, active: speech.recording });
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(permitted(contents, permission, details)));
    window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => permitted(contents, permission, details));
    window.once('ready-to-show', () => { window.show(); window.focus(); });
    window.on('closed', () => { speech.capture?.cancel(); window = null; });
    await window.loadFile(file);
  }
  ipcMain.handle('notion-switch:settings', async (event, action, input = {}) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== url) return { ok: false, error: '此操作只能从 NotionSwitch 配置窗口执行。' };
    if (typeof action === 'string' && action.startsWith('update.')) return updates.request(action, input);
    if (typeof action === 'string' && action.startsWith('speech.')) return speech.request(action, input);
    if (action === 'login.status' || action === 'login.sync') {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) return { ok: false, error: '无法识别这项操作。' };
      try { if (action === 'login.sync' && updates.updating) return { ok: false, error: '正在更新原型，请等待重启完成。' }; return { ok: true, result: await login[action === 'login.status' ? 'status' : 'sync']() }; }
      catch (error) { return { ok: false, error: error.loginCode && !/(?:sk-|ntn_|secret_)[a-zA-Z0-9_-]{8}/.test(error.message || '') ? error.message : '本机登录同步未完成，请先退出原版 Notion 后重试。' }; }
    }
    if (['notion.open', 'help.open'].includes(action)) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) return { ok: false, error: '无法识别这项操作。' };
      if (action === 'notion.open') {
        if (!await openNotion()) return { ok: false, error: 'Notion 正在准备窗口，请稍后再点“一键启动”。' };
      } else await shell.openExternal('https://www.notion.so/profile/integrations');
      return { ok: true, result: {} };
    }
    return service.request(action, input);
  });
  const originalSetMenu = Menu.setApplicationMenu.bind(Menu);
  Menu.setApplicationMenu = menu => {
    if (menu && !menu.getMenuItemById('notion-switch-config-menu')) menu.append(new MenuItem({ id: 'notion-switch-config-menu', label: 'NotionSwitch', submenu: [{ label: '打开配置窗口', click: () => void open() }] }));
    return originalSetMenu(menu);
  };
  app.whenReady().then(async () => {
    const menu = Menu.getApplicationMenu(); if (menu) Menu.setApplicationMenu(menu);
    try {
      const icon = platform.id === 'darwin'
        ? nativeImage.createFromPath(path.join(__dirname, 'settings', 'notion-tray.png')).resize({ width: 18, height: 18 })
        : await app.getFileIcon(process.execPath);
      tray = new Tray(icon);
      tray.setToolTip('NotionSwitch · 工作区与 DeepSeek 配置');
      tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 NotionSwitch 配置', click: () => void open() }, { label: '一键启动 Notion', click: () => void openNotion() }, { type: 'separator' }, { label: '退出 NotionSwitch', click: () => app.quit() }]));
      tray.on('click', () => void open());
    } catch {}
    if (process.env.NOTION_SWITCH_OPEN_SETTINGS === '1') await open();
  }).catch(() => {});
  return { open, openNotion, speech, updateStatus: () => updates.request('update.status'), isLoginSyncing: () => login.syncing || updates.updating, status: () => {
    const opened = !!window && !window.isDestroyed(), prefs = opened ? window.webContents.getLastWebPreferences() : null;
    return { available: true, open: opened, ...(prefs ? { contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration } : {}) };
  } };
}
module.exports = { setupSettings, isSettings };
