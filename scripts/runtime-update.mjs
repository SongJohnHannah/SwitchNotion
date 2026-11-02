import fs from './native-fs.mjs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import platformModule from '../src/platform/index.cjs';
import macRuntime from '../src/platform/macos-runtime.cjs';
import macAdapter from '../src/macos-adapter-loader.cjs';
import { inspectDesktop } from './desktop-compat.mjs';
import { prependToEntry, assertSourceUnchanged } from './asar.mjs';

export const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stateOverride = process.env.NOTION_SWITCH_ROOT;
if (stateOverride && !path.isAbsolute(stateOverride)) throw Error('运行资料目录必须是绝对路径。');
export const stateRoot = stateOverride || path.join(project, '.notion-switch', ...(process.platform === 'darwin' ? ['mac-arm64'] : []));
export const runtime = path.join(stateRoot, 'runtime');
const { createDesktopPlatform } = platformModule;
const readJson = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
function writeJson(file, value) { fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(file + '.tmp', file); }
function local(root, name) {
  const base = path.resolve(root), target = path.resolve(base, name), relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() || fs.lstatSync(base, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('更新目录校验失败。');
  for (let cursor = path.dirname(target); cursor !== base; cursor = path.dirname(cursor)) if (fs.lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('更新目录含链接，未移动文件。');
  return target;
}
function remove(root, name, platform) {
  const target = local(root, name); if (!fs.existsSync(target)) return;
  if (platform.id === 'darwin') macRuntime.removeMacRuntimeDirectory(target, { fsImpl: fs });
  else fs.rmSync(target, { recursive: true, force: true });
}
function move(root, from, to) {
  const source = local(root, from), target = local(root, to);
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(source, target); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      if (attempt >= 20) throw Object.assign(Error('运行目录仍被占用或无法访问，未能完成更新或回退。请完全退出 NotionSwitch，并关闭使用该目录的终端或程序后重试。', { cause: error }), { code: error.code });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
function copyTree(source, target) {
  fs.cpSync(source, target, { recursive: true, filter: entry => {
    if (fs.lstatSync(entry).isSymbolicLink()) throw Error('安装目录含链接，保留现有原型。');
    return !path.basename(entry).startsWith('Uninstall');
  } });
}
export function adapterHash(sourceProject) {
  const hash = createHash('sha256');
  function visit(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name); if (entry.isSymbolicLink()) throw Error('接管组件目录含链接。');
    if (entry.isDirectory()) visit(file); else { hash.update(path.relative(sourceProject, file)); hash.update(fs.readFileSync(file)); }
  } }
  visit(path.join(sourceProject, 'src')); hash.update(fs.readFileSync(new URL('./desktop-compat.mjs', import.meta.url))); return hash.digest('hex');
}
function snapshotAdapter(root, sourceProject, hash, copy) {
  const target = local(root, path.join('adapters', hash));
  if (fs.existsSync(target)) {
    try { if (macAdapter.adapterDigest(target) === hash) return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const stage = 'adapter-staging-' + randomUUID(), temporary = local(root, stage);
  try {
    copy(path.join(sourceProject, 'src'), path.join(temporary, 'src'));
    fs.copyFileSync(new URL('./desktop-compat.mjs', import.meta.url), path.join(temporary, 'desktop-compat.mjs'));
    if (macAdapter.adapterDigest(temporary) !== hash) throw Error('接管组件复制校验失败。');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // A damaged snapshot is repaired only while this runtime is stopped.
    fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
export function previousRuntime({ root = stateRoot } = {}) {
  const current = readJson(local(root, 'prepared.json')), adapter = readJson(local(root, 'adapter-previous.json'));
  if (current?.updateKind === 'adapter' && current.previousAdapterHash === adapter?.adapterHash &&
      current.sourceHash === adapter?.sourceHash && current.macBootstrapHash === adapter?.macBootstrapHash) return adapter;
  return readJson(local(root, 'runtime-previous.json'));
}
export function sourceDirectory(root = stateRoot, platform = createDesktopPlatform()) {
  const saved = readJson(local(root, 'prepared.json'));
  return platform.discoverInstallation(root)?.appRoot || saved?.source || path.join(root, 'not-installed', 'Notion');
}
export function updateStatus({ root = stateRoot, platform = createDesktopPlatform(), source = sourceDirectory(root, platform) } = {}) {
  const prepared = readJson(local(root, 'prepared.json')), last = readJson(local(root, 'update-status.json')), previous = previousRuntime({ root });
  let candidate, error;
  try {
    platform.requireCapability('prepareRuntime');
    candidate = inspectDesktop(fs.readFileSync(platform.installationLayout(source).archive), platform.compatibility);
  }
  catch (e) { error = e.message; }
  const held = last?.heldHash && last.heldHash === candidate?.hash;
  return { platform: platform.id, capabilities: platform.capabilities, prototypeVersion: prepared?.version || '未准备', originalVersion: candidate?.version || '无法识别', available: !!candidate && candidate.hash !== prepared?.sourceHash, compatible: !!candidate, previousVersion: previous?.version, held: !!held,
    message: error || (held ? '已保留上一个可用版本。需要重新尝试时点击“同步原版 Notion 并重启”。' : candidate?.hash !== prepared?.sourceHash ? platform.id === 'darwin' ? '检测到原版更新，已保留当前版本。点击“同步原版 Notion 并重启”后升级；Mac 可能要求重新授权录音。' : '检测到原版更新，下次完全退出并启动原型时自动同步。' : '当前已与本机原版 Notion 同步。'), lastResult: last?.message, checkedAt: new Date().toISOString() };
}
export function rollbackRuntime({ root = stateRoot, platform = createDesktopPlatform(), holdHash, reason = '已恢复上一个原型版本。' } = {}) {
  platform.requireCapability('prepareRuntime');
  const rejected = readJson(local(root, 'prepared.json'));
  const prior = previousRuntime({ root });
  if (!prior) throw Error('尚无可恢复的上一个版本。');
  if (rejected?.updateKind === 'adapter' && rejected.previousAdapterHash === prior.adapterHash && rejected.sourceHash === prior.sourceHash && rejected.macBootstrapHash === prior.macBootstrapHash) {
    const directory = local(root, path.join('adapters', prior.adapterHash));
    if (macAdapter.adapterDigest(directory) !== prior.adapterHash) throw Error('上一个接管组件完整性检查失败。');
    writeJson(local(root, 'prepared.json'), { ...prior, updateKind: 'runtime', pendingValidation: false });
    writeJson(local(root, 'update-status.json'), { status: 'restored', message: reason, heldAdapterHash: rejected.adapterHash, checkedAt: new Date().toISOString() });
    fs.unlinkSync(local(root, 'adapter-previous.json')); return prior;
  }
  if (!fs.existsSync(local(root, 'runtime-previous'))) throw Error('尚无可恢复的上一个版本。');
  const discarded = 'runtime-discarded-' + randomUUID();
  if (fs.existsSync(local(root, 'runtime'))) move(root, 'runtime', discarded);
  try { move(root, 'runtime-previous', 'runtime'); }
  catch (error) { if (fs.existsSync(local(root, discarded))) move(root, discarded, 'runtime'); throw error; }
  writeJson(local(root, 'prepared.json'), { ...prior, pendingValidation: false });
  writeJson(local(root, 'update-status.json'), { status: 'restored', message: reason, heldHash: holdHash || rejected?.sourceHash,
    ...(rejected?.macBootstrapHash ? { heldAdapterHash: rejected.adapterHash } : {}), checkedAt: new Date().toISOString() });
  fs.unlinkSync(local(root, 'runtime-previous.json')); remove(root, discarded, platform);
  return prior;
}
export function acceptRuntime({ root = stateRoot, platform = createDesktopPlatform() } = {}) {
  platform.requireCapability('prepareRuntime');
  const file = local(root, 'prepared.json'), current = readJson(file);
  if (current) { writeJson(file, { ...current, pendingValidation: false }); writeJson(local(root, 'update-status.json'), { status: 'applied', message: '原型已同步，启动检查通过。', checkedAt: new Date().toISOString() }); }
}
export function prepareRuntime({ root = stateRoot, platform = createDesktopPlatform(), source, sourceProject = project, force = false, copy = copyTree } = {}) {
  // Gate before mkdir, copying or rollback; discovery alone is not Mac support.
  platform.requireCapability('prepareRuntime');
  source ||= sourceDirectory(root, platform);
  fs.mkdirSync(root, { recursive: true });
  const control = readJson(local(root, 'control.json'));
  if (Number.isSafeInteger(control?.pid) && control.pid > 0) {
    let running = true; try { process.kill(control.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; }
    if (running && platform.processMatchesExecutable?.(control.pid, platform.runtimeLayout(local(root, 'runtime')).executable) === false) running = false;
    if (running) throw Error('原型尚未退出，未替换运行文件。请退出原型后重新启动。');
  }
  const marker = local(root, 'prepared.json'); let previous = readJson(marker);
  if (previous?.platform && previous.platform !== platform.id) throw Error('运行目录属于其他操作系统，请使用此电脑上的独立运行目录。');
  const validatedPrevious = previousRuntime({ root });
  if (previous?.pendingValidation && validatedPrevious && !validatedPrevious.pendingValidation) { rollbackRuntime({ root, platform, reason: '上次更新未完成启动验证，已自动恢复。' }); previous = readJson(marker); }
  const sourceLayout = platform.installationLayout(path.resolve(source)), originalPath = sourceLayout.archive;
  const runtimeLayout = platform.runtimeLayout(local(root, 'runtime'));
  const canReuse = () => fs.existsSync(runtimeLayout.executable) && fs.existsSync(runtimeLayout.archive);
  const relative = path.relative(path.resolve(root), path.resolve(source));
  if (!relative || !relative.startsWith('..') && !path.isAbsolute(relative)) throw Error('更新源不能位于原型资料目录中。');
  let stage, installed = false;
  try {
    const adapter = adapterHash(sourceProject), last = readJson(local(root, 'update-status.json'));
    const mac = platform.id === 'darwin', bootstrap = mac && createHash('sha256').update(fs.readFileSync(path.join(sourceProject, 'src/macos-adapter-loader.cjs'))).digest('hex');
    const sameBootstrap = mac && previous?.macBootstrapHash === bootstrap && canReuse() && path.basename(runtimeLayout.appRoot) === 'SwitchNotion.app' &&
      fs.existsSync(path.join(runtimeLayout.resources, 'notion-switch/macos-adapter-loader.cjs')) &&
      createHash('sha256').update(fs.readFileSync(path.join(runtimeLayout.resources, 'notion-switch/macos-adapter-loader.cjs'))).digest('hex') === bootstrap;
    let original, build, sourceError;
    try {
      if (!platform.findInstallation(source, root)) throw Error('未找到完整的官方 Notion 安装，保留现有原型。');
      original = fs.readFileSync(originalPath); build = inspectDesktop(original, platform.compatibility);
    } catch (error) {
      // An incompatible official update must not prevent fixes to an already
      // working, unchanged Mac bundle. Explicit upgrades still fail closed.
      if (!sameBootstrap || force) throw error;
      sourceError = error; build = { hash: previous.sourceHash, version: previous.version };
    }
    const deferred = mac && previous && (sourceError || previous.sourceHash !== build.hash) && !force && canReuse();
    if (!force && mac && last?.heldAdapterHash === adapter && canReuse()) return { ...previous, updateStatus: 'held', message: last.message };
    if (deferred && !sameBootstrap) return { ...previous, updateStatus: 'deferred', message: '已保留当前 Mac 客户端，确认更新后再升级。' };
    if (sameBootstrap && (previous.sourceHash === build.hash || deferred)) {
      snapshotAdapter(root, sourceProject, adapter, copy);
      if (previous.adapterHash === adapter) return { ...previous, updateStatus: deferred ? 'deferred' : 'current' };
      writeJson(local(root, 'adapter-previous.json'), previous);
      const prepared = { ...previous, adapterHash: adapter, previousAdapterHash: previous.adapterHash, updateKind: 'adapter', preparedAt: new Date().toISOString(), pendingValidation: true };
      writeJson(local(root, 'update-status.json'), { status: 'prepared', message: '已更新接管组件，正在验证启动；Mac 应用签名保持不变。', checkedAt: new Date().toISOString() });
      writeJson(marker, prepared);
      return { ...prepared, updateStatus: 'prepared', signaturePreserved: true };
    }
    if (!force && last?.heldHash === build.hash && previous?.adapterHash === adapter && canReuse()) return { ...previous, updateStatus: 'held', message: last.message };
    if (!force && !mac && previous?.sourceHash === build.hash && previous.adapterHash === adapter && canReuse()) return { ...previous, updateStatus: 'current' };
    if (mac) snapshotAdapter(root, sourceProject, adapter, copy);
    stage = 'runtime-staging-' + randomUUID(); const target = local(root, stage);
    const staged = platform.stageInstallation({ source: sourceLayout, container: target, copy });
    if (mac) { fs.mkdirSync(path.join(staged.resources, 'notion-switch'), { recursive: true }); fs.copyFileSync(path.join(sourceProject, 'src/macos-adapter-loader.cjs'), path.join(staged.resources, 'notion-switch/macos-adapter-loader.cjs')); }
    else copy(path.join(sourceProject, 'src'), path.join(staged.resources, 'notion-switch'));
    // The official installer can rewrite normal Notion shortcuts and install
    // into the clone. Only our own updater may replace this isolated runtime.
    fs.rmSync(path.join(staged.resources, 'app-update.yml'), { force: true });
    const prefix = mac ? 'require(require("node:path").join(process.resourcesPath,"notion-switch","macos-adapter-loader.cjs")).loadMacAdapter();\n' : 'require(require("node:path").join(process.resourcesPath,"notion-switch","desktop-hook.cjs"));\n';
    fs.writeFileSync(staged.archive, prependToEntry(original, build.entry, prefix));
    platform.finalizeRuntime(staged);
    assertSourceUnchanged(originalPath, build.hash);
    remove(root, 'runtime-previous', platform); if (fs.existsSync(local(root, 'runtime-previous.json'))) fs.unlinkSync(local(root, 'runtime-previous.json'));
    if (fs.existsSync(local(root, 'runtime'))) { move(root, 'runtime', 'runtime-previous'); if (previous) writeJson(local(root, 'runtime-previous.json'), previous); }
    try { move(root, stage, 'runtime'); installed = true; }
    catch (error) { if (fs.existsSync(local(root, 'runtime-previous'))) move(root, 'runtime-previous', 'runtime'); throw error; }
    const prepared = { platform: platform.id, version: build.version, source: sourceLayout.appRoot, sourceHash: build.hash, adapterHash: adapter, ...(mac ? { macBootstrapHash: bootstrap, updateKind: 'runtime' } : {}), compatibility: build.compatibility, preparedAt: new Date().toISOString(), runtime: local(root, 'runtime'), pendingValidation: true };
    writeJson(marker, prepared);
    writeJson(local(root, 'update-status.json'), { status: 'prepared', message: '已同步原版更新，正在验证启动。', checkedAt: new Date().toISOString() });
    return { ...prepared, updateStatus: 'prepared', sourceArchiveUnchanged: true };
  } catch (error) {
    if (installed && fs.existsSync(local(root, 'runtime-previous.json'))) rollbackRuntime({ root, platform, reason: '更新失败，已恢复原型。' });
    if (stage) remove(root, stage, platform);
    const message = /(?:sk-|ntn_|secret_)/.test(error.message) ? '更新未完成，保留现有原型。' : error.message;
    writeJson(local(root, 'update-status.json'), { status: 'blocked', message, checkedAt: new Date().toISOString() });
    if (previous && canReuse()) return { ...previous, updateStatus: 'blocked', message };
    throw Error(message);
  }
}
