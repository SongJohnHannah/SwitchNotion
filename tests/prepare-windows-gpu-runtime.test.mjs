import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {parseArguments,prepareWindowsGpuRuntime} from '../scripts/prepare-windows-gpu-runtime.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function put(root,file,bytes) {
  await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});
  await fs.writeFile(path.join(root,file),typeof bytes==='object'&&!Buffer.isBuffer(bytes)?JSON.stringify(bytes,null,2)+'\n':bytes);
}
async function fixture(t) {
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'prepare-gpu-'));
  t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const source=path.join(temp,'source'),project=path.join(temp,'clone');
  const code=path.join(project,'src/speech/windows-operator'),native=path.join(project,'assets/windows-gpu-native');
  const runtime=path.join(project,'.notion-switch/windows-gpu-operator');
  const originalPth='python311.zip\n.\nLib/site-packages\n../../../module/src/speech\nimport site\n';
  const finalPth=originalPth.replace('../../../module/src/speech\n','');
  const pth='resources/speech/python/python311._pth';
  const nativeBytes={'ctranslate2/ctranslate2.dll':'MZ-native','licenses/ffmpeg-LICENSE.txt':'FFmpeg license\n'};
  const runtimeBytes={'resources/speech/python/python.exe':'MZ-python','resources/speech/model/model.bin':'model','bin/ffmpeg.exe':'MZ-ffmpeg',[pth]:finalPth,'licenses/windows-gpu-native/licenses/ffmpeg-LICENSE.txt':nativeBytes['licenses/ffmpeg-LICENSE.txt']};
  const rows=(object,root)=>Object.entries(object).map(([file,bytes])=>({root,file,bytes:Buffer.byteLength(bytes),sha256:sha(bytes)}));
  const canonical={version:1,files:[...rows(nativeBytes,'native'),...rows(runtimeBytes,'runtime')]};
  for(const [file,bytes]of Object.entries(nativeBytes))await put(native,file,bytes);
  for(const [file,bytes]of Object.entries(runtimeBytes))if(!file.startsWith('licenses/windows-gpu-native/'))await put(source,file,file===pth?originalPth:bytes);
  await put(source,'licenses/windows-gpu-native/licenses/ffmpeg-LICENSE.txt','wrong source; must not read');
  await put(source,'records/user-transcript.txt','private; never copy');
  await put(code,'asset-lock.json',canonical);
  await put(code,'operator.cjs','tracked source remains unchanged\n');
  await put(code,'vendor-provenance.json',{version:1,adaptations:[{root:'runtime',file:pth,originalSha256:sha(originalPth),sha256:sha(finalPth)}]});
  await put(native,'asset-lock.json',{version:1,files:canonical.files.filter(x=>x.root==='native').map(({root,...row})=>row)});
  return {source,project,code,native,runtime,pth,canonical,options:{source,project}};
}
async function snapshot(root) {
  const files={};
  async function visit(relative='') {
    for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})) {
      const file=path.join(relative,entry.name);
      if(entry.isDirectory())await visit(file);else files[file]=sha(await fs.readFile(path.join(root,file)));
    }
  }
  await visit();return files;
}

test('prepares only exact runtime allowlist, adapts PTH, and leaves tracked clone byte-identical',async t=>{
  const f=await fixture(t),codeBefore=await snapshot(f.code),nativeBefore=await snapshot(f.native);
  const result=await prepareWindowsGpuRuntime(f.options);
  assert.equal(result.runtimeDirectory,f.runtime);
  assert.deepEqual(await snapshot(f.code),codeBefore);assert.deepEqual(await snapshot(f.native),nativeBefore);
  const lock=JSON.parse(await fs.readFile(path.join(f.runtime,'asset-lock.json'),'utf8'));
  assert.deepEqual(lock.files,f.canonical.files.filter(x=>x.root==='runtime').map(({root,...row})=>row));
  for(const row of lock.files){const bytes=await fs.readFile(path.join(f.runtime,row.file));assert.equal(bytes.length,row.bytes);assert.equal(sha(bytes),row.sha256);}
  assert.doesNotMatch(await fs.readFile(path.join(f.runtime,f.pth),'utf8'),/module/);
  assert.match(await fs.readFile(path.join(f.source,f.pth),'utf8'),/module/);
  assert.equal(await fs.readFile(path.join(f.runtime,'licenses/windows-gpu-native/licenses/ffmpeg-LICENSE.txt'),'utf8'),'FFmpeg license\n');
  await assert.rejects(fs.stat(path.join(f.runtime,'records')),{code:'ENOENT'});
  await assert.rejects(prepareWindowsGpuRuntime(f.options),/already exists/);
});

test('tampered source or PTH is rejected before creating runtime and tracked files remain intact',async t=>{
  const f=await fixture(t),codeBefore=await snapshot(f.code),nativeBefore=await snapshot(f.native);
  await put(f.source,'resources/speech/model/model.bin','tampered model');
  await assert.rejects(prepareWindowsGpuRuntime(f.options),/differs from tracked runtime lock/);
  await assert.rejects(fs.stat(f.runtime),{code:'ENOENT'});
  await put(f.source,'resources/speech/model/model.bin','model');
  await put(f.source,f.pth,'unexpected path\n');
  await assert.rejects(prepareWindowsGpuRuntime(f.options),/does not match provenance/);
  assert.deepEqual(await snapshot(f.code),codeBefore);assert.deepEqual(await snapshot(f.native),nativeBefore);
});

test('requires explicit source and rejects path escape or source links without copying',async t=>{
  assert.throws(()=>parseArguments([]),/--source/);
  assert.throws(()=>parseArguments(['--source','relative']),/absolute/);
  const f=await fixture(t);
  f.canonical.files.find(x=>x.root==='runtime').file='../escape';
  await put(f.code,'asset-lock.json',f.canonical);
  await assert.rejects(prepareWindowsGpuRuntime(f.options),/escape/);
  f.canonical.files.find(x=>x.root==='runtime').file='resources/speech/python/python.exe';
  await put(f.code,'asset-lock.json',f.canonical);
  const file=path.join(f.source,'resources/speech/model/model.bin');
  await fs.unlink(file);await fs.symlink(path.join(f.source,'records/user-transcript.txt'),file);
  await assert.rejects(prepareWindowsGpuRuntime(f.options),/Symlink|junction/);
  await assert.rejects(fs.stat(f.runtime),{code:'ENOENT'});
});
