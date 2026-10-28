import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { run, workerEnvironment } = require('../src/collection/process.cjs');
if (process.platform !== 'win32') throw Error('This harness uses the Windows reviewed Electron runtime; run the Mac app acceptance checklist on Apple Silicon.');
const project = path.resolve(import.meta.dirname, '..'), runtime = path.join(project, '.notion-switch/runtime');
const stage = path.join(project, '.notion-switch', 'collection-electron-qa-' + Date.now());
fs.mkdirSync(path.join(stage, 'resources'), { recursive: true });
for (const item of fs.readdirSync(runtime, { withFileTypes: true })) {
  if (item.isFile()) { try { fs.linkSync(path.join(runtime, item.name), path.join(stage, item.name)); } catch { fs.copyFileSync(path.join(runtime, item.name), path.join(stage, item.name)); } }
  if (item.isDirectory() && item.name === 'locales') fs.cpSync(path.join(runtime, item.name), path.join(stage, item.name), { recursive: true });
}
const main = `const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {app,BrowserWindow,globalShortcut} = require('electron');
const project = ${JSON.stringify(project)}, directory = ${JSON.stringify(stage)};
app.disableHardwareAcceleration();app.setName('Switch Notion Collection QA');
fs.mkdirSync(path.join(directory,'profile'),{recursive:true});app.setPath('userData',path.join(directory,'profile'));
const {setupCollection} = require(path.join(project,'src/collection/window.cjs'));
const collection=setupCollection({root:path.join(directory,'state'),platform:{id:'win32'},openSettings:async()=>{},createWindow:options=>{const w=new BrowserWindow({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true}});w.show=()=>{};w.focus=()=>{};return w;}});
collection.service.settings.shortcut='CommandOrControl+Alt+Shift+F12';collection.service.settings.browserPort=19487;
const deadline=setTimeout(()=>{console.error('Electron collection QA timeout');app.exit(1);},45000);
app.whenReady().then(async()=>{
 const {run,workerEnvironment,nodeExecutable}=require(path.join(project,'src/collection/process.cjs'));
 fs.mkdirSync(path.join(directory,'state'),{recursive:true});fs.writeFileSync(path.join(directory,'state/launcher.local.json'),JSON.stringify({nodeExecutable:${JSON.stringify(process.execPath)}}));
 const worker=await run(nodeExecutable(path.join(directory,'state')),['-e','process.stdout.write(JSON.stringify({node:!!process.versions.node,electron:!!process.versions.electron}))'],{env:workerEnvironment(path.join(directory,'bin')),timeout:10000});
 assert.deepEqual(JSON.parse(worker.stdout),{node:true,electron:false});
 await collection.open(false);const window=BrowserWindow.getAllWindows()[0];
 await new Promise(r=>setTimeout(r,600));
 const state=await window.webContents.executeJavaScript("window.collection.request('state')");assert.equal(state.ok,true);assert.equal(state.result.settings.vision,true);
 assert.ok(globalShortcut.isRegistered(collection.service.settings.shortcut));
 await window.webContents.executeJavaScript("window.collection.request('configure',{settings:{vision:false}})");
 const changed=await window.webContents.executeJavaScript("window.collection.request('state')");assert.equal(changed.result.settings.vision,false);
 fs.writeFileSync(path.join(directory,'compact.png'),(await window.webContents.capturePage()).toPNG());
 const secondary=new BrowserWindow({show:false,webPreferences:{preload:path.join(project,'src/collection/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true}});
 await secondary.loadFile(path.join(project,'src/collection/ui/index.html'));
 const denied=await secondary.webContents.executeJavaScript("window.collection.request('state')");assert.equal(denied.ok,false);secondary.destroy();
 await window.webContents.executeJavaScript("window.collection.request('expand',{expanded:true})");
 assert.ok(Math.abs(window.getBounds().width-780)<=2);window.close();assert.equal(window.isDestroyed(),false);assert.equal(window.isVisible(),false);
 const preferences=window.webContents.getLastWebPreferences();assert.equal(preferences.sandbox,true);assert.equal(preferences.nodeIntegration,false);assert.equal(preferences.contextIsolation,true);
 const result={ipc:true,unauthorizedWindowRejected:true,defaultVision:true,persistedVisionToggle:true,globalShortcut:true,closeKeepsWindow:true,sandbox:true,downloadWorkerNodeMode:true};
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));clearTimeout(deadline);app.quit();
}).catch(error=>{console.error(error.stack);app.exit(1);});`;
const sources = { 'package.json': JSON.stringify({ name: 'collection-qa', version: '1.0.0', main: 'main.cjs' }), 'main.cjs': main };
const header = { files: {} }; let offset = 0; const content = [];
for (const [name, text] of Object.entries(sources)) { const bytes = Buffer.from(text); header.files[name] = { size: bytes.length, offset: String(offset) }; offset += bytes.length; content.push(bytes); }
const json = Buffer.from(JSON.stringify(header)), size = Math.ceil((4 + json.length) / 4) * 4, pickle = Buffer.alloc(4 + size);
pickle.writeUInt32LE(size);pickle.writeUInt32LE(json.length,4);json.copy(pickle,8);const prefix=Buffer.alloc(8);prefix.writeUInt32LE(4);prefix.writeUInt32LE(pickle.length,4);
fs.writeFileSync(path.join(stage,'resources/app.asar'),Buffer.concat([prefix,pickle,...content]));
const env = workerEnvironment(path.join(project,'.notion-switch/collection/bin')); delete env.ELECTRON_RUN_AS_NODE;
const result = await run(path.join(stage,'Notion.exe'), [], { env, timeout: 60000, detached: true });
console.log(result.stdout.trim()); console.log('Electron QA artifacts: ' + stage);
