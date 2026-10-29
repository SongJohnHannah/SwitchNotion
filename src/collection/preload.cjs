const { contextBridge, ipcRenderer, webUtils } = require('electron');
const request = (action, input = {}) => ipcRenderer.invoke('notion-switch:collection', action, input);
contextBridge.exposeInMainWorld('collection', Object.freeze({ request,
  getPathForFile: file => webUtils.getPathForFile(file),
  onChange: callback => ipcRenderer.on('collection:changed', () => callback()),
  onShow: callback => ipcRenderer.on('collection:show', (_event, value) => callback(value)) }));
