const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { uuid } = require('./native-context.cjs');
const { DatabaseWizard } = require('./database-wizard.cjs');
function setupDatabaseWizard({ root, provider, bridge, createWindow, app, ipcMain, Menu, MenuItem, shell }) {
  const service = new DatabaseWizard({ root, provider }), file = path.join(__dirname, 'database-wizard', 'index.html'), url = pathToFileURL(file).href;
  let window, native, controller, initialParent, initialPrompt = '', opening = false;
  const getNative = async ({ session, pageId } = {}) => {
    const signal = AbortSignal.timeout(15000);
    if (uuid(pageId)) {
      for (const context of [...bridge.contexts].reverse().filter(value => !session || value.session === session)) {
        try { const store = bridge.store(context, null); await store.root(pageId, signal); return bridge.store(context, store.spaceId); } catch (error) { if (signal.aborted) throw error; }
      }
    }
    const context = [...bridge.contexts].reverse().find(value => (!session || value.session === session) && uuid(value.spaceId));
    if (!context) throw Error('Notion 建库向导 请先在 Notion 打开目标工作区中的页面，再点击“AI 建库”。');
    return bridge.store(context, context.spaceId);
  };
  async function open(options = {}) {
    if (opening) return; opening = true;
    try {
    await app.whenReady();
    initialPrompt = typeof options.prompt === 'string' ? options.prompt.slice(0, 12000) : '';
    if (window && !window.isDestroyed()) {
      window.show(); window.focus();
      if (initialPrompt) {
        const send = () => { try { window?.webContents.send('notion-switch:database-wizard-prefill', initialPrompt); } catch {} };
        if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', send); else send();
      }
      return;
    }
    native = await getNative(options); initialParent = uuid(options.pageId); controller = new AbortController();
    window = createWindow({ width: 880, height: 780, minWidth: 720, minHeight: 640, title: 'AI 建库向导', autoHideMenuBar: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'database-wizard-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'notion-switch-database-wizard' } });
    window.removeMenu(); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', event => event.preventDefault());
    window.once('ready-to-show', () => { window.show(); window.focus(); });
    window.on('closed', () => { controller.abort(); window = null; native = null; }); await window.loadFile(file);
    } finally { opening = false; }
  }
  ipcMain.handle('notion-switch:database-wizard', async (event, action, input = {}) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== url) return { ok: false, error: '此操作只能从建库向导执行。' };
    try {
      const store = native, signal = controller.signal;
      if (!['state', 'generate', 'layout', 'commit', 'open'].includes(action)) throw Error('向导操作无效。');
      if (action === 'state') {
        const space = await store.api('getRecordValues', { requests: [{ table: 'space', id: store.spaceId, spaceId: store.spaceId }] }, { signal, spaceId: store.spaceId });
        let entry = space.results?.[0]; for (let n = 0; n < 3 && entry && !entry.value?.id; n++) entry = entry.value;
        const name = entry?.value?.name;
        return { ok: true, result: { ...service.state(store), workspaceTitle: typeof name === 'string' ? name.slice(0, 300) : '所选工作区', initialParent: initialParent ? 'https://www.notion.so/' + initialParent.replaceAll('-', '') : '', prompt: initialPrompt } };
      }
      if (action === 'open') {
        const job = service.find(input, store); if (job.status !== 'verified') throw Error('数据库尚未创建。');
        await shell.openExternal(job.result.url); return { ok: true, result: {} };
      }
      return { ok: true, result: await service[action](input, store, signal) };
    } catch (error) { return { ok: false, error: /^Notion |^向导|^数据库/.test(error.message || '') ? error.message : '建库未完成，请检查模型和页面权限后重试。' }; }
  });
  const original = Menu.setApplicationMenu.bind(Menu);
  Menu.setApplicationMenu = menu => {
    const parent = menu?.getMenuItemById('notion-switch-config-menu')?.submenu;
    if (parent && !menu.getMenuItemById('notion-switch-build-menu')) parent.insert(1, new MenuItem({ id: 'notion-switch-build-menu', label: 'AI 建库', click: () => void open().catch(error => {
      require('electron').dialog.showErrorBox('AI 建库向导', error.message);
    }) }));
    return original(menu);
  };
  app.whenReady().then(() => { const menu = Menu.getApplicationMenu(); if (menu) Menu.setApplicationMenu(menu); });
  app.on('before-quit', () => { controller?.abort(); service.close(); });
  return { open, service };
}
module.exports = { setupDatabaseWizard };
