const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, ipcMain, globalShortcut, screen, dialog, shell, Notification } = require('electron');
const { ProviderRouter } = require('../provider.cjs');
const { CollectionService } = require('./service.cjs');
const { destination } = require('./model.cjs');
function setupCollection({ root, speech, createWindow, openSettings, platform }) {
  const service = new CollectionService({ root, downloadsDirectory: app.getPath('downloads'), speech, provider: new ProviderRouter({ root }) });
  const file = path.join(__dirname, 'ui/index.html'), url = pathToFileURL(file).href;
  let window, quitting = false, registered, shortcutError = '';
  function resize(expanded) {
    if (!window || window.isDestroyed()) return;
    const current = window.getBounds(), area = screen.getDisplayMatching(current).workArea;
    const width = Math.min(expanded ? 620 : 580, area.width), height = Math.min(expanded ? 800 : 400, area.height);
    if (window.isMaximized()) window.unmaximize();
    window.setBounds({ x: Math.max(area.x, Math.min(current.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(current.y, area.y + area.height - height)), width, height });
  }
  async function open(expanded = false) {
    await app.whenReady();
    if (!window || window.isDestroyed()) {
      window = createWindow({ width: 580, height: 400, minWidth: 480, minHeight: 350, title: 'Switch Notion · 快捷收集',
        backgroundColor: '#ffffff', show: false, autoHideMenuBar: true, resizable: true, minimizable: true,
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'notion-switch-collection', spellcheck: false } });
      window.removeMenu(); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
      await window.loadFile(file);
    }
    if (window.isMinimized()) window.restore(); resize(expanded); window.show(); window.focus();
    window.webContents.send('collection:show', { expanded });
  }
  function register() {
    if (registered) { globalShortcut.unregister(registered); registered = null; }
    try {
      if (globalShortcut.register(service.settings.shortcut, () => void open())) { registered = service.settings.shortcut; shortcutError = ''; }
      else shortcutError = '快捷键已被其他应用占用，可在内容收集中更换；托盘入口仍可使用。';
    } catch { shortcutError = '快捷键注册失败，请更换组合；托盘入口仍可使用。'; }
    service.emit('change');
  }
  ipcMain.handle('notion-switch:collection', async (event, action, input = {}) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== url) return { ok: false, error: '此操作只能从快捷收集窗口执行。' };
    try {
      if (['expand', 'hide', 'settings', 'directory', 'browser', 'profile', 'open-page', 'open-destination', 'open-source', 'open-local', 'open-downloads'].includes(action)) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !(action === 'expand' ? ['expanded'] : action === 'open-destination' ? ['target'] : ['open-page', 'open-source', 'open-local'].includes(action) ? ['id'] : []).includes(key))) throw Error('收集窗口操作参数无效。');
        if (action === 'expand') resize(input.expanded === true);
        if (action === 'hide') window.hide();
        if (action === 'settings') await openSettings();
        if (action === 'open-downloads') {
          const directory = service.settings.outputDirectory || service.status().defaultDownloadDirectory;
          require('node:fs').mkdirSync(directory, { recursive: true });
          if (await shell.openPath(directory)) throw Error('无法打开下载文件夹。');
        }
        if (action === 'directory' || action === 'profile') { const response = await dialog.showOpenDialog(window, { properties: ['openDirectory', ...(action === 'directory' ? ['createDirectory'] : [])] }); return { ok: true, result: { path: response.canceled ? null : response.filePaths[0] } }; }
        if (action === 'browser') { const response = await dialog.showOpenDialog(window, { properties: ['openFile'], ...(platform.id === 'darwin' ? { properties: ['openFile', 'openDirectory'] } : {}) });
          let selected = response.canceled ? null : response.filePaths[0];
          if (selected?.endsWith('.app')) selected = path.join(selected, 'Contents/MacOS', path.basename(selected, '.app'));
          return { ok: true, result: { path: selected } }; }
        const job = service.jobs.get(input.id);
        if (action === 'open-page') { if (!job?.page?.id || !/^[a-f\d-]{36}$/i.test(job.page.id)) throw Error('此任务还没有已核验的 Notion 页面。'); await shell.openExternal('https://www.notion.so/' + job.page.id.replaceAll('-', '')); }
        if (action === 'open-destination') { const target = destination(input.target); if (!target) throw Error('请选择保存位置。'); await service.notion.verifyTarget(target, AbortSignal.timeout(45000)); await shell.openExternal('https://www.notion.so/' + target.id.replaceAll('-', '')); }
        if (action === 'open-source') { if (!job) throw Error('任务不存在。'); if (job.localSource?.path) { const { checkLocal } = require('./local-media.cjs'); checkLocal(job.localSource); shell.showItemInFolder(job.localSource.path); return { ok: true, result: {} }; } return { ok: true, result: await service.browser.login(job.url, AbortSignal.timeout(60000)) }; }
        if (action === 'open-local') { if (!job?.exportDirectory) throw Error('此任务没有保留本地副本。'); const error = await shell.openPath(job.exportDirectory); if (error) throw Error('无法打开本地目录。'); }
        return { ok: true, result: {} };
      }
      const result = await service.request(action, input);
      if (result.ok && action === 'state') result.result.shortcutError = shortcutError;
      return result;
    } catch { return { ok: false, error: '窗口操作未完成，请检查所选任务或路径。' }; }
  });
  service.on('change', () => { if (window && !window.isDestroyed()) window.webContents.send('collection:changed'); });
  service.on('settings', register);
  service.on('finished', info => {
    if (!Notification.isSupported()) return;
    const notice = new Notification({ title: info.status === 'completed' ? '已收集到 Notion' : '内容已保存，部分项目待补全', body: info.title.slice(0, 120), silent: true });
    notice.on('click', () => { if (info.status === 'completed' && /^[a-f\d-]{36}$/i.test(info.pageId)) void shell.openExternal('https://www.notion.so/' + info.pageId.replaceAll('-', '')); else void open(true); }); notice.show();
  });
  app.whenReady().then(register).catch(() => {});
  app.on('before-quit', () => { quitting = true; service.close(); });
  app.on('will-quit', () => { if (registered) globalShortcut.unregister(registered); });
  return { service, open, status: () => ({ active: service.active, shortcutError }) };
}
module.exports = { setupCollection };
