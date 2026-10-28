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
  startSpeechRecording: () => request('speech.record.start'),
  finishSpeechRecording: input => request('speech.record.finish', input),
  cancelSpeechRecording: input => request('speech.record.cancel', input),
  releaseSpeech: () => request('speech.release'),
  retryMeetingAudio: () => request('speech.audio.retry'),
  help: () => request('help.open'),
  collectionState: () => request('collection.state'),
  saveCollection: settings => request('collection.configure', { settings }),
  openCollection: () => request('collection.open')
}));
