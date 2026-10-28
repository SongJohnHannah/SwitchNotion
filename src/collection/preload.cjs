const { contextBridge, ipcRenderer } = require('electron');
const request = (action, input = {}) => ipcRenderer.invoke('notion-switch:collection', action, input);
contextBridge.exposeInMainWorld('collection', Object.freeze({ request,
  onChange: callback => ipcRenderer.on('collection:changed', () => callback()),
  onShow: callback => ipcRenderer.on('collection:show', (_event, value) => callback(value)) }));
