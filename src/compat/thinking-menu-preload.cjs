const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame && process.contextIsolated && location.origin === 'https://app.notion.com') {
  contextBridge.exposeInMainWorld('notionSwitchThinking', (user, effort) => ipcRenderer.invoke('notion-switch:thinking-menu', user, effort));
}
