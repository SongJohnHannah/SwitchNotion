const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { autofillInput } = require('./native-autofill-store.cjs');
const { AutofillExecutor } = require('./native-autofill-executor.cjs');
const localId = () => 'addf11ed-' + randomUUID().slice(9);
const isLocalId = value => uuid(value)?.startsWith('addf11ed-') === true;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const safeMessage = error => /^Notion Autofill /.test(error?.message || '') ? error.message : 'Notion Autofill 生成或保存未完成，请检查模型和页面权限后重试。';
class NativeAutofillJobs {
  constructor({ root, provider, storeFactory, log = () => {} }) {
    Object.assign(this, { root, provider, storeFactory, log }); this.available = true; this.jobs = new Map(); this.running = new Map(); this.promises = new Map();
    this.file = path.join(root, 'autofill-jobs.local.json'); this.executor = new AutofillExecutor({ root, provider, log });
    try {
      if (fs.statSync(this.file).size > 10000000) throw Error('Notion Autofill 本地任务状态过大。');
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.jobs)) throw Error('Notion Autofill 本地任务状态格式无效。');
      for (const job of data.jobs) {
        if (!isLocalId(job.id) || !uuid(job.ownerId) || !uuid(job.info?.spaceId) || !uuid(job.info.collectionId) || !uuid(job.info.workflowId) ||
            !Array.isArray(job.rows) || job.rows.length > 200 || !Number.isSafeInteger(job.version) || job.version < 1 ||
            !['in_progress', 'success', 'failure'].includes(job.status) || job.rows.some(row => !uuid(row.pageId) || !isLocalId(row.runId) ||
              !['pending', 'running', 'success', 'failure', 'cancelled', 'skipped'].includes(row.status))) throw Error('Notion Autofill 本地任务状态无效。');
        if (job.status === 'in_progress') {
          job.status = 'failure'; job.error = 'Notion Autofill 程序重启中断了任务；再次填充时会先核对既有写入。'; job.version++;
          for (const row of job.rows) if (['pending', 'running'].includes(row.status)) row.status = 'failure';
        }
        this.jobs.set(job.id, job);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  get active() { return [...this.jobs.values()].filter(job => job.status === 'in_progress').length; }
  save() {
    const complete = [...this.jobs.values()].filter(job => job.status !== 'in_progress');
    for (const job of complete.slice(0, Math.max(0, complete.length - 100))) this.jobs.delete(job.id);
    fs.mkdirSync(this.root, { recursive: true }); const temporary = this.file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, jobs: [...this.jobs.values()].map(({ recordMap, ...job }) => job) }), { mode: 0o600, flush: true });
    fs.renameSync(temporary, this.file);
  }
  find(id) { return this.jobs.get(id) || [...this.jobs.values()].find(job => job.rows.some(row => row.runId === id)); }
  scoped(id, { userId, spaceId } = {}) {
    const job = this.find(id);
    if (!job || job.ownerId !== uuid(userId) || job.info.spaceId !== uuid(spaceId)) return null;
    return job;
  }
  record(id, table, scope) {
    if (!['workflow_automation_run', 'task_output'].includes(table)) return;
    const job = this.scoped(id, scope); if (!job) return;
    const common = { id, space_id: job.info.spaceId, version: job.version, alive: true, created_time: job.createdAt, last_edited_time: job.updatedAt };
    if (table === 'task_output' && id === job.id) return { ...common, status: job.status === 'in_progress' ? 'waiting' : job.status === 'success' ? 'complete' : 'failed',
      lifecycle: job.status, value: this.progress(job).value };
    const row = job.rows.find(value => value.runId === id); if (!row || table !== 'workflow_automation_run') return;
    return { ...common, parent_id: job.info.workflowId, parent_table: 'workflow', status: row.status,
      created_by_id: job.ownerId, created_by_table: 'notion_user', dequeue_after: 0,
      data: { notion_switch_autofill: true, block_id: row.pageId, property_ids: job.info.propertyIds,
        ...(row.error || job.error ? { error: { errorType: 'notionSwitchAutofill', message: row.error || job.error } } : {}) } };
  }
  progress(job) {
    const counts = { success: 0, in_progress: 0, paused: 0, failure: 0, cancelled: 0, skipped: 0 };
    for (const row of job.rows) counts[['pending', 'running'].includes(row.status) ? 'in_progress' : row.status]++;
    const processed = job.rows.length - counts.in_progress;
    return { version: job.version, status: job.status, counts, value: {
      percentageComplete: job.rows.length ? processed / job.rows.length * 100 : 100,
      blocksProcessed: processed, totalBlocks: job.rows.length, groupId: job.id, workflowAutomationRunIds: job.rows.map(row => row.runId),
      ...(job.status !== 'in_progress' ? { success: job.status === 'success' } : {}),
      ...(job.error ? { error: { code: 'local_autofill_failed', message: job.error } } : {}) } };
  }
  recordMap(job) {
    const scope = { userId: job.ownerId, spaceId: job.info.spaceId };
    return { __version__: 3, ...(job.recordMap || {}),
      task_output: { [job.id]: { spaceId: scope.spaceId, value: { role: 'reader', value: this.record(job.id, 'task_output', scope) } } },
      workflow_automation_run: Object.fromEntries(job.rows.map(row => [row.runId, { spaceId: scope.spaceId,
        value: { role: 'reader', value: this.record(row.runId, 'workflow_automation_run', scope) } }])) };
  }
  response(job, endpoint) {
    const progress = this.progress(job);
    return json({ ...(endpoint === 'triggerAgentOverCollection' ? { outputKey: job.id } : {}),
      groupId: job.id, totalBlocks: job.rows.length, workflowAutomationRunIds: job.rows.map(row => row.runId), recordMap: this.recordMap(job),
      notionSwitchAutofill: { version: 1, jobId: job.id, initial: progress } });
  }
  async start(endpoint, input, signal, meta) {
    let info = autofillInput(input); const store = meta.store || await this.storeFactory(info, meta);
    if (store.userId !== uuid(meta.userId) || store.spaceId !== info.spaceId) throw Error('Notion Autofill 请求账号或工作区不匹配。');
    if (this.active >= 4) throw Error('Notion Autofill 正在处理的批次过多，请稍后重试。');
    const snapshot = await store.load(info, signal); signal?.throwIfAborted();
    info = snapshot.info;
    const key = hash([store.userId, info]), prior = [...this.jobs.values()].find(job => job.key === key && job.status === 'in_progress');
    if (prior) return this.response(prior, endpoint);
    if (this.active >= 4) throw Error('Notion Autofill 正在处理的批次过多，请稍后重试。');
    const createdAt = Date.now(), job = { id: localId(), key, ownerId: store.userId, info, status: 'in_progress', version: 1,
      createdAt, updatedAt: createdAt, rows: info.rowIds.map(pageId => ({ pageId, runId: localId(), status: 'pending' })) };
    this.jobs.set(job.id, job); this.save();
    const controller = new AbortController(), rowControllers = new Map(info.rowIds.map(id => [id, new AbortController()]));
    this.running.set(job.id, { controller, rowControllers });
    const response = this.response(job, endpoint);
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await this.executor.fill(info, store, controller.signal, event => {
          const row = job.rows.find(value => value.pageId === event.rowId);
          if (row) row.status = event.stage === 'verified' ? 'success' : event.stage === 'cancelled' ? 'cancelled' : event.stage === 'skipped' ? 'skipped' : 'running';
          job.version++; job.updatedAt = Date.now();
        }, { rowSignals: new Map([...rowControllers].map(([id, value]) => [id, value.signal])) });
        job.recordMap = result.recordMap;
        for (const row of job.rows) if (!['success', 'cancelled'].includes(row.status)) row.status = result.cancelledRowIds.includes(row.pageId) ? 'cancelled' :
          result.skippedRowIds?.includes(row.pageId) ? 'skipped' : 'success';
      } catch (error) {
        job.error = controller.signal.aborted ? 'Notion Autofill 任务已停止；已提交的写入会保留核验记录。' : safeMessage(error);
        for (const row of job.rows) if (!['success', 'cancelled'].includes(row.status)) row.status = controller.signal.aborted ? 'cancelled' : 'failure';
      }
      const uncertain = [...this.executor.jobs.values()].some(value => ['submitted', 'uncertain'].includes(value.status) &&
        value.plan.userId === job.ownerId && value.plan.spaceId === job.info.spaceId && job.info.rowIds.includes(value.plan.rowId));
      for (const row of job.rows) if (!uncertain && row.status !== 'success') {
        try { if (!await store.clearPending(snapshot, row.pageId, AbortSignal.timeout(15000), blocks => { job.recordMap ||= { __version__: 3, block: {} }; Object.assign(job.recordMap.block ||= {}, blocks); })) throw Error('pending state changed'); }
        catch { row.error = 'Notion Autofill 字段任务状态未能清理，请重新加载记录核对。'; if (row.status === 'skipped') row.status = 'failure'; }
      }
      job.status = job.rows.some(row => ['failure', 'cancelled'].includes(row.status)) ? 'failure' : 'success';
      job.version++; job.updatedAt = Date.now(); this.running.delete(job.id); this.save();
      this.log({ type: 'autofill-job-ended', status: job.status, rowCount: job.rows.length });
    }).finally(() => this.promises.delete(job.id));
    this.promises.set(job.id, promise); void promise.catch(() => { this.log({ type: 'autofill-job-state-save-failed' }); });
    return response;
  }
  async handle(endpoint, input, signal, meta = {}) {
    try {
      if (['triggerLiteAgentAutofill', 'triggerAgentOverCollection'].includes(endpoint)) return await this.start(endpoint, input, signal, meta);
      const id = input.jobId || input.outputKey || input.runId;
      if (!isLocalId(id)) return null;
      const job = this.scoped(id, { userId: meta.userId, spaceId: input.spaceId });
      if (!job) return json({ message: 'Notion Autofill 本地任务不存在或不属于当前账号/工作区。' }, 404);
      if (endpoint === 'notionSwitchGetAutofillStatus') return json({ ...this.progress(job), recordMap: this.recordMap(job) });
      if (endpoint === 'markWorkflowAutomationRunCancelled') {
        const row = job.rows.find(row => row.runId === input.runId), controls = this.running.get(job.id);
        if (!row || !controls || !['pending', 'running'].includes(row.status)) return json({ alreadyCompleted: true });
        controls.rowControllers.get(row.pageId).abort(); row.status = 'cancelled'; job.version++; job.updatedAt = Date.now();
        return json({ stopped: true, recordMap: this.recordMap(job) });
      }
      return null;
    } catch (error) {
      return json({ name: 'NotionSwitchAutofill', message: safeMessage(error) }, signal?.aborted ? 499 : 400);
    }
  }
  async wait(id) { await this.promises.get(id); }
  close() { for (const { controller } of this.running.values()) controller.abort(); }
}
function createAutofillJobs(options) {
  try { return new NativeAutofillJobs(options); }
  catch {
    // Do not discard a corrupt receipt and silently allow another write. This
    // feature can fail independently of the existing chat/login/audio runtime.
    options.log?.({ type: 'autofill-storage-unavailable' });
    return { available: false, active: 0, record() {}, close() {}, async handle() {
      return json({ name: 'NotionSwitchAutofill', message: 'Notion Autofill 本地核验记录无法读取，已保留原文件并停止填充写入；请先检查本机记录。' }, 503);
    } };
  }
}
module.exports = { NativeAutofillJobs, createAutofillJobs, isLocalId };
