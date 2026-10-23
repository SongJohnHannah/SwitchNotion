const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
class UpdateService {
  constructor({ root, isBusy = () => false, getCompatibility = () => ({}), onRestart = () => {}, spawnImpl = spawn, load } = {}) {
    this.root = root; this.isBusy = isBusy; this.getCompatibility = getCompatibility; this.onRestart = onRestart; this.spawnImpl = spawnImpl; this.updating = false;
    this.load = load || (() => import(pathToFileURL(path.join(root, '..', 'scripts', 'runtime-update.mjs')).href));
  }
  async request(action, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length || !['update.status', 'update.apply', 'update.rollback'].includes(action)) return { ok: false, error: '无法识别这项更新操作。' };
    try {
      const module = await this.load();
      if (action === 'update.status') {
        const value = module.updateStatus({ root: this.root }), ui = this.getCompatibility();
        return { ok: true, result: { ...value, openOnStartup: process.env.NOTION_SWITCH_UPDATE_VIEW === '1', clientCompatible: !ui.unsupportedAssets?.length, ...(value.compatible && ui.unsupportedAssets?.length ? { message: 'Notion 网页接入模块已变化，当前适配器暂不支持。客户端版本回退未必能恢复网页 AI，需要兼容此协议的新版 NotionSwitch。' } : {}) } };
      }
      if (this.updating || this.isBusy()) throw Error('AI 或登录同步正在进行，请等待完成或停止后再更新。');
      const status = module.updateStatus({ root: this.root });
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
    const { nodeExecutable } = JSON.parse(fs.readFileSync(path.join(this.root, 'launcher.local.json'), 'utf8'));
    if (!path.isAbsolute(nodeExecutable || '') || !/^node(?:\.exe)?$/i.test(path.basename(nodeExecutable)) || !fs.statSync(nodeExecutable).isFile()) throw Error('Node unavailable');
    const script = path.resolve(this.root, '..', 'scripts', 'update-helper.mjs');
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(nodeExecutable, [script, mode, String(process.pid)], { windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      let done = false;
      const finish = ok => { if (done) return; done = true; clearTimeout(timer); child.removeAllListeners('message'); child.removeAllListeners('exit'); child.on('error', () => {}); if (child.connected) child.disconnect(); child.unref(); ok ? resolve() : reject(Error('helper unavailable')); };
      const timer = setTimeout(() => finish(false), 10000);
      child.once('error', () => finish(false)); child.once('exit', () => finish(false)); child.once('message', value => finish(value?.ready === true));
    });
  }
}
module.exports = { UpdateService };
