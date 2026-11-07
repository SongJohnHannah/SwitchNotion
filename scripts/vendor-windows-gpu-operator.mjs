import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_DLL_SHA256 = '9dfdd201fc6769c611a6ba595d53489cf2f05833ac2940d02f29670b5320a20f';
const VARIANT = 'resources/speech/gpu-v1/variants/sm75-native';
const PROFILE_NAMES = ['winner', 'native30', 'native30-streaming', 'native120-complete'];
const hashBytes = data => createHash('sha256').update(data).digest('hex');
const jsonBytes = data => Buffer.from(JSON.stringify(data, null, 2) + '\n');
const isAbsolute = value => path.isAbsolute(value) || path.win32.isAbsolute(value);

export function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--source', '--project'].includes(key)) throw Error(`Unknown argument: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw Error(`${key} requires a value`);
    if (!isAbsolute(value)) throw Error(`${key} must be absolute`);
    if (Object.hasOwn(options, key.slice(2))) throw Error(`Duplicate argument: ${key}`);
    options[key.slice(2)] = value;
  }
  if (!options.source) throw Error('--source is required; the original bundle is never assumed');
  return options;
}

function relativeFile(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /[:\0]/.test(value)) throw Error('Expected a safe relative file path');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw Error('Relative path escape is forbidden');
  return parts.join('/');
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function assertNoLinks(file) {
  let current = path.resolve(file);
  while (true) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw Error(`Symlink/junction is forbidden: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function fileAt(root, relative) {
  const file = path.join(root, relativeFile(relative));
  await assertNoLinks(file);
  if (!(await fs.stat(file)).isFile()) throw Error(`Expected a regular source file: ${relative}`);
  return file;
}

async function shaFile(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

function generated(name) {
  return ['__pycache__', '.git', '.cache', '.pytest_cache', 'node_modules'].includes(name)
    || /\.(?:pyc|pyo|log|tmp|lock)$/i.test(name) || /^(?:lease|leases|outputs|records)$/i.test(name);
}

async function walk(root, subdirectory) {
  const files = [];
  async function visit(relative) {
    const absolute = path.join(root, relativeFile(relative));
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw Error(`Symlink/junction is forbidden: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(absolute)).sort()) if (!generated(name)) await visit(`${relative}/${name}`);
    } else if (stat.isFile()) files.push(relative);
    else throw Error(`Unsupported source file type: ${relative}`);
  }
  await assertNoLinks(path.join(root, subdirectory));
  await visit(relativeFile(subdirectory));
  return files;
}

async function readJson(root, relative) {
  return JSON.parse(await fs.readFile(await fileAt(root, relative), 'utf8'));
}

function pick(object, fields) {
  return Object.fromEntries(fields.filter(field => Object.hasOwn(object || {}, field)).map(field => [field, object[field]]));
}

function assertNoAbsoluteStrings(value) {
  if (typeof value === 'string' && isAbsolute(value)) throw Error('Private absolute paths are forbidden in vendored plan metadata');
  if (value && typeof value === 'object') for (const child of Object.values(value)) assertNoAbsoluteStrings(child);
}

async function snapshot(source, entryFile, revision) {
  if (!/^[a-f0-9]{64}$/.test(revision || '')) throw Error('Invalid immutable snapshot revision');
  const entry = relativeFile(entryFile), prefix = `experiments/implementations/${revision}/`;
  if (!entry.startsWith(prefix)) throw Error('Immutable entry is outside its revision directory');
  const originalManifest = await fileAt(source, prefix + 'implementation.json');
  const manifest = JSON.parse(await fs.readFile(originalManifest, 'utf8'));
  if (manifest.revision !== revision || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid immutable snapshot manifest');
  const unique = new Set();
  const rows = manifest.files.map(row => {
    const file = relativeFile(row.file);
    if (unique.has(file) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/.test(row.sha256)) throw Error('Invalid immutable snapshot file');
    unique.add(file);
    return {file,bytes:row.bytes,sha256:row.sha256};
  });
  if (hashBytes(JSON.stringify(rows)) !== revision || !unique.has(entry.slice(prefix.length)) || !unique.has('worker.py')) throw Error('Immutable snapshot revision/closure mismatch');
  for (const row of rows) {
    const file = await fileAt(source, prefix + row.file);
    if ((await fs.stat(file)).size !== row.bytes || await shaFile(file) !== row.sha256) throw Error(`Immutable snapshot changed: ${row.file}`);
  }
  const worker = await fs.readFile(await fileAt(source, prefix + 'worker.py'), 'utf8');
  if (!worker.includes('sys.path.insert(0, str(Path(__file__).resolve().parent))')) throw Error('Immutable snapshot lacks self-directory bootstrap; do not rewrite frozen code');
  return {revision,prefix,rows,manifest:{version:manifest.version,revision,...pick(manifest,['createdAt']),files:rows},originalManifestSha256:await shaFile(originalManifest)};
}

/** Fresh-only physical vendoring. Importing this module performs no I/O or writes.
 * expectedNativeDllSha256 is an injection seam for tiny CPU fixtures, not a CLI option.
 */
export async function vendorWindowsGpuOperator({source,project=PROJECT,expectedNativeDllSha256=BASELINE_DLL_SHA256}={}) {
  if (!source || !isAbsolute(source) || !isAbsolute(project)) throw Error('--source and project must be absolute');
  source = path.resolve(source); project = path.resolve(project);
  const codeDirectory = path.join(project,'src/speech/windows-operator');
  const nativeDirectory = path.join(project,'assets/windows-gpu-native');
  const runtimeDirectory = path.join(project,'.notion-switch/windows-gpu-operator');
  const destinations = [codeDirectory,nativeDirectory,runtimeDirectory];
  for (const directory of destinations) {
    await assertNoLinks(directory);
    if (within(source,directory) || within(directory,source)) throw Error('Source and destination must not overlap');
    try { await fs.lstat(directory); throw Error(`Destination already exists; refusing to overwrite: ${directory}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await assertNoLinks(source);
  const machine = await readJson(source,'machine.json');
  const fixedAssets = {resourcesRoot:'resources',pythonExecutable:'resources/speech/python/python.exe',modelDirectory:'resources/speech/model',ffmpeg:'bin/ffmpeg.exe',ffprobe:'bin/ffprobe.exe'};
  for (const [key,expected] of Object.entries(fixedAssets)) if (relativeFile(machine[key]) !== expected) throw Error(`Unexpected ${key}; only the reviewed portable layout is supported`);
  if (machine.model !== 'large-v3-turbo') throw Error('Only the validated large-v3-turbo model is admitted');
  const readyPath = await fileAt(source,`${VARIANT}/READY.json`), runtimeRevision = await shaFile(readyPath);
  const dllPath = await fileAt(source,`${VARIANT}/ctranslate2/ctranslate2.dll`);
  if (await shaFile(dllPath) !== expectedNativeDllSha256) throw Error('Native DLL does not match the original working SDK baseline');
  const copies = [], snapshots = new Map(), profiles = {};
  const addTree = async (rootName, from, to=from) => {
    for (const file of await walk(source,from)) copies.push({rootName,source:file,file:to + file.slice(from.length)});
  };
  const addSnapshot = async (entry,revision) => {
    if (!snapshots.has(revision)) snapshots.set(revision,await snapshot(source,entry,revision));
    else if (!snapshots.get(revision).rows.some(row => snapshots.get(revision).prefix + row.file === relativeFile(entry))) throw Error('Immutable entry is not in the manifest');
    return `implementations/${revision}/${relativeFile(entry).slice(snapshots.get(revision).prefix.length)}`;
  };
  for (const name of PROFILE_NAMES) {
    const original = machine.profiles?.[name];
    if (!original) { if (['winner','native30'].includes(name)) throw Error(`Missing required profile: ${name}`); continue; }
    if (original.experimental === true || ['failed','rejected','content-review-needed'].includes(original.status)) throw Error(`Profile is not admitted: ${name}`);
    if (!['winner','native30'].includes(name) && (original.experimental !== false || original.status !== 'validated-optional')) throw Error(`Optional profile is not validated: ${name}`);
    const planPath = relativeFile(original.planFile), plan = await readJson(source,planPath);
    assertNoAbsoluteStrings(plan);
    if (plan.runtimeVariant !== 'sm75-native' || plan.runtimeRevision !== runtimeRevision || plan.computeType !== 'float16') throw Error(`Profile is not bound to the stable native FP16 runtime: ${name}`);
    copies.push({rootName:'code',source:planPath,file:`plans/${name}.json`});
    profiles[name] = {...pick(original,['experimental','status','verifiedOriginalPlanId','medianSeconds','oldProjectMedianSeconds','sourceCandidate','reductionVsNative30','defaultProfile','retainedDespiteSlower','qualityBeforeSpeed','transportSeconds','innerCallMaximumSeconds','acousticMaximumSeconds','encoderFrames']),planFile:`plans/${name}.json`};
    if (original.entryFile) {
      profiles[name].entryFile = await addSnapshot(original.entryFile,original.implementationRevision);
      profiles[name].implementationRevision = original.implementationRevision;
    }
  }
  const sessionEntryFile = await addSnapshot(machine.sessionEntryFile,machine.sessionImplementationRevision);
  for (const frozen of snapshots.values()) for (const row of frozen.rows) copies.push({rootName:'code',source:frozen.prefix+row.file,file:`implementations/${frozen.revision}/${row.file}`});
  await addTree('code','module');
  // Preserve the archive's public license/reference tree, including dependency
  // notices; never substitute the project's MIT license for third-party terms.
  await addTree('code','licenses');
  await addTree('runtime','licenses');
  for (const file of ['module/src/speech/worker.py','module/src/speech-provider.cjs','module/src/speech/video-transcode.cjs']) await fileAt(source,file);
  const moduleManifest = await readJson(source,'module/package-manifest.json');
  for (const row of moduleManifest.files || []) if (await shaFile(await fileAt(source,`module/${relativeFile(row.file)}`)) !== row.sha256) throw Error(`Default SDK source manifest mismatch: ${row.file}`);
  await addTree('runtime','resources/speech/python');
  await addTree('runtime','resources/speech/model');
  await addTree('runtime',`${VARIANT}/ctranslate2`);
  await addTree('runtime',`${VARIANT}/gpu-libs`);
  await addTree('runtime',`${VARIANT}/licenses`);
  await addTree('native',`${VARIANT}/ctranslate2`,'ctranslate2');
  await addTree('native',`${VARIANT}/licenses`,'licenses');
  for (const file of ['READY.json','variant.json']) for (const rootName of ['native','runtime']) copies.push({rootName,source:`${VARIANT}/${file}`,file:rootName==='native'?file:`${VARIANT}/${file}`});
  for (const file of [fixedAssets.ffmpeg,fixedAssets.ffprobe]) {await fileAt(source,file);copies.push({rootName:'runtime',source:file,file});}
  // Validate every source and tracked PE size before creating any output directory.
  const names = new Set();
  for (const copy of copies) {
    copy.file = relativeFile(copy.file);
    const id = `${copy.rootName}/${copy.file}`;
    if (names.has(id)) throw Error(`Duplicate destination: ${id}`);
    names.add(id);
    const absolute = await fileAt(source,copy.source), stat = await fs.stat(absolute);
    if (copy.rootName === 'native' && stat.size > 100 * 1024 * 1024) {
      const handle = await fs.open(absolute,'r');
      try { const signature = Buffer.alloc(2); await handle.read(signature,0,2,0); if (signature.toString()==='MZ') throw Error('Tracked PE binary exceeds 100 MiB'); }
      finally {await handle.close();}
    }
  }
  const pythonPth = copies.filter(row => row.rootName==='runtime' && /^resources\/speech\/python\/python\d+\._pth$/.test(row.file));
  if (pythonPth.length !== 1) throw Error('Expected exactly one portable Python ._pth file');
  const originalWorker = await fs.readFile(await fileAt(source,'module/src/speech/worker.py'));
  const workerText = originalWorker.toString('utf8');
  if (!workerText.includes('from pathlib import Path') || !/^import sys\r?$/m.test(workerText)) throw Error('Default worker bootstrap seam changed');
  const bootstrap = 'sys.path.insert(0, str(Path(__file__).resolve().parent))';
  const adaptedWorker = Buffer.from(workerText.includes(bootstrap)?workerText:workerText.replace(/^import sys(\r?\n)/m,(_,eol)=>`import sys${eol}${bootstrap}${eol}`));
  const originalPth = await fs.readFile(await fileAt(source,pythonPth[0].source));
  const adaptedPth = Buffer.from(originalPth.toString('utf8').split(/(?<=\n)/).filter(line=>line.trim().replaceAll('\\','/')!=='../../../module/src/speech').join(''));
  for (const line of adaptedPth.toString('utf8').split(/\r?\n/)) {
    const value = line.trim();
    if (value && !value.startsWith('#') && value !== 'import site' && (isAbsolute(value) || value.replaceAll('\\','/').split('/').includes('..'))) throw Error('Portable Python ._pth contains another external code path');
  }
  const projectEntry = await fileAt(project,'src/speech/file-operator.cjs');
  const originalEntry = await fileAt(source,'operator.cjs');
  const adaptations = [
    {file:'operator.cjs',reason:'project entry supports separate code home and asset home',originalSha256:await shaFile(originalEntry),sha256:await shaFile(projectEntry)},
    {file:'module/src/speech/worker.py',reason:'resolve imports from this worker directory',originalSha256:hashBytes(originalWorker),sha256:hashBytes(adaptedWorker)},
    {root:'runtime',file:pythonPth[0].file,reason:'remove obsolete archive-relative module path; no replacement external path',originalSha256:hashBytes(originalPth),sha256:hashBytes(adaptedPth)}
  ];
  const curatedMachine = {version:1,...fixedAssets,model:machine.model,operatorProtocol:1,profiles,sessionEntryFile,sessionImplementationRevision:machine.sessionImplementationRevision,sessionPolicy:machine.sessionPolicy,
    hardware:pick(machine.hardware,['system','gpu','driverRequired']),
    validation:{...pick(machine.validation,['englishOnly','packagedEntryGpuValidated','recognitionMedianSeconds','oldProjectMedianSeconds','timingScope']),validationFile:'VENDORED-VALIDATION.json'}};
  assertNoAbsoluteStrings(curatedMachine);
  // All source validation above is read-only. From here onward only fresh project roots are written.
  for (const directory of destinations) await fs.mkdir(directory,{recursive:true});
  const roots = {code:codeDirectory,native:nativeDirectory,runtime:runtimeDirectory};
  for (const copy of copies) {
    const destination = path.join(roots[copy.rootName],copy.file);
    await fs.mkdir(path.dirname(destination),{recursive:true});
    await fs.copyFile(path.join(source,copy.source),destination);
  }
  await fs.copyFile(projectEntry,path.join(codeDirectory,'operator.cjs'));
  await fs.writeFile(path.join(codeDirectory,'module/src/speech/worker.py'),adaptedWorker);
  await fs.writeFile(path.join(runtimeDirectory,pythonPth[0].file),adaptedPth);
  const workerRow = moduleManifest.files?.find(row=>row.file==='src/speech/worker.py');
  if (workerRow) {workerRow.sha256=hashBytes(adaptedWorker);if(Object.hasOwn(workerRow,'bytes'))workerRow.bytes=adaptedWorker.length;}
  await fs.writeFile(path.join(codeDirectory,'module/package-manifest.json'),jsonBytes(moduleManifest));
  const frozenProof = [];
  for (const frozen of snapshots.values()) {
    const bytes = jsonBytes(frozen.manifest);
    await fs.writeFile(path.join(codeDirectory,`implementations/${frozen.revision}/implementation.json`),bytes);
    frozenProof.push({revision:frozen.revision,files:frozen.rows.length,originalManifestSha256:frozen.originalManifestSha256,manifestSha256:hashBytes(bytes),manifestAdaptation:'remove private source/snapshot absolute metadata; listed source bytes and revision unchanged'});
  }
  await fs.writeFile(path.join(codeDirectory,'machine.json'),jsonBytes(curatedMachine));
  await fs.writeFile(path.join(codeDirectory,'VENDORED-VALIDATION.json'),jsonBytes({version:1,scope:'Imported previously validated Windows CUDA English profiles; no GPU executed by vendor script',defaultProfile:'winner',profiles:Object.fromEntries(Object.entries(profiles).map(([name,value])=>[name,pick(value,['status','medianSeconds','sourceCandidate','implementationRevision'])])),runtimeRevision,humanWerVerified:false}));
  await fs.writeFile(path.join(codeDirectory,'vendor-provenance.json'),jsonBytes({version:1,nativeBaseline:{sha256:expectedNativeDllSha256,source:'original working SDK Native sm75 DLL'},runtimeRevision,adaptations,frozenImplementations:frozenProof,defaultModuleManifest:{originalSha256:await shaFile(await fileAt(source,'module/package-manifest.json')),sha256:await shaFile(path.join(codeDirectory,'module/package-manifest.json'))},sourceMachineSha256:await shaFile(await fileAt(source,'machine.json')),containsUserOutputs:false,physicalCopies:true}));
  const canonical = [];
  for (const root of ['native','runtime']) {
    const files = [];
    // Enumerate the actual copies (not a broad directory scan) to make this an explicit packaging allowlist.
    for (const file of copies.filter(row=>row.rootName===root).map(row=>row.file).sort()) {
      const absolute = path.join(roots[root],file);
      files.push({file,bytes:(await fs.stat(absolute)).size,sha256:await shaFile(absolute)});
    }
    await fs.writeFile(path.join(roots[root],'asset-lock.json'),jsonBytes({version:1,files}));
    canonical.push(...files.map(entry=>({root,...entry})));
  }
  await fs.writeFile(path.join(codeDirectory,'asset-lock.json'),jsonBytes({version:1,files:canonical}));
  const payloadFiles = [];
  for (const file of await walk(project,'src/speech/windows-operator')) {
    const relative = file.slice('src/speech/windows-operator/'.length), absolute = path.join(project,file);
    payloadFiles.push({file:relative,bytes:(await fs.stat(absolute)).size,sha256:await shaFile(absolute)});
  }
  await fs.writeFile(path.join(codeDirectory,'source-manifest.json'),jsonBytes({version:1,files:payloadFiles}));
  return {codeDirectory,nativeDirectory,runtimeDirectory,profiles:Object.keys(profiles),assetFiles:canonical.length,nativeBaselineSha256:expectedNativeDllSha256};
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {console.log(JSON.stringify(await vendorWindowsGpuOperator(parseArguments(process.argv.slice(2))),null,2));}
  catch (error) {console.error(error.message);process.exitCode=1;}
}
