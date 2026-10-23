import fs from 'node:fs';
import path from 'node:path';
export function launchLock(root) {
  const file = path.join(root, 'launch.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      let released = false;
      return () => { if (released) return; released = true; fs.closeSync(fd); try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let active = true;
      try { const { pid } = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Number.isSafeInteger(pid) || pid <= 0) active = false; else { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') active = false; } } } catch { active = false; }
      if (active) throw Error('NotionSwitch 正在准备启动，请稍候，不必重复点击。');
      fs.unlinkSync(file);
    }
  }
  throw Error('NotionSwitch 启动锁暂时不可用，请稍后重试。');
}
