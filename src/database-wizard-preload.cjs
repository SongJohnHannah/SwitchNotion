const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('databaseWizard', Object.freeze({ request: (action, input = {}) => ipcRenderer.invoke('notion-switch:database-wizard', action, input) }));
