const fs = require('node:fs');
const path = require('node:path');
function clearCompleted(root, directory, id) {
  if (!/^[a-f\d-]{36}$/i.test(id)) throw Error('收集记录标识无效。');
  const target = path.resolve(directory, 'jobs', id), expected = path.resolve(root, 'collection', 'jobs');
  if (path.dirname(target) !== expected) throw Error('收集记录清理路径无效。');
  // Only delete this collector's owned tree, never a selected source or exported copy.
  const check = current => {
    const stat = fs.lstatSync(current); if (stat.isSymbolicLink()) throw Error('收集记录包含目录链接，未清理。');
    if (stat.isDirectory()) for (const entry of fs.readdirSync(current)) check(path.join(current, entry));
  };
  for (const parent of [root, path.join(root, 'collection'), expected]) if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('收集记录目录不能使用链接。');
  if (fs.existsSync(target)) check(target);
  const journal = path.join(root, 'write-journal');
  if (fs.lstatSync(journal, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('写入记录目录不能使用链接。');
  if (fs.existsSync(journal)) for (const name of fs.readdirSync(journal)) {
    if (!/^content-[a-f\d]{64}\.json$/.test(name)) continue;
    const file = path.join(journal, name); if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) continue;
    let value; try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (value.operation_scope === 'collection:' + id || value.operation_scope?.startsWith('collection:' + id + ':')) fs.unlinkSync(file);
  }
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
}
function ownedExport(job) {
  if (!job.exportDirectory || !job.exportOwned) return null;
  const target = path.resolve(job.exportDirectory);
  const expectedParent = job.exportBaseDirectory && path.resolve(job.exportBaseDirectory);
  const legacy = !expectedParent && path.basename(target).startsWith('收集-') && path.basename(target).endsWith('-' + job.id.slice(0, 8));
  if (!path.isAbsolute(job.exportDirectory) || (expectedParent ? expectedParent !== path.dirname(target) : !legacy)) throw Error('任务下载目录无效，未删除。');
  for (let current = target; ; current = path.dirname(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('任务下载目录包含链接，未删除。');
    if (current === path.dirname(current)) break;
  }
  if (!fs.existsSync(target)) return null;
  const marker = path.join(target, '.switch-notion-task.json');
  if (!fs.lstatSync(marker, { throwIfNoEntry: false })?.isFile() || fs.lstatSync(marker).isSymbolicLink()) throw Error('无法确认下载目录属于此任务，未删除。');
  const owner = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (owner.version !== 1 || owner.taskId !== job.id) throw Error('下载目录属于其他任务，未删除。');
  const check = current => { const stat = fs.lstatSync(current); if (stat.isSymbolicLink()) throw Error('下载文件包含链接，未删除。'); if (stat.isDirectory()) for (const name of fs.readdirSync(current)) check(path.join(current, name)); };
  check(target); return target;
}
module.exports = { clearCompleted, ownedExport };
