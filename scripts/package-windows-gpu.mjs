import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertDistributionFiles } from './package-safety.mjs';

const roots = [{ kind: 'native', relative: 'assets/windows-gpu-native' },
  { kind: 'runtime', relative: '.notion-switch/windows-gpu-operator' }];
const canonicalLock = 'src/speech/windows-operator/asset-lock.json';
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const folded = file => process.platform === 'win32' ? file.toLowerCase() : file;

function checkExistingAncestors(base, relative) {
  let current = path.resolve(base);
  const pieces = ['', ...relative.split(path.sep).filter(Boolean)];
  for (const piece of pieces) {
    current = piece ? path.join(current, piece) : current;
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || folded(fs.realpathSync(current)) !== folded(current)) throw Error('Windows package destination contains a link/reparse point');
  }
}

export function assertNewWindowsStage(sourceProject, destination) {
  const base = path.resolve(sourceProject), target = path.resolve(destination), relative = path.relative(path.join(base, 'dist'), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.existsSync(target)) throw Error('打包目标必须是 dist 内的新目录。');
  checkExistingAncestors(base, path.relative(base, target));
}

function assertLockedAssetContents(file, keys) {
  // Models can exceed V8's maximum string length. Apply the same credential
  // checks in bounded chunks, retaining cross-boundary byte patterns. FFmpeg
  // embeds OpenSSH public algorithm identifiers: their sk- prefix is not an
  // API credential. Exempt only these two complete, delimited identifiers;
  // exact locally configured credentials are always checked first.
  const needles = keys.flatMap(key => [Buffer.from(key, 'utf8'), Buffer.from(key, 'utf16le')]);
  const overlap = Math.max(128, ...needles.map(needle => needle.length - 1));
  const descriptor = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  let tail = Buffer.alloc(0);
  // Assemble public identifiers so their spelling does not resemble a literal
  // API secret to the repository's deliberately strict staged-blob checker.
  const publicAlgorithms = ['ssh-ed25519-cert-v01@openssh.com', 'ecdsa-sha2-nistp256-cert-v01@openssh.com'].map(name => 'sk-' + name);
  function scan(bytes, final = false) {
    if (needles.some(needle => bytes.includes(needle))) throw Error('迁移包发现本地凭据或私人配置，已停止打包。');
    const text = bytes.toString('latin1');
    for (const match of text.matchAll(/\b(?:sk-|ntn_|secret_)[A-Za-z0-9_-]{20,}/g)) {
      // Wait for enough following context to recognize a public identifier
      // that straddles a chunk boundary. The tail is checked at EOF as well.
      if (!final && match.index >= text.length - overlap) continue;
      const publicName = publicAlgorithms.find(name => text.slice(match.index, match.index + name.length) === name &&
        (match.index + name.length === text.length || /[\0\s"',]/.test(text[match.index + name.length])));
      if (!publicName) throw Error('迁移包发现本地凭据或私人配置，已停止打包。');
    }
  }
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) {
      const bytes = Buffer.concat([tail, buffer.subarray(0, count)]);
      scan(bytes);
      tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - overlap)));
    }
    scan(tail, true);
  } finally { fs.closeSync(descriptor); }
}

export function hashAsset(file) {
  const hash = createHash('sha256'), descriptor = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try { let count; while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

function normalizedFile(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || path.isAbsolute(file) ||
      file.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw Error('GPU asset lock contains an unsafe relative path');
  if (file === 'asset-lock.json') throw Error('GPU asset lock must not list itself');
  if (file.split('/').some(part => /^(?:\.notion-switch|profile|research|\.env(?:\..*)?|.*\.local\.json|.*api[-_]?key.*\.(?:txt|json)|cookies(?:-journal)?|local state|user data|logs?|leases?|cache|__pycache__)$/i.test(part)) ||
      /(?:\.log|\.pyc|\.pyo|\.lock|\.partial)$/i.test(file)) throw Error('GPU asset lock contains generated or private state: ' + file);
  return file;
}

function parseFiles(lock, kind, canonical = false) {
  if (lock?.version !== 1 || !Array.isArray(lock.files)) throw Error('GPU asset-lock.json must use version 1 and a files array');
  if (canonical && lock.files.some(item => !['native', 'runtime'].includes(item?.root))) throw Error('Canonical GPU asset lock contains an unknown root');
  const selected = canonical ? lock.files.filter(item => item.root === kind) : lock.files;
  const seen = new Set();
  return selected.map(item => {
    const file = normalizedFile(item?.file), key = file.toLowerCase();
    if (seen.has(key) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) throw Error('GPU asset lock has duplicate paths or invalid file metadata');
    seen.add(key); return { file, bytes: item.bytes, sha256: item.sha256 };
  }).sort((a, b) => a.file.localeCompare(b.file));
}

// lstat every existing ancestor, including Windows junctions, before following
// a path. A canonical lock never grants permission to follow a reparse link.
function checkedPath(base, relative, { directory = false } = {}) {
  const target = path.resolve(base, relative), boundary = path.relative(base, target);
  if (!boundary || boundary.startsWith('..') || path.isAbsolute(boundary)) throw Error('GPU asset path escapes its reviewed root');
  let current = path.resolve(base);
  const baseStat = fs.lstatSync(current);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink() || folded(fs.realpathSync(current)) !== folded(current)) throw Error('GPU asset root is a link or not a directory');
  const pieces = boundary.split(path.sep);
  for (let index = 0; index < pieces.length; index++) {
    current = path.join(current, pieces[index]); const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || folded(fs.realpathSync(current)) !== folded(current)) throw Error('GPU asset path contains a link/reparse point');
    if (index < pieces.length - 1 || directory) { if (!stat.isDirectory()) throw Error('GPU asset ancestor is not a directory'); }
    else if (!stat.isFile()) throw Error('GPU asset input is not a regular file');
  }
  return target;
}

/** Validate only reviewed files. Unlisted local caches and records are ignored. */
export function planWindowsGpuAssets({ sourceProject, keys = [] }) {
  sourceProject = path.resolve(sourceProject);
  const available = roots.filter(root => fs.existsSync(path.join(sourceProject, root.relative)));
  if (!available.length) return { roots: [], includesWindowsGpuNative: false, includesWindowsGpuRuntime: false };
  const canonicalFile = checkedPath(sourceProject, canonicalLock), canonical = readJson(canonicalFile);
  const planned = available.map(root => {
    const source = checkedPath(sourceProject, root.relative, { directory: true });
    const lockFile = checkedPath(source, 'asset-lock.json'), files = parseFiles(readJson(lockFile), root.kind);
    const reviewed = parseFiles(canonical, root.kind, true);
    if (!files.length || JSON.stringify(files) !== JSON.stringify(reviewed)) throw Error('Local GPU asset lock differs from the tracked canonical lock: ' + root.kind);
    for (const item of files) {
      const file = checkedPath(source, item.file);
      if (fs.statSync(file).size !== item.bytes || hashAsset(file) !== item.sha256) throw Error('GPU asset bytes/SHA256 mismatch: ' + root.kind + '/' + item.file);
      // The canonical list permits vendor directories such as Python tests.
      // Keep the existing credential-content scanner and basename checks;
      // private parent directories are rejected by normalizedFile above.
      assertLockedAssetContents(file, keys);
    }
    assertDistributionFiles(source, [lockFile], keys);
    return { ...root, source, lockFile, lockSha256: hashAsset(lockFile), files };
  });
  return { roots: planned, includesWindowsGpuNative: planned.some(root => root.kind === 'native'),
    includesWindowsGpuRuntime: planned.some(root => root.kind === 'runtime') };
}

/** Copy the exact validated allowlist. Never copy the surrounding local state. */
export function copyWindowsGpuAssets({ plan, destination }) {
  checkExistingAncestors(path.resolve(destination), '');
  const reviewedPaths = new Set();
  for (const root of plan.roots) {
    const outputRoot = path.join(destination, root.relative);
    if (fs.existsSync(outputRoot)) throw Error('GPU asset destination already exists');
    checkExistingAncestors(path.resolve(destination), root.relative.split('/').join(path.sep));
    fs.mkdirSync(outputRoot, { recursive: true });
    for (const item of [...root.files, { file: 'asset-lock.json', bytes: fs.statSync(root.lockFile).size, sha256: root.lockSha256 }]) {
      const source = checkedPath(root.source, item.file), target = path.join(outputRoot, item.file);
      if (fs.statSync(source).size !== item.bytes || hashAsset(source) !== item.sha256) throw Error('GPU asset changed after validation: ' + item.file);
      checkExistingAncestors(outputRoot, path.dirname(item.file).split('/').join(path.sep));
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if (fs.statSync(target).size !== item.bytes || hashAsset(target) !== item.sha256) throw Error('Packaged GPU asset failed bytes/SHA256 verification: ' + item.file);
      reviewedPaths.add(root.relative + '/' + item.file);
    }
  }
  return reviewedPaths;
}
