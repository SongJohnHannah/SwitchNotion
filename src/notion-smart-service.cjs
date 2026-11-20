const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const smart = require('./notion-smart-network.cjs');

function launchCaddy(executable, args, options = {}) {
  if (process.platform !== 'win32') return spawn(executable, args, options);
  const script = path.join(__dirname, 'notion-smart-native.ps1');
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Executable', executable, '-Config', args[2], '-SupervisorPid', String(process.pid)], { ...options, windowsHide: true });
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
function postConfig(port, config) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(config));
    const request = http.request({ host: '127.0.0.1', port, path: '/load', method: 'POST', timeout: 10000,
      headers: { 'content-type': 'application/json', 'content-length': body.length, origin: 'http://127.0.0.1:' + port } }, response => {
      response.resume(); response.once('end', () => response.statusCode === 200 ? resolve() : reject(Error('Caddy configuration was not accepted.')));
    });
    request.once('timeout', () => request.destroy(Error('Caddy configuration timed out.')));
    request.once('error', reject); request.end(body);
  });
}
function checkListener(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(500, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => finish(true));
  });
}
async function mapLimit(values, limit, work) {
  let next = 0; const results = Array(values.length);
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) { const index = next++; if (index >= values.length) return; results[index] = await work(values[index]); }
  }));
  return results;
}

class NotionSmartService {
  constructor({ root, executable, port = 0, previous, probe = smart.probeHost, pickInterface = smart.chooseInterface,
    startProcess = launchCaddy, ready = checkListener, applyConfig = postConfig, notify = () => {} } = {}) {
    if (!root || !executable) throw Error('A state directory and Caddy executable are required.');
    Object.assign(this, { root, executable, requestedPort: port, previous, probe, pickInterface, startProcess, ready, applyConfig, notify });
    this.directory = path.join(root, 'smart-direct'); this.process = null; this.stopping = false;
    this.status = { state: 'stopped', selections: {}, lastCheck: '' }; this.refreshTask = null;
  }
  update(value) { this.status = { ...this.status, ...value }; this.notify(this.status); }
  config(physical = this.interface, selections = this.status.selections) {
    return smart.caddyConfig({ port: this.port, adminPort: this.adminPort, localAddress: physical.address, selections });
  }
  async start() {
    if (this.process) throw Error('Notion direct acceleration is already running.');
    this.stopping = false;
    if (!fs.existsSync(this.executable)) throw Error('当前缺少 Notion 直连组件。');
    this.interface = this.pickInterface();
    if (!this.interface?.address) throw Error('当前未检测到可用于直连的网络。');
    this.port = this.requestedPort || await availablePort();
    do { this.adminPort = await availablePort(); } while (this.adminPort === this.port);
    const prior = this.previous?.interface === this.interface.name && (this.previous.localAddress === this.interface.address ||
      this.previous.scope === undefined) && Date.now() - Date.parse(this.previous.lastCheck) < 15 * 60 * 1000 ? this.previous : null;
    const selections = Object.fromEntries(Object.entries(prior?.selections || {}).filter(([host, ip]) =>
      smart.allowedHost(host) && smart.publicIPv4(ip) && (host !== 'images.unsplash.com' || prior.scope === 'media')));
    this.previous = null;
    this.update({ state: 'starting', port: this.port, interface: this.interface.name, localAddress: this.interface.address,
      selections, hostChecks: {}, lastCheck: prior?.lastCheck || '', checkedDomains: 0, reachableDomains: Object.keys(selections).length,
      refreshing: false, message: '' });
    fs.mkdirSync(this.directory, { recursive: true });
    const file = path.join(this.directory, 'caddy.json'); fs.writeFileSync(file, JSON.stringify(this.config()), { mode: 0o600 });
    const child = this.startProcess(this.executable, ['run', '--config', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.process = child; let errorText = '';
    child.stderr?.on('data', part => { errorText = (errorText + part).slice(-4096); });
    child.once('error', error => { if (!this.stopping) this.update({ state: 'error', message: error.message }); });
    child.once('exit', () => { if (this.process === child) this.process = null; if (!this.stopping) this.update({ state: 'error', message: '直连服务意外停止，请重新打开 NotionSwitch。' }); });
    const deadline = Date.now() + 15000; let ok = false;
    while (Date.now() < deadline && this.process === child && child.exitCode === null) {
      if (await this.ready(this.port) && this.process === child && child.exitCode === null) { ok = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ok) {
      this.stop();
      throw Error('本机媒体直连服务未能启动。' + (errorText.includes('address already in use') ? '本机端口已被占用。' : ''));
    }
    this.update({ state: 'ready', caddyPid: child.pid });
    return this.status;
  }
  async refresh() {
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = (async () => {
      if (!this.process) throw Error('Notion direct acceleration is not running.');
      this.update({ refreshing: true });
      const physical = this.pickInterface();
      if (!physical?.address) { this.update({ state: 'error', message: '未检测到可用于直连的网络。' }); return this.status; }
      const probe = async host => {
        const preview = host === 'images.unsplash.com';
        try { return await this.probe(host, { localAddress: physical.address, timeoutMs: preview ? 15000 : 9000, rounds: preview ? 1 : 2 }); }
        catch { return { host, best: null }; }
      };
      const worker = this.process;
      const next = this.interface.address === physical.address ? { ...this.status.selections } : {};
      const imageProbe = probe('images.unsplash.com');
      const groups = [
        ['file.notion.com', 'file.notion.so', 'prod-files-secure.s3.us-west-2.amazonaws.com', 'img.notionusercontent.com', 'api.notion.com'],
        smart.knownHosts.filter(host => !['file.notion.com', 'file.notion.so', 'prod-files-secure.s3.us-west-2.amazonaws.com',
          'img.notionusercontent.com', 'api.notion.com', 'images.unsplash.com'].includes(host))
      ];
      let checked = 0;
      const hostChecks = {};
      const apply = async results => {
        if (this.process !== worker || this.stopping) return;
        for (const result of results) {
          hostChecks[result.host] = Number.isFinite(result.best?.ms) ? result.best.ms : null;
          if (result.best) next[result.host] = result.best.ip;
          else delete next[result.host];
        }
        const selections = { ...next };
        if (this.interface.address !== physical.address || JSON.stringify(selections) !== JSON.stringify(this.status.selections)) {
          await this.applyConfig(this.adminPort, this.config(physical, selections));
        }
        if (this.process !== worker || this.stopping) return;
        this.interface = physical;
        checked += results.length;
        this.update({ state: 'ready', interface: physical.name, localAddress: physical.address, selections, hostChecks: { ...hostChecks },
          lastCheck: new Date().toISOString(), checkedDomains: checked, reachableDomains: Object.keys(selections).length, message: '' });
      };
      let updates = Promise.resolve();
      const publish = results => updates = updates.then(() => apply(results));
      await Promise.all([
        mapLimit(groups[0], 5, probe).then(publish),
        mapLimit(groups[1], 4, probe).then(publish),
        imageProbe.then(result => publish([result]))
      ]);
      return this.status;
    })();
    try { return await this.refreshTask; } finally {
      this.refreshTask = null;
      if (this.process && !this.stopping) this.update({ refreshing: false });
    }
  }
  stop() {
    this.stopping = true;
    const child = this.process; this.process = null;
    if (child && child.exitCode === null) child.kill();
    this.update({ state: 'stopped', caddyPid: null, refreshing: false });
  }
}
module.exports = { NotionSmartService, availablePort, postConfig, checkListener, mapLimit, launchCaddy };
