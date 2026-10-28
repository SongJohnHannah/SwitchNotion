const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { buildMessages, parseBuildOutput } = require('./native-database-build.cjs');
const { NativeBuildStore } = require('./native-database-build-store.cjs');
const fail = text => { throw Error('Notion 建库向导 ' + text); };
function parentId(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 2000) fail('父页面链接无效。');
  if (/^https:\/\//.test(value)) {
    const url = new URL(value);
    if (!/^(?:(?:www|app)\.)?notion\.(?:so|com)$/.test(url.hostname)) fail('请使用 Notion 页面链接或页面 ID。');
    value = url.pathname.split('/').pop();
  }
  const match = value.match(/([a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i), result = uuid(match?.[1]);
  if (!result) fail('父页面链接无效。'); return result;
}
class DatabaseWizard {
  constructor({ root, provider }) {
    this.provider = provider; this.file = path.join(root, 'database-wizard.local.json'); this.jobs = new Map(); this.running = new Map(); this.available = true;
    try {
      if (fs.statSync(this.file).size > 12 * 1024 * 1024) fail('创建记录过大。');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.jobs) || saved.jobs.length > 100) fail('创建记录无效。');
      for (const job of saved.jobs) {
        if (!uuid(job.id) || !uuid(job.userId) || !uuid(job.spaceId) || !Number.isSafeInteger(job.revision) || !['preview', 'ready', 'submitted', 'uncertain', 'verified', 'failed'].includes(job.status)) fail('创建记录无效。');
        if (job.plan && (job.plan.userId !== job.userId || job.plan.spaceId !== job.spaceId)) fail('创建记录范围无效。');
        if (job.status === 'submitted') job.status = 'uncertain'; this.jobs.set(job.id, job);
      }
    } catch (error) { if (error.code !== 'ENOENT') this.available = false; }
  }
  get active() { return this.running.size; }
  save() {
    const retained = [...this.jobs.values()];
    if (retained.length > 100) fail('创建记录已满，请先核对未完成的创建。');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const file = this.file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: retained }), { mode: 0o600, flush: true }); fs.renameSync(file, this.file);
  }
  scope(native) {
    if (!this.available) fail('本地创建记录无法读取，已保留原文件，请先检查配置。');
    if (!uuid(native?.spaceId) || !uuid(native?.userId)) fail('请先在 Notion 中打开工作区页面。');
    return { userId: native.userId, spaceId: native.spaceId };
  }
  view(job) { return { id: job.id, revision: job.revision, status: job.status, draft: job.draft, parentPage: job.parentPage || '', result: job.result }; }
  state(native) {
    const scope = this.scope(native);
    return { ...scope, jobs: [...this.jobs.values()].filter(job => job.userId === scope.userId && job.spaceId === scope.spaceId).map(job => this.view(job)).reverse().slice(0, 20) };
  }
  find(input, native) {
    const scope = this.scope(native), job = this.jobs.get(uuid(input?.id));
    if (!job || job.userId !== scope.userId || job.spaceId !== scope.spaceId || job.revision !== input.revision) fail('方案已改变，请刷新向导。');
    if (this.running.has(job.id)) fail('此方案正在处理，请等待。'); return job;
  }
  async generate(input, native, signal) {
    const scope = this.scope(native);
    if (typeof input?.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000) fail('请描述需要的数据库，最多 12,000 字。');
    const parentPage = parentId(input.parentPage), parentPointer = { table: parentPage ? 'block' : 'space', id: parentPage || scope.spaceId, spaceId: scope.spaceId };
    const store = new NativeBuildStore({ native }); await store.parent(parentPointer, signal);
    if (this.provider.status().mode !== 'deepseek') fail('请先配置 DeepSeek。');
    const id = randomUUID(), controller = new AbortController(), active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.running.set(id, controller);
    try {
      let output = '';
      const messages = buildMessages({ spaceId: scope.spaceId, threadId: id, transcript: [
        { id: randomUUID(), type: 'config', value: { type: 'workflow', oracleThreadType: 'onboarding', onboardingAgentVersion: 'work_database_build' } },
        { id: randomUUID(), type: 'user', value: input.prompt }
      ] });
      for await (const part of this.provider.generate({ config: { ...this.provider.config(), multiAgent: false, maxTokens: 16384 }, messages, signal: active })) {
        active.throwIfAborted(); output += part; if (output.length > 200000) fail('生成结果过长。');
      }
      active.throwIfAborted(); const draft = parseBuildOutput(output);
      if (draft.type === 'chat') return { question: draft.message };
      const job = { id, ...scope, revision: 1, status: 'preview', parentPage, draft, createdAt: new Date().toISOString() };
      this.jobs.set(id, job); this.save(); return this.view(job);
    } finally { this.running.delete(id); }
  }
  async layout(input, native, signal) {
    const job = this.find(input, native);
    if (!['preview', 'ready'].includes(job.status)) fail('此方案已提交，不能再修改布局。');
    if (!Array.isArray(input.views) || !input.views.length || input.views.length > 8) fail('请选择一至八个布局。');
    const controller = new AbortController(), active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.running.set(job.id, controller);
    try {
      const draft = { ...job.draft, views: input.views }, store = new NativeBuildStore({ native });
      const plan = await store.prepare(draft, { table: job.parentPage ? 'block' : 'space', id: job.parentPage || job.spaceId, spaceId: job.spaceId }, active);
      active.throwIfAborted();
      // No create transaction is sent during preview or layout selection.
      job.plan = plan; job.draft = plan.draft; job.status = 'ready'; job.revision++; this.save(); return this.view(job);
    } finally { this.running.delete(job.id); }
  }
  async commit(input, native, signal) {
    const job = this.find(input, native), store = new NativeBuildStore({ native });
    if (job.status === 'verified') return this.view(job);
    if (!job.plan || !['ready', 'submitted', 'uncertain'].includes(job.status)) fail('请先预览字段并选择布局。');
    const controller = new AbortController(), active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.running.set(job.id, controller);
    try {
      if (job.status === 'ready') {
        await store.submit(job.plan, { signal: active, confirmation: { decision: 'confirmed', stepId: job.plan.step.id, planHash: job.plan.planHash, userId: job.userId, spaceId: job.spaceId },
          onSubmit: () => { job.status = 'submitted'; this.save(); } });
      }
      const result = await store.verify(job.plan, active);
      if (!result.ok) { job.status = 'uncertain'; this.save(); fail('创建结果尚未完整读回；已保存记录，请点“核对创建结果”，不会重复创建。'); }
      job.status = 'verified'; job.result = { url: 'https://www.notion.so/' + job.plan.databaseId.replaceAll('-', ''), title: job.draft.title, verified: true };
      this.save(); return this.view(job);
    } catch (error) {
      if (job.status === 'submitted') {
        const actual = await store.verify(job.plan, AbortSignal.timeout(15000)).catch(() => ({ ok: false }));
        if (actual.ok) { job.status = 'verified'; job.result = { url: 'https://www.notion.so/' + job.plan.databaseId.replaceAll('-', ''), title: job.draft.title, verified: true }; }
        else job.status = 'uncertain'; this.save(); if (actual.ok) return this.view(job);
      }
      throw error;
    } finally { this.running.delete(job.id); }
  }
  close() { for (const controller of this.running.values()) controller.abort(); }
}
module.exports = { DatabaseWizard, parentId };
