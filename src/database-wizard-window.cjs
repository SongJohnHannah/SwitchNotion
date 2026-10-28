const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { uuid } = require('./native-context.cjs');
const { DatabaseWizard } = require('./database-wizard.cjs');
function setupDatabaseWizard({ root, provider, bridge, createWindow, app, ipcMain, Menu, MenuItem, shell }) {
  const service = new DatabaseWizard({ root, provider }), file = path.join(__dirname, 'database-wizard', 'index.html'), url = pathToFileURL(file).href;
  let window, native, controller, initialParent, opening = false;
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
    if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
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
        return { ok: true, result: { ...service.state(store), workspaceTitle: typeof name === 'string' ? name.slice(0, 300) : '所选工作区', initialParent: initialParent ? 'https://www.notion.so/' + initialParent.replaceAll('-', '') : '' } };
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
// One client-side entry on both page and Home surfaces. Creation remains in
// the isolated, sender-checked wizard; the web page can only open that window.
const wizardEntryScript = `(()=>{if(document.getElementById('notion-switch-database-entry')||/\\/(?:login|signup|auth)(?:\\/|$)/.test(location.pathname))return;const button=document.createElement('button');button.id='notion-switch-database-entry';button.textContent='AI 建库';button.title='预览字段并选择布局后创建数据库';Object.assign(button.style,{position:'fixed',right:'88px',bottom:'20px',zIndex:'1000',font:'13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',padding:'8px 12px',border:'1px solid rgba(128,128,128,.3)',borderRadius:'7px',background:'var(--c-bacPri,#fff)',color:'var(--c-texPri,#333)',cursor:'pointer',boxShadow:'0 2px 8px rgba(0,0,0,.08)'});button.onclick=async()=>{button.disabled=true;try{const match=location.pathname.match(/([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\\/)?$/i);const response=await fetch('/_notion-switch/database-wizard/open',{method:'POST',headers:{'content-type':'application/json','x-notion-switch-ui':'database-wizard-v1'},body:JSON.stringify({pageId:match?.[1]})});const result=await response.json();if(!result.ok){button.textContent=result.message||'请先打开工作区页面';setTimeout(()=>button.textContent='AI 建库',6000)}}catch{button.textContent='打开失败，请从应用菜单重试'}finally{button.disabled=false}};document.body.append(button)})()`;
module.exports = { setupDatabaseWizard, wizardEntryScript };
