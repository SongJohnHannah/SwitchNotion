import fs from './native-fs.mjs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findNotion } from './source-discovery.mjs';
import { inspectDesktop } from './desktop-compat.mjs';
import { prependToEntry, assertSourceUnchanged } from './asar.mjs';

export const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const stateRoot = path.join(project, '.notion-switch');
export const runtime = path.join(stateRoot, 'runtime');
const readJson = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
function writeJson(file, value) { fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(file + '.tmp', file); }
function local(root, name) {
  const base = path.resolve(root), target = path.resolve(base, name), relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() || fs.lstatSync(base, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('更新目录校验失败。');
  for (let cursor = path.dirname(target); cursor !== base; cursor = path.dirname(cursor)) if (fs.lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('更新目录含链接，未移动文件。');
  return target;
}
function remove(root, name) { const target = local(root, name); if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); }
function move(root, from, to) {
  const source = local(root, from), target = local(root, to);
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(source, target); return; }
    catch (error) { if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
}
function copyTree(source, target) {
  fs.cpSync(source, target, { recursive: true, filter: entry => {
    if (fs.lstatSync(entry).isSymbolicLink()) throw Error('安装目录含链接，保留现有原型。');
    return !path.basename(entry).startsWith('Uninstall');
  } });
}
function adapterHash(sourceProject) {
  const hash = createHash('sha256');
  function visit(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name); if (entry.isSymbolicLink()) throw Error('接管组件目录含链接。');
    if (entry.isDirectory()) visit(file); else { hash.update(path.relative(sourceProject, file)); hash.update(fs.readFileSync(file)); }
  } }
  visit(path.join(sourceProject, 'src')); hash.update(fs.readFileSync(new URL('./desktop-compat.mjs', import.meta.url))); return hash.digest('hex');
}
export function sourceDirectory(root = stateRoot) {
  const saved = readJson(local(root, 'prepared.json'));
  return findNotion(root) || saved?.source || path.join(root, 'not-installed', 'Notion');
}
export function updateStatus({ root = stateRoot, source = sourceDirectory(root) } = {}) {
  const prepared = readJson(local(root, 'prepared.json')), last = readJson(local(root, 'update-status.json')), previous = readJson(local(root, 'runtime-previous.json'));
  let candidate, error;
  try { candidate = inspectDesktop(fs.readFileSync(path.join(source, 'resources', 'app.asar'))); }
  catch (e) { error = e.message; }
  const held = last?.heldHash && last.heldHash === candidate?.hash;
  return { prototypeVersion: prepared?.version || '未准备', originalVersion: candidate?.version || '无法识别', available: !!candidate && candidate.hash !== prepared?.sourceHash, compatible: !!candidate, previousVersion: previous?.version, held: !!held,
    message: error || (held ? '已保留上一个可用版本。需要重新尝试时点击“更新并重启”。' : candidate?.hash !== prepared?.sourceHash ? '检测到原版更新，下次完全退出并启动原型时自动同步。' : '当前已与本机原版 Notion 同步。'), lastResult: last?.message, checkedAt: new Date().toISOString() };
}
export function rollbackRuntime({ root = stateRoot, holdHash, reason = '已恢复上一个原型版本。' } = {}) {
  const prior = readJson(local(root, 'runtime-previous.json'));
  if (!prior || !fs.existsSync(local(root, 'runtime-previous'))) throw Error('尚无可恢复的上一个版本。');
  const rejected = readJson(local(root, 'prepared.json'));
  const discarded = 'runtime-discarded-' + randomUUID();
  if (fs.existsSync(local(root, 'runtime'))) move(root, 'runtime', discarded);
  try { move(root, 'runtime-previous', 'runtime'); }
  catch (error) { if (fs.existsSync(local(root, discarded))) move(root, discarded, 'runtime'); throw error; }
  writeJson(local(root, 'prepared.json'), { ...prior, pendingValidation: false });
  writeJson(local(root, 'update-status.json'), { status: 'restored', message: reason, heldHash: holdHash || rejected?.sourceHash, checkedAt: new Date().toISOString() });
  fs.unlinkSync(local(root, 'runtime-previous.json')); remove(root, discarded);
  return prior;
}
export function acceptRuntime({ root = stateRoot } = {}) {
  const file = local(root, 'prepared.json'), current = readJson(file);
  if (current) { writeJson(file, { ...current, pendingValidation: false }); writeJson(local(root, 'update-status.json'), { status: 'applied', message: '原型已同步，启动检查通过。', checkedAt: new Date().toISOString() }); }
}
export function prepareRuntime({ root = stateRoot, source = sourceDirectory(root), sourceProject = project, force = false, copy = copyTree } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const control = readJson(local(root, 'control.json'));
  if (Number.isSafeInteger(control?.pid) && control.pid > 0) {
    let running = true; try { process.kill(control.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; }
    if (running) throw Error('原型尚未退出，未替换运行文件。请退出原型后重新启动。');
  }
  const marker = local(root, 'prepared.json'); let previous = readJson(marker);
  if (previous?.pendingValidation && fs.existsSync(local(root, 'runtime-previous'))) { rollbackRuntime({ root, reason: '上次更新未完成启动验证，已自动恢复。' }); previous = readJson(marker); }
  const originalPath = path.join(path.resolve(source), 'resources', 'app.asar');
  const relative = path.relative(path.resolve(root), path.resolve(source));
  if (!relative || !relative.startsWith('..') && !path.isAbsolute(relative)) throw Error('更新源不能位于原型资料目录中。');
  let stage, installed = false;
  try {
    const original = fs.readFileSync(originalPath), build = inspectDesktop(original), adapter = adapterHash(sourceProject);
    const last = readJson(local(root, 'update-status.json'));
    if (!force && last?.heldHash === build.hash && previous && fs.existsSync(local(root, 'runtime/Notion.exe'))) return { ...previous, updateStatus: 'held', message: last.message };
    if (!force && previous?.sourceHash === build.hash && previous.adapterHash === adapter && fs.existsSync(local(root, 'runtime/Notion.exe'))) return { ...previous, updateStatus: 'current' };
    stage = 'runtime-staging-' + randomUUID(); const target = local(root, stage);
    copy(source, target);
    if (!fs.existsSync(path.join(target, 'Notion.exe'))) throw Error('Notion 安装文件不完整。');
    copy(path.join(sourceProject, 'src'), path.join(target, 'resources', 'notion-switch'));
    const prefix = 'require(require("node:path").join(process.resourcesPath,"notion-switch","desktop-hook.cjs"));\n';
    fs.writeFileSync(path.join(target, 'resources', 'app.asar'), prependToEntry(original, build.entry, prefix));
    assertSourceUnchanged(originalPath, build.hash);
    remove(root, 'runtime-previous'); if (fs.existsSync(local(root, 'runtime-previous.json'))) fs.unlinkSync(local(root, 'runtime-previous.json'));
    if (fs.existsSync(local(root, 'runtime'))) { move(root, 'runtime', 'runtime-previous'); if (previous) writeJson(local(root, 'runtime-previous.json'), previous); }
    try { move(root, stage, 'runtime'); installed = true; }
    catch (error) { if (fs.existsSync(local(root, 'runtime-previous'))) move(root, 'runtime-previous', 'runtime'); throw error; }
    const prepared = { version: build.version, source: path.resolve(source), sourceHash: build.hash, adapterHash: adapter, compatibility: build.compatibility, preparedAt: new Date().toISOString(), runtime: local(root, 'runtime'), pendingValidation: true };
    writeJson(marker, prepared);
    writeJson(local(root, 'update-status.json'), { status: 'prepared', message: '已同步原版更新，正在验证启动。', checkedAt: new Date().toISOString() });
    return { ...prepared, updateStatus: 'prepared', sourceArchiveUnchanged: true };
  } catch (error) {
    if (installed && fs.existsSync(local(root, 'runtime-previous.json'))) rollbackRuntime({ root, reason: '更新失败，已恢复原型。' });
    if (stage) remove(root, stage);
    const message = /(?:sk-|ntn_|secret_)/.test(error.message) ? '更新未完成，保留现有原型。' : error.message;
    writeJson(local(root, 'update-status.json'), { status: 'blocked', message, checkedAt: new Date().toISOString() });
    if (previous && fs.existsSync(local(root, 'runtime/Notion.exe'))) return { ...previous, updateStatus: 'blocked', message };
    throw Error(message);
  }
}
