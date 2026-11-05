const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('databaseWizard', Object.freeze({
  request: (action, input = {}) => ipcRenderer.invoke('notion-switch:database-wizard', action, input),
  onPrefill: callback => ipcRenderer.on('notion-switch:database-wizard-prefill', (_event, value) => { if (typeof value === 'string') callback(value); })
}));
