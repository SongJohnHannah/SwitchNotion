const { contextBridge, ipcRenderer } = require('electron');
const request = (action, input = {}) => ipcRenderer.invoke('notion-switch:settings', action, input);
contextBridge.exposeInMainWorld('notionSwitch', Object.freeze({
  state: () => request('state'),
  saveWorkspace: input => request('workspace.save', input),
  testWorkspace: input => request('workspace.test', input),
  removeWorkspace: input => request('workspace.remove', input),
  saveDeepseek: input => request('deepseek.save', input),
  testDeepseek: input => request('deepseek.test', input),
  openNotion: () => request('notion.open'),
  loginStatus: () => request('login.status'),
  syncLogin: () => request('login.sync'),
  updateStatus: () => request('update.status'),
  updateNotion: () => request('update.apply'),
  rollbackNotion: () => request('update.rollback'),
  speechStatus: () => request('speech.status'),
  prepareSpeech: () => request('speech.prepare'),
  probeSpeech: () => request('speech.probe'),
  saveSpeech: input => request('speech.save', input),
  testSpeech: () => request('speech.test'),
  releaseSpeech: () => request('speech.release'),
  help: () => request('help.open')
}));
