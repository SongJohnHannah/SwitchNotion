const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { runAgent } = require('./agent-runtime.cjs');
const { uuid } = require('./native-context.cjs');
function dailyAt(now, time, zone) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = value => Object.fromEntries(format.formatToParts(value).filter(item => item.type !== 'literal').map(item => [item.type, Number(item.value)]));
  const current = parts(now), [hour, minute] = time.split(':').map(Number);
  for (let day = 0; day < 4; day++) {
    const desired = Date.UTC(current.year, current.month - 1, current.day + day, hour, minute); let target = desired;
    for (let i = 0; i < 4; i++) { const p = parts(target), actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute); target += desired - actual; }
    const local = parts(target);
    if (target > now && local.hour === hour && local.minute === minute) return target;
  }
  throw Error('Notion 后台任务无法确定下一次执行时间。');
}
class BackgroundAgents {
  constructor({ root, memory, provider, workspace, extensions, notify = () => {}, now = () => Date.now() }) {
    Object.assign(this, { root, memory, provider, workspace, extensions, notify, now }); this.file = path.join(root, 'background-agents.local.json'); this.running = new Map(); this.polling = false;
    try { this.data = this.read(); } catch (error) { this.data = { version: 1, jobs: [] }; this.unavailable = error.message; return; }
    let changed = false;
    for (const job of this.data.jobs) if (['running', 'needs_approval'].includes(job.status)) { job.status = 'interrupted'; job.error = '程序曾在任务执行期间退出，请查看结果后手动继续。'; job.enabled = false; changed = true; }
    if (changed) this.save();
  }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, jobs: [] };
    try { if (fs.statSync(this.file).size > 8 * 1024 * 1024) throw Error(); const data = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (data.version !== 1 || !Array.isArray(data.jobs) || data.jobs.length > 30 || data.jobs.some(job => !job || !uuid(job.id) || typeof job.key !== 'string' || !/^[a-f\d]{64}$/.test(job.key) || typeof job.prompt !== 'string' || typeof job.title !== 'string' || !['manual', 'daily', 'interval', 'page-change'].includes(job.schedule))) throw Error(); return data; }
    catch { throw Error('Notion 后台任务配置损坏，请保留文件并检查。'); }
  }
  save() {
    if (this.unavailable) throw Error(this.unavailable);
    fs.mkdirSync(this.root, { recursive: true }); const file = this.file + '.' + randomUUID() + '.tmp', value = JSON.stringify(this.data);
    if (Buffer.byteLength(value) > 8 * 1024 * 1024) throw Error('Notion 后台任务记录过大，请清理旧任务。');
    try { fs.writeFileSync(file, value + '\n', { mode: 0o600, flush: true, flag: 'wx' }); fs.renameSync(file, this.file); } finally { if (fs.existsSync(file)) fs.unlinkSync(file); }
  }
  start() { if (this.timer || this.unavailable) return; this.timer = setInterval(() => void this.tick().catch(() => {}), 30000); this.timer.unref?.(); }
  close() { clearInterval(this.timer); this.timer = null; for (const controller of this.running.values()) controller.abort(); }
  get active() { return this.running.size; }
  list(key) { this.memory.entry(key); return this.data.jobs.filter(item => item.key === key).map(({ checkpoint, ...job }) => structuredClone(job)); }
  next(job, now = this.now()) { return job.schedule === 'daily' ? dailyAt(now, job.time, job.timezone) : now + job.everyMinutes * 60000; }
  async request(action, input) {
    try {
      if (this.unavailable) throw Error(this.unavailable);
      const fields = { 'agents.state': ['key'], 'agents.save': ['key', 'id', 'title', 'prompt', 'schedule', 'everyMinutes', 'time', 'timezone', 'pageId', 'enabled'], 'agents.run': ['key', 'id'], 'agents.stop': ['key', 'id'], 'agents.remove': ['key', 'id'] };
      if (!Object.hasOwn(fields, action) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !fields[action].includes(k)) || JSON.stringify(input).length > 20000) throw Error('Notion 后台任务参数无效。');
      this.memory.entry(input.key); let job = this.data.jobs.find(item => item.key === input.key && item.id === input.id);
      if (action === 'agents.save') {
        if (input.id && !job || job && this.running.has(job.id)) throw Error('Notion 后台任务不存在或正在运行，请先停止。');
        if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 80 || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000 || typeof input.enabled !== 'boolean' || !['manual', 'interval', 'daily', 'page-change'].includes(input.schedule)) throw Error('Notion 后台任务名称、指令或触发方式无效。');
        if (input.schedule === 'daily' && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) || typeof input.timezone !== 'string' || input.timezone.length > 80)) throw Error('Notion 后台任务每日时间或时区无效。');
        if (['interval', 'page-change'].includes(input.schedule) && (!Number.isInteger(input.everyMinutes) || input.everyMinutes < 5 || input.everyMinutes > 10080)) throw Error('Notion 后台任务间隔应在 5 分钟到 7 天之间。');
        if (input.pageId && !uuid(input.pageId) || input.schedule === 'page-change' && !uuid(input.pageId)) throw Error('Notion 后台任务需要有效的目标页面 ID。');
        const next = { key: input.key, id: job?.id || randomUUID(), title: input.title.trim(), prompt: input.prompt.trim(), schedule: input.schedule, everyMinutes: input.everyMinutes || 60, time: input.time || '09:00', timezone: input.timezone || 'Asia/Shanghai', pageId: uuid(input.pageId), enabled: input.enabled, status: 'idle', result: '', error: null };
        next.nextAt = next.schedule === 'manual' ? null : this.next(next);
        if (job) Object.assign(job, next, { checkpoint: undefined }); else { if (this.data.jobs.length >= 30) throw Error('Notion 后台任务最多保留 30 个。'); this.data.jobs.push(next); }
        this.save();
      } else if (action !== 'agents.state') {
        if (!job) throw Error('Notion 后台任务不属于当前工作区。');
        if (action === 'agents.run') { this.launch(job); }
        else if (action === 'agents.stop') { job.enabled = false; this.running.get(job.id)?.abort(); this.save(); }
        else { if (this.running.has(job.id)) throw Error('Notion 后台任务正在运行，请先停止。'); this.data.jobs = this.data.jobs.filter(item => item !== job); this.save(); }
      }
      return { ok: true, result: { jobs: this.list(input.key) } };
    } catch (error) { return { ok: false, error: /^Notion (?:后台任务|工作区记忆)/.test(error.message) ? error.message : 'Notion 后台任务操作失败，请检查配置。' }; }
  }
  launch(job) {
    if (this.running.size) throw Error('Notion 后台任务正在执行其他任务，请稍后重试。');
    const controller = new AbortController(); this.running.set(job.id, controller);
    job.status = 'running'; job.startedAt = this.now(); job.error = null; job.result = ''; job.runId = job.checkpoint?.operationScope ? job.runId : randomUUID(); this.save();
    void this.execute(job, controller).catch(() => { job.status = 'failed'; job.enabled = false; }).finally(() => this.running.delete(job.id));
  }
  async execute(job, controller) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20 * 60000)]);
    try {
      const scope = this.memory.state(job.key);
      const workspace = { open: async options => {
        const session = await this.workspace.open(options);
        return { ...session, context: { ...session.context, workspaces: session.context.workspaces.filter(item => item.workspace_id === scope.spaceId) }, execute: (name, args = {}) => {
          if (args.workspace_id && !['current', scope.spaceId].includes(args.workspace_id)) throw Error('Notion 后台任务只允许使用配置时选定的工作区。');
          if (name === 'list_workspaces') return { ...session.context, workspaces: session.context.workspaces.filter(item => item.workspace_id === scope.spaceId) };
          return session.execute(name, { ...args, workspace_id: scope.spaceId });
        } };
      } };
      await runAgent({ provider: this.provider, config: { ...this.provider.config(), multiAgent: false }, messages: [{ role: 'system', content: '' }, { role: 'user', content: job.prompt }], workspace, memory: this.memory, extensions: this.extensions, aiScope: { userId: scope.userId, spaceId: scope.spaceId }, nativeContext: { workspace_id: scope.spaceId, page_id: job.pageId }, operationScope: 'background:' + job.id + ':' + job.runId, checkpoint: job.checkpoint, signal,
        onText: text => { job.result += text; if (job.result.length > 120000) controller.abort(Error('输出超过任务上限。')); }, onTextReset: count => { if (count) job.result = job.result.slice(0, -count); }, onCheckpoint: checkpoint => { job.checkpoint = checkpoint; this.save(); },
        onStep: step => { if (step.state === 'awaiting_approval') { job.status = 'needs_approval'; this.save(); try { this.notify({ title: job.title, status: 'needs_approval' }); } catch {} } else if (step.state === 'started' && job.status === 'needs_approval') { job.status = 'running'; this.save(); } } });
      job.status = job.checkpoint?.uncertainWrite ? 'needs_review' : 'completed';
    } catch (error) { job.status = controller.signal.aborted ? 'stopped' : 'failed'; job.error = /^Notion |^DeepSeek |^本地 Agent/.test(error.message) ? error.message : '任务未完成，请查看已生成内容和页面结果。'; }
    finally { job.finishedAt = this.now(); if (job.checkpoint?.uncertainWrite || job.status !== 'completed') job.enabled = false; this.save(); try { this.notify({ title: job.title, status: job.status }); } catch {} }
  }
  async tick() {
    if (this.polling || this.running.size) return; this.polling = true;
    try {
      for (const job of this.data.jobs.filter(item => item.enabled && item.schedule !== 'manual' && item.nextAt <= this.now())) {
        job.nextAt = this.next(job); this.save();
        if (job.schedule === 'page-change') {
          try {
            const scope = this.memory.state(job.key), session = await this.workspace.open({ signal: AbortSignal.timeout(30000), nativeContext: { workspace_id: scope.spaceId, page_id: job.pageId }, readScope: { workspaceId: scope.spaceId, rootIds: [job.pageId] } });
            const value = await session.execute('read_page', { page_id: job.pageId, workspace_id: scope.spaceId });
            const revision = value.revision || createHash('sha256').update(JSON.stringify(value)).digest('hex'), changed = job.lastSourceRevision && job.lastSourceRevision !== revision;
            job.lastSourceRevision = revision; this.save(); if (!changed) continue;
          } catch { job.error = '无法核对监控页面，未触发执行。'; this.save(); continue; }
        }
        this.launch(job); break;
      }
    } finally { this.polling = false; }
  }
}
module.exports = { BackgroundAgents, dailyAt };
