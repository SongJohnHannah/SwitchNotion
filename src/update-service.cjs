const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createDesktopPlatform } = require('./platform/index.cjs');
class UpdateService {
  constructor({ root, projectDirectory = process.env.NOTION_SWITCH_PROJECT || path.resolve(root, '..'), platform = createDesktopPlatform(), isBusy = () => false, getCompatibility = () => ({}), onRestart = () => {}, spawnImpl = spawn, load } = {}) {
    this.platform = platform;
    if (!path.isAbsolute(projectDirectory)) throw Error('项目目录必须是绝对路径。');
    this.projectDirectory = projectDirectory;
    this.root = root; this.isBusy = isBusy; this.getCompatibility = getCompatibility; this.onRestart = onRestart; this.spawnImpl = spawnImpl; this.updating = false;
    this.load = load || (() => import(pathToFileURL(path.join(this.projectDirectory, 'scripts', 'runtime-update.mjs')).href));
  }
  async request(action, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length || !['update.status', 'update.apply', 'update.rollback'].includes(action)) return { ok: false, error: '无法识别这项更新操作。' };
    try {
      const module = await this.load();
      if (action === 'update.status') {
        const value = module.updateStatus({ root: this.root, platform: this.platform }), ui = this.getCompatibility();
        return { ok: true, result: { ...value, openOnStartup: process.env.NOTION_SWITCH_UPDATE_VIEW === '1', clientCompatible: !ui.unsupportedAssets?.length,
          automaticCompatibility: { enabled: true, checked: ui.adaptedAssets?.length || 0, adapted: ui.automaticAssets?.length || 0, blocked: ui.unsupportedAssets?.length || 0 },
          ...(value.compatible && ui.unsupportedAssets?.length ? { message: '检测到网页模块的实质变化，已暂停不兼容的接管。请更新 Switch Notion；客户端回退不一定能恢复独立更新的网页模块。' } : {}) } };
      }
      this.platform.requireCapability('prepareRuntime');
      if (this.updating || this.isBusy()) throw Error('AI 或登录同步正在进行，请等待完成或停止后再更新。');
      const status = module.updateStatus({ root: this.root, platform: this.platform });
      if (action === 'update.apply' && !status.compatible) throw Error(status.message);
      if (action === 'update.rollback' && !status.previousVersion) throw Error('尚无可恢复的上一个版本。');
      this.updating = true;
      try { await this.startWorker(action === 'update.rollback' ? 'rollback' : 'update'); }
      catch { this.updating = false; throw Error('更新组件无法启动，当前原型保持运行。请通过项目内启动入口重试。'); }
      this.onRestart();
      return { ok: true, result: { message: action === 'update.rollback' ? '即将退出原型并恢复上一个版本，随后自动打开配置。' : '即将退出原型并同步更新，随后自动打开配置。登录、密钥和历史保留。' } };
    } catch (error) { return { ok: false, error: /(?:sk-|ntn_|secret_)[\w-]{8}/.test(error.message || '') ? '更新未完成，已保留现有原型。' : error.message }; }
  }
  startWorker(mode) {
    this.platform.requireCapability('prepareRuntime');
    const { nodeExecutable } = JSON.parse(fs.readFileSync(path.join(this.root, 'launcher.local.json'), 'utf8'));
    if (!this.platform.isNodeExecutable(nodeExecutable)) throw Error('Node unavailable');
    const script = path.join(this.projectDirectory, 'scripts', 'update-helper.mjs');
    return new Promise((resolve, reject) => {
      // The desktop cwd is inside runtime. Inheriting it would make this
      // surviving worker lock the directory it is about to replace on Windows.
      const child = this.spawnImpl(nodeExecutable, [script, mode, String(process.pid)], { cwd: this.projectDirectory, windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      let done = false;
      const finish = ok => { if (done) return; done = true; clearTimeout(timer); child.removeAllListeners('message'); child.removeAllListeners('exit'); child.on('error', () => {}); if (child.connected) child.disconnect(); child.unref(); ok ? resolve() : reject(Error('helper unavailable')); };
      const timer = setTimeout(() => finish(false), 10000);
      child.once('error', () => finish(false)); child.once('exit', () => finish(false)); child.once('message', value => finish(value?.ready === true));
    });
  }
}
module.exports = { UpdateService };
