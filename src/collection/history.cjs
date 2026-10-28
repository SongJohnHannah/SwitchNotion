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
module.exports = { clearCompleted };
