import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const required = ['gpu-file.cjs', 'provider.cjs', 'platform.cjs', 'discovery.cjs', 'wav.cjs', 'transcript-quality.cjs',
  'worker.py', 'faster_backend.py', 'recognition.py', 'segmentation.py', 'segmentation.json', 'models.json'];
function readSources(directory) {
  const files = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && /\.(?:cjs|js|mjs|py|json)$/.test(entry.name) || entry.isFile() && entry.name === 'requirements.txt').map(entry => entry.name).sort();
  for (const file of required) if (!files.includes(file)) throw Error('GPU 实现源码不完整：' + file);
  return files.map(file => { const data = fs.readFileSync(path.join(directory, file)); return { file, bytes: data.length, sha256: hash(data), data }; });
}
const revisionFor = sources => hash(JSON.stringify(sources.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 }))));

/** Freeze each admission's Node and Python source tree. New edits create a new
 * absolute module path; existing functions and worker paths are never reloaded.
 */
export function loadGpuImplementation({ root, sourceDirectory = path.resolve(import.meta.dirname, '../src/speech'), cacheDirectory = path.join(root, 'speech/gpu-v1/implementations') } = {}) {
  if (![sourceDirectory, cacheDirectory].every(value => typeof value === 'string' && path.isAbsolute(value))) throw Error('GPU 实现源码和快照目录须为绝对路径。');
  let sources, revision;
  for (let attempt = 0; attempt < 3; attempt++) {
    sources = readSources(sourceDirectory); revision = revisionFor(sources);
    if (revision === revisionFor(readSources(sourceDirectory))) break;
    if (attempt === 2) throw Error('GPU 源码仍在修改，未发布不一致的执行快照。');
  }
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const snapshotDirectory = path.join(cacheDirectory, revision), manifestFile = path.join(snapshotDirectory, 'implementation.json');
  if (!fs.existsSync(manifestFile)) {
    const staging = path.join(cacheDirectory, '.' + revision + '.' + randomUUID() + '.tmp'); fs.mkdirSync(staging);
    for (const source of sources) fs.writeFileSync(path.join(staging, source.file), source.data, { flush: true });
    fs.writeFileSync(path.join(staging, 'implementation.json'), JSON.stringify({ version: 1, revision, createdAt: new Date().toISOString(), sourceDirectory,
      snapshotDirectory, files: sources.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })) }, null, 2), { flush: true });
    try { fs.renameSync(staging, snapshotDirectory); }
    catch (error) {
      if (!fs.existsSync(manifestFile)) throw error;
      if (path.dirname(fs.realpathSync(staging)) !== fs.realpathSync(cacheDirectory)) throw Error('拒绝清理快照目录之外的路径。');
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  if (manifest.revision !== revision || manifest.files.some(file => hash(fs.readFileSync(path.join(snapshotDirectory, file.file))) !== file.sha256)) throw Error('GPU 实现快照校验失败，未执行被修改的快照。');
  const implementation = require(path.join(snapshotDirectory, 'gpu-file.cjs'));
  if (typeof implementation.normalizePlan !== 'function' || typeof implementation.transcribeGpuFile !== 'function') throw Error('GPU 实现缺少必需入口。');
  return { ...implementation, manifest, revision, snapshotDirectory, manifestFile };
}
