import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LICENSE_PREFIX = 'licenses/windows-gpu-native/';
const shaBytes = data => createHash('sha256').update(data).digest('hex');
const jsonBytes = data => Buffer.from(JSON.stringify(data, null, 2) + '\n');
const isAbsolute = value => path.isAbsolute(value) || path.win32.isAbsolute(value);

export function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--source','--project'].includes(key)) throw Error(`Unknown argument: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--') || !isAbsolute(value)) throw Error(`${key} requires an absolute path`);
    if (Object.hasOwn(options,key.slice(2))) throw Error(`Duplicate argument: ${key}`);
    options[key.slice(2)] = value;
  }
  if (!options.source) throw Error('--source is required; no external source is assumed');
  return options;
}

function relativeFile(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /[:\0]/.test(value)) throw Error('Expected a safe relative file path');
  const parts = value.replaceAll('\\','/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw Error('Relative path escape is forbidden');
  return parts.join('/');
}

async function noLinks(file) {
  let current = path.resolve(file);
  while (true) {
    try {if ((await fs.lstat(current)).isSymbolicLink()) throw Error(`Symlink/junction is forbidden: ${current}`);}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function regularFile(root, relative) {
  const absolute = path.join(root,relativeFile(relative));
  await noLinks(absolute);
  if (!(await fs.stat(absolute)).isFile()) throw Error(`Expected a regular file: ${relative}`);
  return absolute;
}

async function shaFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function lockFiles(lock, root) {
  if (lock.version !== 1 || !Array.isArray(lock.files)) throw Error('Invalid canonical asset lock');
  const files = [], unique = new Set();
  for (const row of lock.files) {
    if (!['native','runtime'].includes(row.root)) throw Error('Invalid canonical asset root');
    const file = relativeFile(row.file);
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/.test(row.sha256) || file==='asset-lock.json') throw Error('Invalid asset lock entry');
    const id = `${row.root}/${file}`;
    if (unique.has(id)) throw Error('Duplicate asset lock entry');
    unique.add(id);
    if (row.root===root) files.push({file,bytes:row.bytes,sha256:row.sha256});
  }
  if (!files.length) throw Error(`Empty ${root} asset lock`);
  return files;
}

/** Populate only the ignored runtime root of a clone. The tracked payload is read-only. */
export async function prepareWindowsGpuRuntime({source,project=PROJECT}={}) {
  if (!source || !isAbsolute(source) || !isAbsolute(project)) throw Error('--source and project must be absolute');
  source=path.resolve(source); project=path.resolve(project);
  const codeDirectory=path.join(project,'src/speech/windows-operator');
  const nativeDirectory=path.join(project,'assets/windows-gpu-native');
  const runtimeDirectory=path.join(project,'.notion-switch/windows-gpu-operator');
  for (const directory of [source,codeDirectory,nativeDirectory,runtimeDirectory]) await noLinks(directory);
  for (const directory of [source,codeDirectory,nativeDirectory]) if (!(await fs.stat(directory)).isDirectory()) throw Error('Source and tracked code/native directories must exist');
  const relative=path.relative(source,runtimeDirectory);
  if (!relative || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative))) throw Error('Runtime target must not be inside the source bundle');
  try {await fs.lstat(runtimeDirectory);throw Error('Runtime directory already exists; refusing to overwrite');}
  catch (error) {if(error.code!=='ENOENT')throw error;}
  const canonical=JSON.parse(await fs.readFile(await regularFile(codeDirectory,'asset-lock.json'),'utf8'));
  const files=lockFiles(canonical,'runtime'), nativeFiles=lockFiles(canonical,'native');
  const nativeLock=JSON.parse(await fs.readFile(await regularFile(nativeDirectory,'asset-lock.json'),'utf8'));
  if (nativeLock.version!==1 || JSON.stringify(nativeLock.files)!==JSON.stringify(nativeFiles)) throw Error('Tracked Native asset lock does not match canonical lock');
  const provenance=JSON.parse(await fs.readFile(await regularFile(codeDirectory,'vendor-provenance.json'),'utf8'));
  const pthAdaptations=new Map();
  for (const row of provenance.adaptations || []) if (row.root==='runtime') {
    const file=relativeFile(row.file);
    if (!/^resources\/speech\/python\/python\d+\._pth$/.test(file)) throw Error('Unsupported runtime byte adaptation');
    if (pthAdaptations.has(file) || !/^[a-f0-9]{64}$/.test(row.originalSha256) || !/^[a-f0-9]{64}$/.test(row.sha256)) throw Error('Invalid portable Python adaptation proof');
    pthAdaptations.set(file,row);
  }
  if (pthAdaptations.size!==1) throw Error('Expected one audited portable Python ._pth adaptation');
  const prepared=[];
  for (const row of files) {
    const fromNative=row.file.startsWith(LICENSE_PREFIX);
    const original=await regularFile(fromNative?nativeDirectory:source,fromNative?row.file.slice(LICENSE_PREFIX.length):row.file);
    const adaptation=pthAdaptations.get(row.file);
    let transformedBytes;
    if (adaptation) {
      const originalBytes=await fs.readFile(original);
      if (shaBytes(originalBytes)!==adaptation.originalSha256) throw Error(`Original Python ._pth does not match provenance: ${row.file}`);
      transformedBytes=Buffer.from(originalBytes.toString('utf8').split(/(?<=\n)/).filter(line=>line.trim().replaceAll('\\','/')!=='../../../module/src/speech').join(''));
      if (shaBytes(transformedBytes)!==adaptation.sha256) throw Error(`Python ._pth adaptation differs from provenance: ${row.file}`);
    }
    const actualBytes=transformedBytes?transformedBytes.length:(await fs.stat(original)).size;
    const actualSha=transformedBytes?shaBytes(transformedBytes):await shaFile(original);
    if (actualBytes!==row.bytes || actualSha!==row.sha256) throw Error(`Asset differs from tracked runtime lock: ${row.file}`);
    prepared.push({...row,original,transformedBytes});
  }
  for (const file of pthAdaptations.keys()) if (!files.some(row=>row.file===file)) throw Error('Python adaptation is not present in canonical runtime lock');
  // Do not create a partial runtime until every source matches the reviewed lock.
  await fs.mkdir(path.dirname(runtimeDirectory),{recursive:true});
  await noLinks(runtimeDirectory);
  // Exclusive final directory creation also rejects a concurrent initializer.
  await fs.mkdir(runtimeDirectory);
  for (const row of prepared) {
    const target=path.join(runtimeDirectory,row.file);
    await fs.mkdir(path.dirname(target),{recursive:true});
    if (row.transformedBytes) await fs.writeFile(target,row.transformedBytes);
    else await fs.copyFile(row.original,target);
    // Source files may change during a long model copy; validate the actual copy too.
    if ((await fs.stat(target)).size!==row.bytes || await shaFile(target)!==row.sha256) throw Error(`Copied asset failed final lock verification: ${row.file}; partial runtime retained`);
  }
  await fs.writeFile(path.join(runtimeDirectory,'asset-lock.json'),jsonBytes({version:1,files}));
  return {runtimeDirectory,assetFiles:files.length,trackedCodeUnchanged:true,trackedNativeUnchanged:true};
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  try {console.log(JSON.stringify(await prepareWindowsGpuRuntime(parseArguments(process.argv.slice(2))),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
