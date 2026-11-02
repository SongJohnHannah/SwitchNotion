const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createDesktopPlatform } = require('./platform/index.cjs');
const { ClientUpdate } = require('./client-update.cjs');
class UpdateService {
  constructor({ root, projectDirectory = process.env.NOTION_SWITCH_PROJECT || path.resolve(root, '..'), platform = createDesktopPlatform(), isBusy = () => false, getCompatibility = () => ({}), onRestart = () => {}, spawnImpl = spawn, load, clientUpdates } = {}) {
    this.platform = platform;
    if (!path.isAbsolute(projectDirectory)) throw Error('项目目录必须是绝对路径。');
    this.projectDirectory = projectDirectory;
    this.root = root; this.isBusy = isBusy; this.getCompatibility = getCompatibility; this.onRestart = onRestart; this.spawnImpl = spawnImpl; this.updating = false;
    try { this.loadedAdapterHash = JSON.parse(fs.readFileSync(path.join(root, 'prepared.json'), 'utf8')).adapterHash; } catch {}
    this.clientUpdates = clientUpdates || new ClientUpdate({ root, projectDirectory });
    this.load = load || (() => import(pathToFileURL(path.join(this.projectDirectory, 'scripts', 'runtime-update.mjs')).href));
  }
  async request(action, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length || !['update.status', 'update.apply', 'update.rollback', 'update.client'].includes(action)) return { ok: false, error: '无法识别这项更新操作。' };
    try {
      if (action === 'update.client') return await this.updateClient();
      const module = await this.load();
      if (action === 'update.status') {
        const value = module.updateStatus({ root: this.root, platform: this.platform }), ui = this.getCompatibility();
        const client = await this.clientUpdates.status(); client.needsRestart = await this.needsClientRestart(module);
        return { ok: true, result: { ...value, client, openOnStartup: process.env.NOTION_SWITCH_UPDATE_VIEW === '1', clientCompatible: !ui.unsupportedAssets?.length,
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
  async needsClientRestart(module) {
    if (!this.loadedAdapterHash) return false;
    module ||= await this.load();
    return typeof module.adapterHash === 'function' && module.adapterHash(this.projectDirectory) !== this.loadedAdapterHash;
  }
  async updateClient() {
    this.platform.requireCapability('prepareRuntime');
    if (this.updating || this.isBusy()) throw Error('录音、AI 或其他任务正在进行，请结束后再更新。');
    this.updating = true;
    try {
      const plan = await this.clientUpdates.prepare();
      if (!plan.available && !await this.needsClientRestart()) { this.updating = false; return { ok: true, result: { message: 'Switch Notion 已是最新代码，无需重启。' } }; }
      if (this.isBusy()) throw Error('更新已下载，请先结束正在进行的录音或任务，再点击更新。');
      await this.startWorker('client', [plan.before, plan.after]);
      this.onRestart();
      return { ok: true, result: { message: '更新已下载，即将自动重启 Switch Notion 并接入新代码。' } };
    } catch (error) {
      this.updating = false; this.clientUpdates.save('blocked', error.message); throw error;
    }
  }
  startWorker(mode, revisions = []) {
    this.platform.requireCapability('prepareRuntime');
    const { nodeExecutable } = JSON.parse(fs.readFileSync(path.join(this.root, 'launcher.local.json'), 'utf8'));
    if (!this.platform.isNodeExecutable(nodeExecutable)) throw Error('Node unavailable');
    const script = path.join(this.projectDirectory, 'scripts', 'update-helper.mjs');
    return new Promise((resolve, reject) => {
      // The desktop cwd is inside runtime. Inheriting it would make this
      // surviving worker lock the directory it is about to replace on Windows.
      const child = this.spawnImpl(nodeExecutable, [script, mode, String(process.pid), ...revisions], { cwd: this.projectDirectory,
        env: { ...process.env, NOTION_SWITCH_ROOT: this.root, NOTION_SWITCH_PROJECT: this.projectDirectory },
        windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      let done = false;
      const finish = ok => { if (done) return; done = true; clearTimeout(timer); child.removeAllListeners('message'); child.removeAllListeners('exit'); child.on('error', () => {}); if (child.connected) child.disconnect(); child.unref(); ok ? resolve() : reject(Error('helper unavailable')); };
      const timer = setTimeout(() => finish(false), 10000);
      child.once('error', () => finish(false)); child.once('exit', () => finish(false)); child.once('message', value => finish(value?.ready === true));
    });
  }
}
module.exports = { UpdateService };
