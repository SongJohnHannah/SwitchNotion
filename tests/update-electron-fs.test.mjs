import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('the configuration update check reads physical archives under Electron ASAR virtualization', t => {
  const parent = path.resolve('.notion-switch'), dir = fs.mkdtempSync(path.join(parent, 'test-electron-fs-'));
  t.after(() => { assert.equal(path.dirname(dir), parent); fs.rmSync(dir, { recursive: true, force: true }); });
  const root = path.join(dir, 'state'), source = path.join(dir, 'installed');
  fs.mkdirSync(root); fs.mkdirSync(path.join(source, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(source, 'Notion.exe'), 'fixture');
  fs.writeFileSync(path.join(root, 'installation.local.json'), JSON.stringify({ source }));
  const entries = {
    'package.json': JSON.stringify({ name: 'Notion', productName: 'Notion', version: '7.50.0', main: './.webpack/main', devDependencies: { electron: '44.1.0' } }),
    '.webpack/main/index.js': 'const e=require("electron"); const hooks=["session-created","web-contents-created","protocol.handle","session.fromPartition","whenReady","notion.com"];'
  };
  const header = { files: {} }, content = []; let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const bytes = Buffer.from(value), parts = name.split('/'); let node = header;
    for (const part of parts.slice(0, -1)) node = node.files[part] ||= { files: {} };
    node.files[parts.at(-1)] = { offset: String(offset), size: bytes.length }; content.push(bytes); offset += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(header)), length = Math.ceil((json.length + 4) / 4) * 4, pickle = Buffer.alloc(length + 4), size = Buffer.alloc(8);
  pickle.writeUInt32LE(length); pickle.writeUInt32LE(json.length, 4); json.copy(pickle, 8); size.writeUInt32LE(4); size.writeUInt32LE(pickle.length, 4);
  fs.writeFileSync(path.join(source, 'resources/app.asar'), Buffer.concat([size, pickle, ...content]));
  // Simulate Electron's actual boundary: ordinary fs virtualizes ASAR, original-fs does not.
  const probe = `const fs=require('node:fs'), physical={...fs}, Module=require('node:module'), load=Module._load;
    Object.defineProperty(process.versions,'electron',{value:'44.1.0'});
    Module._load=function(name,...args){return name==='original-fs'?physical:load.call(this,name,...args)};
    fs.readFileSync=function(file,...args){if(String(file).endsWith('.asar'))throw Error('ENOENT, not found in '+file);return physical.readFileSync(file,...args)};
    const {UpdateService}=require('./src/update-service.cjs');
    new UpdateService({root:process.argv[1],load:()=>import('./scripts/runtime-update.mjs')}).request('update.status').then(result=>console.log(JSON.stringify(result)));`;
  const result = JSON.parse(execFileSync(process.execPath, ['-e', probe, root], { encoding: 'utf8', windowsHide: true }));
  assert.equal(result.ok, true); assert.equal(result.result.compatible, true, result.result.message);
  assert.equal(result.result.originalVersion, '7.50.0');
});
