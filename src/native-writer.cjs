const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AgentMock } = require('./agent-mock.cjs');
const { uuid } = require('./native-context.cjs');
const { mayUseRecord, requestScope } = require('./local-ai-scope.cjs');

// AgentServiceWriterPopup 382968, public 2026-10-29 asset
// AgentServiceWriterPopup-4a2281954c17982f.js. runWriter returns JSON with
// committed records; it does not consume the old writer's inference stream.
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const edit = require('./native-writer-edit.cjs');
const { hash } = edit;
const editable = entry => entry && ['editor', 'owner'].includes(entry.role);

class NativeWriter {
  constructor({ root, provider, storeFactory, hasRecord = () => false, log = () => {} }) {
    this.file = path.join(root, 'writer-conversations.local.json'); this.provider = provider; this.storeFactory = storeFactory; this.hasOtherRecord = hasRecord; this.log = log;
    this.jobs = new Map(); this.events = new AgentMock(); this.controllers = new Map();
    if (fs.existsSync(this.file)) {
      if (fs.statSync(this.file).size > 16000000) throw Error('Notion 续写记录过大。');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const job of saved.jobs || []) {
        if (job.state === 'running') { job.state = 'failed'; job.message = 'Notion 续写：上次生成被中断，请重新发起续写。'; }
        const t = { ...job.transcript, entities: new Map(job.transcript.entities.map(e => [e.id, e])), frames: [], stop: null, eventIds: new Set() };
        if (t.session?.status === 'running') t.session = this.events.session(t, 'idle');
        delete job.transcript; this.jobs.set(job.threadId, job); this.events.threads.set(job.threadId, t);
      }
    }
  }
  save() {
    const jobs = [...this.jobs.values()].map(job => {
      const t = this.events.threads.get(job.threadId);
      const { promise, undoPromise, recordMap, undoRecordMap, ...saved } = job;
      return { ...saved, transcript: { thread: t.thread, sessionId: t.sessionId, sequence: t.sequence, session: t.session, entities: [...t.entities.values()] } };
    });
    const bytes = JSON.stringify({ version: 1, jobs });
    if (Buffer.byteLength(bytes) > 15000000) edit.fail('本机续写记录已达上限，请先处理已有任务。');
    fs.writeFileSync(this.file + '.tmp', bytes); fs.renameSync(this.file + '.tmp', this.file);
  }
  owns(input) { return this.jobs.has(uuid(input?.threadId)); }
  record(id, table = 'thread', scope) { return this.events.record(uuid(id) || id, table, scope); }
  get active() { return this.controllers.size; }
  close() { for (const controller of this.controllers.values()) controller.abort(); }
  async snapshot(info, store, signal) { return edit.snapshot(info, store, signal); }
  transcript(job, question) {
    const now = Date.now(), sessionId = randomUUID(), thread = { id: job.threadId, space_id: job.spaceId, created_by_id: job.userId, alive: true, type: 'workflow', version: 1,
      created_time: now, updated_time: now, parent_table: 'space', parent_id: job.spaceId,
      created_source: 'writer', messages: [], has_transcript_content: true, session_id: sessionId, data: { title: question.slice(0, 40), type: 'personal_agent', agent_provider: { providerId: 'agent_service', sessionId } } };
    const t = { thread, sessionId, sequence: 0, frames: [], entities: new Map(), eventIds: new Set(), turns: [], stop: null };
    this.events.threads.set(job.threadId, t);
    const user = this.events.entity(t, 'user_message', { text: [[question]], files: [], is_current_user: true, render_on_user_side: true, user_message_kind: 'direct', client_message_id: job.clientMessageId });
    const assistant = this.events.entity(t, 'assistant_message', { source: 'provisional', turn_id: job.turnId, content: [{ type: 'text', text: '' }] });
    this.events.emit(t, [{ op: 'put', entity: user }, { op: 'put', entity: assistant }, { op: 'session_status', session: this.events.session(t, 'running') }]);
    return { t, assistant };
  }
  finishEvents(job, message, failed = false) {
    const t = this.events.threads.get(job.threadId), assistant = [...t.entities.values()].find(e => e.kind === 'assistant_message');
    t.thread.updated_time = Date.now(); t.thread.version++;
    assistant.source = 'committed'; assistant.content[0].text = message;
    const completed = this.events.entity(t, 'turn_completed', { turn_id: job.turnId, stop_reason: failed ? 'runtime_error' : 'end_turn' });
    job.idleEventId = completed.id;
    if (job.state === 'completed') job.undoToken ||= completed.id;
    this.events.emit(t, [{ op: 'put', entity: assistant }, { op: 'put', entity: completed }, { op: 'session_status', session: this.events.session(t, 'idle') }]);
  }
  result(job, recordMap) {
    const pending = job.state === 'submitted' || job.undoState === 'submitted';
    return json({ threadId: job.threadId, turnId: job.turnId, sessionIdleEventId: job.undoToken || job.idleEventId, status: pending ? 'pending' : job.state === 'completed' ? 'edited' : 'no_edit',
      undoReady: job.state === 'completed' && job.plan?.version === 2 && !!job.appliedRecords && !!uuid(job.undoToken) && !job.undoState && !job.undoBlocked,
      acknowledgment: job.state === 'undone' ? '编辑已撤销。' : job.undoState === 'submitted' ? '撤销结果待核对，请核对页面后重试；不会重复提交。'
        : job.state === 'completed' ? job.mode === 'continue' || !job.mode ? '续写已保存。' : '编辑已保存。'
        : job.state === 'submitted' ? '写入结果待核对，请点击“核对结果”；不会重复提交。' : job.message,
      ...(recordMap ? { recordMap } : {}) });
  }
  async verify(job, store, signal) {
    if (job.plan?.version !== 2) return this.verifyLegacy(job, store, signal);
    const records = await edit.readPlan(store, job.plan, signal);
    if (!job.plan.changes.every(change => edit.matches(change, records.get(change.id)))) return null;
    if (job.state !== 'completed' || !job.appliedRecords) {
      job.appliedRecords = [...records]; job.state = 'completed'; this.finishEvents(job, job.output);
    } else job.undoBlocked = job.appliedRecords.some(([id, entry]) => hash(records.get(id)) !== hash(entry));
    this.save(); return edit.recordMap(records, job.spaceId);
  }
  async verifyLegacy(job, store, signal) {
    const plan = job.plan, ids = [plan.blockId, ...(plan.parentId ? [plan.parentId] : [])];
    const records = await store.records(ids, signal); signal?.throwIfAborted();
    const target = records.get(plan.blockId), parent = plan.parentId ? records.get(plan.parentId) : null;
    if (!editable(target) || uuid(target.value.space_id) !== job.spaceId || hash(target.value.properties?.title || []) !== hash(plan.title) ||
        target.value.parent_id !== plan.anchorParentId || target.value.type !== plan.type || target.value.alive === false ||
        plan.parentId && (!editable(parent) || uuid(parent.value.space_id) !== job.spaceId || !parent.value.content?.includes(plan.blockId) ||
          parent.value.content.indexOf(plan.blockId) !== parent.value.content.indexOf(plan.afterId) + 1)) return null;
    const recordMap = { __version__: 3, block: Object.fromEntries([...records].map(([id, value]) => [id, { spaceId: job.spaceId, value }])) };
    job.state = 'completed'; this.finishEvents(job, job.output); this.save(); return recordMap;
  }
  async run(input, signal, meta) {
    let info;
    try { info = edit.normalize(input, meta?.userId); }
    catch (error) { return json({ threadId: uuid(input?.threadId), status: 'no_edit', undoReady: false, acknowledgment: error.message }); }
    const prior = this.jobs.get(info.threadId);
    if (prior) {
      if (prior.userId !== info.userId || prior.spaceId !== info.spaceId) return json({ message: 'Notion 续写不属于当前账号或工作区。' }, 403);
      if (prior.requestHash !== info.requestHash) return json({ message: 'Notion 续写请求已改变，请新建续写。' }, 409);
      if (prior.promise) return prior.promise.then(() => this.result(prior, prior.recordMap));
      if (prior.undoState === 'submitted') {
        try { const records = await this.verifyUndo(prior, this.storeFactory(info, meta), signal); return this.result(prior, records); }
        catch { return this.result(prior); }
      }
      if (prior.state === 'submitted' || prior.state === 'completed') {
        try { const records = await this.verify(prior, this.storeFactory(info, meta), signal); return records ? this.result(prior, records) : json({ threadId: info.threadId, status: 'no_edit', undoReady: false, acknowledgment: '此前续写已提交，但当前正文不匹配；请先检查页面，不会重复写入。' }); }
        catch { return this.result({ ...prior, state: 'submitted' }); }
      }
      return this.result(prior);
    }
    if (this.hasOtherRecord(info.threadId)) return json({ message: 'Notion 续写不能使用已有的其他 AI 对话。' }, 409);
    if (this.jobs.size >= 512) return json({ threadId: info.threadId, status: 'no_edit', undoReady: false, acknowledgment: '本机续写历史已达上限，请使用侧栏 AI。' });
    const controller = new AbortController(), active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const job = { threadId: info.threadId, userId: info.userId, spaceId: info.spaceId, clientMessageId: uuid(input.clientMessageId), requestHash: info.requestHash, turnId: randomUUID(), mode: info.mode, state: 'running' };
    this.jobs.set(job.threadId, job); this.controllers.set(job.threadId, controller);
    this.log({ type: 'native-writer-started', selectionType: input.threadContext.selection.type });
    const { t, assistant } = this.transcript(job, info.question);
    const work = async () => {
      try {
        this.save(); active.throwIfAborted(); const store = this.storeFactory(info, meta), snapshot = await this.snapshot(info, store, active);
        const config = this.provider.config(info.modelSelection); if (config.mode !== 'deepseek') edit.fail('请先配置 DeepSeek。');
        let output = '';
        for await (const delta of this.provider.generate({ config, messages: edit.messages(info, snapshot), signal: active })) {
          active.throwIfAborted(); output += delta; if (output.length > (info.mode === 'continue' ? 16000 : 64000)) edit.fail('生成内容过长，请缩小范围。');
          assistant.content[0].text = info.mode === 'continue' && !/^\s*(?:\{|```)/.test(output) ? output : '正在编辑所选文字…';
          this.events.emit(t, [{ op: 'put', entity: assistant }]);
        }
        active.throwIfAborted(); if (!output.trim()) edit.fail('模型没有返回内容，请检查配置后重试。');
        const parsed = edit.parseOutput(output, info, snapshot);
        if (parsed.clarification) { job.state = 'clarification'; job.message = parsed.clarification; this.finishEvents(job, job.message); this.save(); return; }
        const latest = await store.records(snapshot.fingerprints.map(([id]) => id), active); active.throwIfAborted();
        if (snapshot.fingerprints.some(([id, fingerprint]) => hash(latest.get(id) || null) !== fingerprint)) edit.fail('正文、位置或权限在生成期间发生变化，请重新编辑。');
        const plan = edit.buildPlan(info, snapshot, parsed);
        plan.changes = plan.changes.filter(change => !change.before || change.fields.some(name => {
          const field = value => name === 'title' ? value.properties?.title || [] : name === 'content' ? value.content || [] : name === 'alive' ? value.alive !== false : value[name];
          return hash(field(change.before)) !== hash(field(change.after));
        }));
        if (!plan.changes.length) { job.state = 'no_edit'; job.message = '选中文字无需修改。'; this.finishEvents(job, job.message); this.save(); return; }
        const created = plan.changes.filter(change => !change.before).map(change => change.id);
        if (created.length && (await store.records(created, active)).size) edit.fail('目标段落已存在，请重新生成。');
        job.plan = plan; job.output = edit.display(parsed, snapshot); job.requestId = randomUUID(); job.transactionId = randomUUID();
        const request = edit.transaction(plan, job.requestId, job.transactionId);
        job.state = 'submitted'; this.save();
        active.throwIfAborted();
        await store.api('saveTransactionsFanout', request, { signal: active, spaceId: info.spaceId });
        job.recordMap = await this.verify(job, store, active);
        if (!job.recordMap) { this.finishEvents(job, '编辑已经提交，但尚未核验；请检查页面后核对结果。', true); this.save(); }
      } catch (error) {
        if (job.state !== 'submitted' && job.state !== 'completed') {
          job.state = 'failed'; job.message = active.aborted ? '编辑已停止，没有提交页面修改。' : /^(?:Notion (?:Writer|续写)：|DeepSeek )/.test(error.message || '') ? error.message : 'Notion Writer 未完成，请检查模型配置与页面权限后重试。';
        }
        this.finishEvents(job, job.state === 'submitted' ? '编辑的提交结果尚未确定，请核对页面；不会重复提交。' : job.message || job.output, true);
        this.save();
      } finally {
        this.controllers.delete(job.threadId); this.log({ type: 'native-writer-ended', state: job.state });
      }
    };
    job.promise = work(); await job.promise; delete job.promise;
    return this.result(job, job.recordMap);
  }
  async verifyUndo(job, store, signal) {
    const records = await edit.readPlan(store, job.plan, signal);
    if (!job.plan.changes.every(change => edit.matches(change, records.get(change.id), true))) throw Error('撤销结果尚未确定，请检查页面；不会重复提交。');
    job.undoState = 'completed'; job.state = 'undone';
    const t = this.events.threads.get(job.threadId), assistant = [...t.entities.values()].find(entity => entity.kind === 'assistant_message');
    assistant.content[0].text = job.output + '\n\n编辑已撤销。';
    this.events.emit(t, [{ op: 'put', entity: assistant }]); this.save();
    return edit.recordMap(records, job.spaceId);
  }
  async undo(input, signal, meta) {
    const job = this.jobs.get(uuid(input.threadId));
    if (!job || !mayUseRecord(this.record(input.threadId), requestScope(input, meta))) return json({ message: 'Notion Writer 编辑不属于当前账号或工作区。' }, 403);
    if (!uuid(input.spaceId) || uuid(input.spaceId) !== job.spaceId || !uuid(input.sessionIdleEventId) || uuid(input.sessionIdleEventId) !== job.undoToken ||
        job.plan?.version !== 2 || !job.appliedRecords || job.promise || job.state !== 'completed' && job.state !== 'undone')
      return json({ message: 'Notion Writer 撤销标识无效，或该编辑尚未完成。' }, 409);
    if (job.undoPromise) return job.undoPromise.then(result => json(result.value, result.status));
    const controller = new AbortController(), active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.controllers.set(job.threadId, controller);
    const work = async () => {
      try {
        active.throwIfAborted(); const store = this.storeFactory(job, meta);
        if (job.undoState === 'completed' || job.undoState === 'submitted') {
          const recordMap = await this.verifyUndo(job, store, active); return { status: 200, value: { undone: true, recordMap } };
        }
        const current = await edit.readPlan(store, job.plan, active);
        if (job.appliedRecords.some(([id, entry]) => hash(current.get(id) || null) !== hash(entry)))
          return { status: 409, value: { message: '编辑后的内容或权限已经变化，未覆盖你的后续修改；请在页面历史中核对。' } };
        job.undoRequestId = randomUUID(); job.undoTransactionId = randomUUID();
        const request = edit.transaction(job.plan, job.undoRequestId, job.undoTransactionId, true);
        job.undoState = 'submitted'; this.save();
        active.throwIfAborted();
        await store.api('saveTransactionsFanout', request, { signal: active, spaceId: job.spaceId });
        const recordMap = await this.verifyUndo(job, store, active); return { status: 200, value: { undone: true, recordMap } };
      } catch {
        return { status: 409, value: { message: job.undoState === 'submitted' ? '撤销结果尚未确定，请核对页面后重试；不会重复提交。' : '撤销未完成，请检查页面权限后重试。' } };
      } finally { this.controllers.delete(job.threadId); }
    };
    job.undoPromise = work(); const result = await job.undoPromise; delete job.undoPromise;
    return json(result.value, result.status);
  }
  async handle(endpoint, input, signal, meta) {
    if (endpoint === 'runWriter') return this.run(input, signal, meta);
    // Public client 902936.iM in 82593-71993cacf4b1c761.js (SHA-256
    // 8ea51820e14c6e6fa1590545b93172f20931a4fc5dc791d139177462865eb4d7)
    // awaits a JSON response and its recordMap before closing the native UI.
    if (endpoint === 'undoAgentServiceTurn') return this.undo(input, signal, meta);
    const job = this.jobs.get(uuid(input.threadId)), record = this.record(input.threadId);
    if (!job || !mayUseRecord(record, requestScope(input, meta))) return json({ message: 'Notion 续写对话不属于当前账号或工作区。' }, 403);
    if (endpoint === 'getThreadTranscript') return this.events.transcript(input, meta);
    if (endpoint === 'listenToThreadTranscript') return this.events.listen(input, signal, meta);
    if (endpoint === 'getThreadQueuedMessages') return json({ messages: [] });
    const stopEvents = input.events || [input.event];
    if (endpoint === 'stopWorkflowAutomationRunThread' || endpoint === 'sendEventToAgentThread' && Array.isArray(stopEvents) && stopEvents.length && stopEvents.every(event => /interrupt|stop|cancel/.test(event?.type || ''))) {
      this.controllers.get(job.threadId)?.abort(); return json({});
    }
    return json({ message: 'Notion 续写不接受此操作，请新建侧栏对话。' }, 409);
  }
}
module.exports = { NativeWriter };
