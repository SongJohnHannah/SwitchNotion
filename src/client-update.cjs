const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const repository = 'SongJohnHannah/SwitchNotion';
const revision = value => /^[a-f\d]{40}$/.test(value || '');
const required = ['package.json', 'src/desktop-hook.cjs', 'src/update-service.cjs', 'scripts/start-desktop.mjs', 'scripts/runtime-update.mjs'];
function approvedRemote(value) {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@(?:github\.com|ssh\.github\.com)(?::443)?\/)SongJohnHannah\/SwitchNotion(?:\.git)?$/i.test(value);
}
class ClientUpdate {
  constructor({ root, projectDirectory, run } = {}) {
    this.root = root; this.project = projectDirectory;
    this.file = path.join(root, 'client-update.local.json');
    this.run = run || ((args, timeout = 15000) => new Promise((resolve, reject) => {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
      Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10' });
      execFile('git', args, { cwd: this.project, env, windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) reject(Object.assign(Error(error.code === 'ENOENT' ? '未找到 Git，请安装 Git 后再更新 Switch Notion。' : '代码仓库操作未完成。'), { code: error.code }));
        else resolve(stdout.trim());
      });
    }));
  }
  save(status, message, plan = {}, progress = null) {
    const value = { status, message, checkedAt: new Date().toISOString(), ...(revision(plan.before) ? { before: plan.before } : {}), ...(revision(plan.after) ? { after: plan.after } : {}), ...(Number.isFinite(progress) ? { progress } : {}) };
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file);
  }
  last() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; } }
  async inspect({ clean = false } = {}) {
    const top = await this.run(['rev-parse', '--show-toplevel']);
    if (fs.realpathSync(top) !== fs.realpathSync(this.project)) throw Error('当前安装不是独立的 Switch Notion 源码仓库，无法直接更新代码。');
    const remote = await this.run(['remote', 'get-url', 'origin']);
    if (!approvedRemote(remote)) throw Error('更新来源不是已识别的 Switch Notion 仓库，已保留当前代码。');
    const branch = await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch !== 'main') throw Error('当前不在 main 分支，请切回 main 后更新。');
    const head = await this.run(['rev-parse', '--verify', 'HEAD']);
    if (!revision(head)) throw Error('无法识别当前代码版本。');
    if (clean && await this.run(['status', '--porcelain', '--untracked-files=normal'])) throw Error('项目中有未提交的改动，请先提交或保存到其他位置，再更新；本地改动已保留。');
    return { head, remote };
  }
  async status() {
    const last = this.last();
    try {
      const { head } = await this.inspect();
      return { supported: true, revision: head.slice(0, 7), message: '点击更新会下载最新代码并运行测试，完成后自动重启。', last };
    } catch (error) { return { supported: false, message: error.message, last }; }
  }
  async prepare() {
    const { head: before, remote } = await this.inspect({ clean: true });
    this.save('checking', '正在检查 Switch Notion 更新…', {}, 10);
    const remotes = [remote];
    if (remote.startsWith('https://')) remotes.push('git@github.com:' + repository + '.git');
    let fetched = false;
    for (const source of remotes) {
      try { await this.run(['fetch', '--no-tags', source, 'main:refs/remotes/origin/main'], 25000); fetched = true; break; } catch {}
    }
    if (!fetched) throw Error('无法下载 Switch Notion 更新，请检查网络和 GitHub 登录后重试；当前代码未更改。');
    const after = await this.run(['rev-parse', '--verify', 'refs/remotes/origin/main']);
    if (!revision(after)) throw Error('远程代码版本无效，未应用更新。');
    if (before === after) { this.save('current', 'Switch Notion 已是最新代码。', { before, after }, 100); return { before, after, available: false }; }
    try { await this.run(['merge-base', '--is-ancestor', before, after]); }
    catch { throw Error('本地和远程代码已有分歧，无法直接更新；本地提交已保留。'); }
    for (const file of required) {
      try { await this.run(['cat-file', '-e', after + ':' + file]); }
      catch { throw Error('下载的更新缺少必要启动文件，未应用更新。'); }
    }
    this.save('downloaded', '更新已下载，等待重启应用。', { before, after }, 30);
    return { before, after, available: true };
  }
  async apply(plan) {
    if (!revision(plan?.before) || !revision(plan?.after)) throw Error('更新版本参数无效。');
    const current = await this.inspect({ clean: true });
    if (current.head !== plan.before) throw Error('下载期间本地代码发生变化，已取消更新。');
    await this.run(['merge-base', '--is-ancestor', plan.before, plan.after]);
    this.save('applying', '正在应用代码并重启 Switch Notion…', plan, 45);
    await this.run(['merge', '--ff-only', '--no-edit', plan.after]);
    if ((await this.inspect()).head !== plan.after) throw Error('代码更新未完成。');
  }
  async restore(plan) {
    const current = await this.inspect({ clean: true });
    if (!revision(plan?.before) || !revision(plan?.after) || current.head !== plan.after) throw Error('代码已发生变化，未自动回退，请检查本地项目。');
    if (plan.before === plan.after) { this.save('blocked', '本地新代码未通过启动检查，已保留此前可用的运行版本。', plan); return; }
    // Only undo our own fast-forward. --keep refuses to overwrite local edits.
    await this.run(['reset', '--keep', plan.before]);
    this.save('restored', '新代码未通过启动检查，已恢复更新前的代码。', plan);
  }
}
module.exports = { ClientUpdate, approvedRemote };
