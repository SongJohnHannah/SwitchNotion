const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { RecordingCapture } = require('./meeting-recording-capture.cjs');
const { encodeRecording } = require('./meeting-recording-encode.cjs');
const { targetFor, uploadAudio, attachAudio, verifyAudio } = require('./meeting-recording-store.cjs');
class MeetingRecordings {
  constructor({ root, provider, enabled = () => true, storeFactory, encode = encodeRecording, log = () => {} }) {
    Object.assign(this, { root, provider, enabled, storeFactory, encode, log });
    this.directory = path.join(root, 'meeting-recordings'); this.file = path.join(root, 'meeting-recordings.local.json');
    this.jobs = new Map(); this.captures = new Map(); this.running = new Map(); this.controllers = new Set();
    this.tail = Promise.resolve(); this.lastError = ''; this.closed = false; this.journalError = false;
    if (fs.existsSync(this.file)) try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.jobs)) throw Error();
      for (const job of saved.jobs) {
        if (![job.id, job.meetingId, job.spaceId, job.userId].every(uuid)) throw Error();
        if (job.status === 'capturing') job.status = 'interrupted';
        this.jobs.set(job.id, job);
      }
    } catch { this.journalError = true; this.lastError = '会议录音缓存记录无法读取，已保留原文件，未覆盖。'; }
  }
  get active() { return this.running.size; }
  status() { return { active: this.active, capturing: this.captures.size, pending: [...this.jobs.values()].filter(j => j.status !== 'verified' && j.status !== 'capturing').length,
    saved: [...this.jobs.values()].filter(j => j.status === 'verified').length, failed: [...this.jobs.values()].filter(j => ['failed', 'uncertain', 'interrupted'].includes(j.status)).length, lastError: this.lastError }; }
  save() {
    if (this.journalError) throw Error(this.lastError);
    const completed = [...this.jobs.values()].filter(j => j.status === 'verified');
    for (const job of completed.slice(0, Math.max(0, completed.length - 100))) this.jobs.delete(job.id);
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, jobs: [...this.jobs.values()] }), { mode: 0o600, flush: true });
    fs.renameSync(temporary, this.file);
  }
  location(id) {
    if (!uuid(id) || path.resolve(this.directory) === path.parse(this.directory).root) throw Error('会议录音缓存位置无效。');
    const directory = path.join(this.directory, id);
    for (const candidate of [this.root, this.directory, directory]) if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('会议录音缓存不能使用目录链接。');
    if (path.dirname(path.resolve(directory)) !== path.resolve(this.directory)) throw Error('会议录音缓存位置无效。');
    return directory;
  }
  begin({ blockId, spaceId, userId }) {
    if (!this.enabled() || this.closed || this.journalError) return null;
    if (![blockId, spaceId, userId].every(uuid)) { this.lastError = '会议录音未绑定登录账号，未自动保存；请在原型中重新打开会议。'; return null; }
    try {
      const job = { id: randomUUID(), meetingId: blockId, spaceId, userId, startedAt: new Date().toISOString(), status: 'capturing', attempts: 0 };
      const directory = this.location(job.id); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.jobs.set(job.id, job); this.save();
      // Bind the original page while recording starts, without holding up capture.
      const target = this.resolve(job, AbortSignal.timeout(15000)); target.catch(() => {});
      const capture = new RecordingCapture({ directory,
        complete: async () => { this.captures.delete(job.id); job.status = 'ready'; this.save(); await target.catch(() => {}); return this.schedule(job); },
        failed: error => { this.captures.delete(job.id); this.failure(job, error, 'interrupted'); } });
      this.captures.set(job.id, capture); return capture;
    } catch { this.lastError = '会议录音临时目录无法准备，转写继续。'; return null; }
  }
  async resolve(job, signal) {
    const store = await this.storeFactory(job, signal), target = await targetFor(store, job.meetingId, signal);
    if (target.spaceId !== job.spaceId || target.userId !== job.userId || job.target && JSON.stringify(job.target) !== JSON.stringify(target)) throw Error('会议所在页面、账号或工作区已变化，未将录音保存到其他页面。');
    if (!job.target) { job.target = target; this.save(); }
    return store;
  }
  failure(job, error, status = 'failed') {
    job.status = status; job.attempts = (job.attempts || 0) + 1;
    job.nextRetryAt = Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(job.attempts - 1, 7));
    this.lastError = /^会议|^当前|^无法确定/.test(error?.message || '') ? error.message : '会议音频尚未保存到页面，临时录音已保留，可在配置中重试。';
    try { this.save(); } catch { this.lastError = '会议录音进度无法保存，请保留本机缓存后重试。'; }
    this.log({ type: 'meeting-audio-import-failed', state: status }); this.arm();
  }
  schedule(job) {
    if (this.running.has(job.id)) return this.running.get(job.id);
    const task = this.tail.catch(() => {}).then(async () => {
      if (this.closed || !this.enabled()) return;
      const controller = new AbortController(); this.controllers.add(controller);
      const deadline = setTimeout(() => controller.abort(), 45 * 60 * 1000); deadline.unref();
      try { await this.import(job, controller.signal); }
      catch (error) { this.failure(job, error, job.parts?.some(p => ['submitted', 'uncertain'].includes(p.plan?.status)) ? 'uncertain' : 'failed'); }
      finally { clearTimeout(deadline); this.controllers.delete(controller); }
    });
    this.tail = task; this.running.set(job.id, task);
    task.finally(() => this.running.delete(job.id)); return task;
  }
  async import(job, signal) {
    const store = await this.resolve(job, signal), directory = this.location(job.id);
    if (!job.parts) {
      job.status = 'encoding'; this.save();
      job.parts = await this.encode({ directory, root: this.root, provider: this.provider, signal }); this.save();
    }
    for (let index = 0; index < job.parts.length; index++) {
      const part = job.parts[index];
      if (!part.plan) {
        part.plan = { id: randomUUID(), transactionId: randomUUID(), name: `meeting-${job.id}-${index + 1}.mp3`,
          caption: `会议录音 ${job.startedAt.slice(0, 19).replace('T', ' ')}${job.parts.length > 1 ? ` · ${index + 1}/${job.parts.length}` : ''}`, status: 'prepared' }; this.save();
      }
      const plan = part.plan;
      if (plan.status === 'verified') continue;
      if (plan.url && await verifyAudio(store, job.target, plan, signal)) { plan.status = 'verified'; this.save(); continue; }
      if (['submitted', 'uncertain'].includes(plan.status)) throw Error('会议音频此前写入结果尚未确认，本次只核验，不重复添加。');
      if (!plan.url) {
        if (!/^audio-\d{3,4}\.mp3$/.test(part.filename)) throw Error('会议录音缓存文件名无效。');
        const file = path.join(directory, part.filename), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw Error('会议录音缓存文件无效。');
        job.status = 'uploading'; this.save();
        Object.assign(plan, await uploadAudio(store, job.target, plan.name, fs.readFileSync(file), signal)); this.save();
      }
      try { await attachAudio(store, job.target, plan, signal, () => { plan.status = 'submitted'; this.save(); }); }
      catch (error) { if (error.notSubmitted) { plan.status = 'prepared'; this.save(); throw error; } else if (plan.status !== 'submitted') throw error; }
      if (!await verifyAudio(store, job.target, plan, signal)) { plan.status = 'uncertain'; this.save(); throw Error('会议音频写入未确认，临时音频保留，未重复添加。'); }
      plan.status = 'verified'; this.save();
    }
    job.status = 'verified'; this.lastError = ''; this.save();
    try { if (fs.existsSync(directory)) { const resolved = fs.realpathSync(directory); if (path.dirname(resolved) !== fs.realpathSync(this.directory)) throw Error(); fs.rmSync(resolved, { recursive: true, force: true }); } }
    catch { this.lastError = '会议音频已保存，临时缓存未能清理；不会重复添加。'; }
    this.log({ type: 'meeting-audio-import-verified', parts: job.parts.length });
  }
  wake() {
    if (this.closed || !this.enabled() || this.journalError) return;
    for (const job of this.jobs.values()) if (!['capturing', 'verified', 'interrupted'].includes(job.status) && (!job.nextRetryAt || job.nextRetryAt <= Date.now())) void this.schedule(job);
    this.arm();
  }
  arm() {
    clearTimeout(this.timer); if (this.closed) return;
    const next = [...this.jobs.values()].filter(j => !['capturing', 'verified', 'interrupted'].includes(j.status)).map(j => j.nextRetryAt || Date.now() + 30000);
    if (next.length) { this.timer = setTimeout(() => this.wake(), Math.max(1000, Math.min(...next) - Date.now())); this.timer.unref(); }
  }
  async retry() {
    if (!this.enabled()) throw Error('请先开启“将会议录音保存到当前页面”。');
    await Promise.all([...this.jobs.values()].filter(j => !['capturing', 'verified'].includes(j.status)).map(j => this.schedule(j)));
    return this.status();
  }
  close() { this.closed = true; clearTimeout(this.timer); for (const capture of this.captures.values()) capture.abort(); for (const controller of this.controllers) controller.abort(); }
}
module.exports = { MeetingRecordings };
