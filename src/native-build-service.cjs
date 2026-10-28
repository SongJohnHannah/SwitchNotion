const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { isDatabaseBuild, buildMessages, parseBuildOutput } = require('./native-database-build.cjs');
const { emptyPreviewReducers } = require('./native-database-build-views.cjs');
const fail = (message, status = 400) => { throw Object.assign(Error('Notion AI 建库' + message), { status }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const plain = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(span => typeof span?.[0] === 'string' ? span[0] : '').join('') : '';
const message = error => /^Notion AI 建库/.test(error?.message || '') ? error.message : 'Notion AI 建库未完成，请检查模型、页面权限和本地记录后重试。';
const escape = value => String(value).replace(/[\\`*_{}\[\]()#+.!|<>-]/g, '\\$&').replace(/[\r\n]+/g, ' ');
const url = id => 'https://www.notion.so/' + id.replaceAll('-', '');

function sanitizeStep(step, userId) {
  if (!object(step) || !uuid(step.id) || typeof step.type !== 'string') fail('消息标识或格式无效。');
  const result = { id: uuid(step.id), type: step.type };
  const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, structuredClone(value[key])]));
  if (step.type === 'config') {
    result.value = pick(step.value, ['type', 'oracleThreadType', 'onboardingAgentVersion', 'agentSource', 'enableScriptAgent',
      'createResultNavigationBehavior', 'useReadOnlyMode', 'model', 'modelFromUser', 'locale']);
    if (!isDatabaseBuild({ transcript: [result] })) fail('配置不属于已核对的数据库创建入口。');
  } else if (step.type === 'context') {
    if (!object(step.value)) fail('入口上下文无效。');
    result.value = pick(step.value, ['blockId', 'peekBlockId', 'spaceId', 'surface']);
    for (const key of ['blockId', 'peekBlockId', 'spaceId']) if (result.value[key] !== undefined) {
      if (!uuid(result.value[key])) fail('入口上下文标识无效。'); result.value[key] = uuid(result.value[key]);
    }
  } else if (['user', 'user-injected', 'title'].includes(step.type)) {
    if (step.userId !== undefined && uuid(step.userId) !== userId) fail('消息发送账号不匹配。', 403);
    Object.assign(result, pick(step, ['value', 'actualMessage', 'displayMessage', 'promptType', 'locale']));
    if (plain(result.actualMessage ?? result.value).length > 32000) fail('消息过长。');
  } else if (step.type === 'user-specified-context') {
    if (!Array.isArray(step.value?.pointers) || step.value.pointers.length || step.value.textSelection || step.value.blockSelection) fail('所附来源尚未读取，未忽略来源继续建库。');
    result.value = { pointers: [] };
  } else fail('来源、附件或消息类型尚未接入。');
  return result;
}
function schemaText(plan) {
  const labels = { title: '标题', text: '文字', number: '数字', select: '单选', multi_select: '多选', status: '状态', date: '日期',
    checkbox: '复选框', url: '网址', email: '邮箱', phone_number: '电话', person: '人员', file: '文件', created_time: '创建时间',
    last_edited_time: '编辑时间', created_by: '创建人', last_edited_by: '编辑人', auto_increment_id: '编号' };
  return '**数据库预览：' + escape(plan.draft.title) + '**\n\n位置：' + (plan.parentPointer.table === 'space' ? '当前工作区的私人页面' : '[所选父页面](' + url(plan.parentPointer.id) + ')') +
    '\n\n| 字段 | 类型 | 选项 |\n| --- | --- | --- |\n' + plan.draft.columns.map(column => '| ' + escape(column.name) + ' | ' +
      (labels[column.type] || escape(column.type)) + ' | ' + escape(column.options?.join('、') || column.groups?.map(group => group.name + '：' + group.options.join('、')).join('；') || '') + ' |').join('\n') +
    (plan.draft.views ? '\n\n视图：' + plan.draft.views.map(view => escape(view.name) + '（' + ({ table: '表格', board: '看板', calendar: '日历', list: '列表', gallery: '画廊', timeline: '时间轴' })[view.type] +
      (view.groupBy ? '，按 ' + escape(view.groupBy) + ' 分组' : '') + (view.dateBy ? '，日期 ' + escape(view.dateBy) : '') +
      (view.endDateBy ? '，结束日期 ' + escape(view.endDateBy) : '') + (view.sort ? '，按 ' + escape(view.sort.property) + (view.sort.direction === 'ascending' ? ' 升序' : ' 降序') : '') + '）').join('、') : '') +
    '\n\n此方案尚未创建。请在原生确认入口确认，或继续描述要调整的字段和视图；拒绝预览不会修改页面。';
}
class NativeBuildService {
  constructor({ root, provider, storeFactory, log = () => {} }) {
    Object.assign(this, { provider, storeFactory, log }); this.file = path.join(root, 'native-builds.local.json'); this.available = true;
    this.threads = new Map(); this.running = new Map(); this.queues = new Map(); this.tasks = new Set();
    try {
      if (fs.statSync(this.file).size > 20 * 1024 * 1024) fail('本地确认记录过大，请保留记录并检查。');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.threads)) fail('本地记录格式无效。');
      const ids = new Set();
      for (const t of saved.threads) {
        if (!uuid(t.id) || !uuid(t.ownerId) || !uuid(t.spaceId) || !Array.isArray(t.steps) || t.steps.length > 400 || !Array.isArray(t.plans) ||
            t.plans.length > 100 || !Number.isSafeInteger(t.version) || t.version < 1 || !['idle', 'generating', 'committing', 'failed'].includes(t.status) ||
            t.steps.some(step => !uuid(step.id) || ids.has(step.id) || (ids.add(step.id), false))) fail('本地消息或账号范围无效。');
        if (this.threads.has(t.id)) fail('本地线程标识重复。');
        t.visibleIds ||= t.steps.map(step => step.id);
        if (!Array.isArray(t.visibleIds) || new Set(t.visibleIds).size !== t.visibleIds.length || t.visibleIds.some(id => !t.steps.some(step => step.id === id))) fail('本地消息顺序无效。');
        for (const item of t.plans) {
          if (!item.plan || item.plan.spaceId !== t.spaceId || item.plan.userId !== t.ownerId || !uuid(item.plan.step?.id) ||
              !['prepared', 'confirmed', 'submitted', 'uncertain', 'verified', 'rejected', 'superseded', 'failed'].includes(item.status)) fail('本地方案或核验记录无效。');
          if (item.status === 'submitted') item.status = 'uncertain';
        }
        if (['generating', 'committing'].includes(t.status)) { t.status = 'failed'; t.error = 'Notion AI 建库因程序重启中断；已提交记录须先核对，不能重复创建。'; }
        this.threads.set(t.id, t);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  get active() { return this.running.size; }
  accepts(input) { return isDatabaseBuild(input) || this.threads.has(uuid(input?.threadId)); }
  owns(input) { return this.threads.has(uuid(input?.threadId)); }
  scope(t, { userId, spaceId } = {}) { return !!t && t.ownerId === uuid(userId) && (spaceId === undefined || t.spaceId === uuid(spaceId)); }
  findRecord(id, table) {
    id = uuid(id); if (!id) return;
    if (table === 'thread') return this.threads.get(id);
    if (table === 'thread_message') return [...this.threads.values()].find(t => t.steps.some(step => step.id === id));
  }
  previewOwner(id, table) {
    id = uuid(id); if (!id || !['block', 'collection', 'collection_view'].includes(table)) return;
    return [...this.threads.values()].find(t => t.plans.some(item => item.status !== 'verified' && item.plan.step.threadOperations.some(({ operation }) =>
      operation.command === 'set' && operation.pointer.table === table && operation.pointer.id === id)));
  }
  previewParentOwner(operation) {
    if (!['set', 'update'].includes(operation.command) || !equal(operation.path, []) || !object(operation.args)) return;
    const args = operation.args, pointers = [{ id: args.parent_id, table: args.parent_table }, { id: args.collection_id, table: 'collection' },
      args.format?.collection_pointer, ...(Array.isArray(args.format?.collection_pointers) ? args.format.collection_pointers : [])];
    for (const pointer of pointers) {
      if (!object(pointer)) continue; const owner = this.previewOwner(pointer.id, pointer.table); if (owner) return owner;
    }
  }
  threadRecord(t) {
    return { id: t.id, version: t.version, space_id: t.spaceId, alive: t.alive !== false, type: 'workflow', messages: [...(t.visibleIds || t.steps.map(step => step.id))],
      parent_id: t.spaceId, parent_table: 'space', created_time: t.createdAt, updated_time: t.updatedAt, latest_user_or_trigger_time: t.updatedAt,
      created_by_id: t.ownerId, created_by_table: 'notion_user', permissions: [{ type: 'user_permission', role: 'editor', user_id: t.ownerId }],
      has_transcript_content: true, created_source: 'post_onboarding_agent', data: { title: t.title || '数据库创建', notion_switch_database_build: true,
        ...(t.outcome ? { last_turn_outcome: t.outcome } : {}) },
      current_inference_id: t.status === 'generating' ? t.currentTraceId : undefined,
      current_inference_lease_expiration: t.status === 'generating' ? t.updatedAt + 1800000 : 0,
      ...(t.outcome ? { last_turn_outcome: t.outcome } : {}) };
  }
  historyRecord(id) { const t = this.threads.get(uuid(id)); return t && this.threadRecord(t); }
  historyThreads() { return new Map([...this.threads].map(([id, t]) => [id, { thread: this.threadRecord(t) }])); }
  record(id, table = 'thread', scope) {
    const t = this.findRecord(id, table) || this.previewOwner(id, table); if (!this.scope(t, scope)) return;
    if (!['thread', 'thread_message'].includes(table)) {
      const item = t.plans.find(item => ['prepared', 'confirmed'].includes(item.status) && item.plan.step.threadOperations.some(({ operation }) =>
        operation.command === 'set' && operation.pointer.table === table && operation.pointer.id === uuid(id)));
      const op = item?.plan.step.threadOperations.find(({ operation }) => operation.command === 'set' && operation.pointer.table === table && operation.pointer.id === uuid(id));
      return op && { ...structuredClone(op.operation.args), notion_switch_preview: true };
    }
    if (table === 'thread') return this.threadRecord(t);
    const step = t.steps.find(step => step.id === uuid(id));
    return { id: step.id, version: t.version, space_id: t.spaceId, parent_id: t.id, parent_table: 'thread', created_time: t.createdAt,
      created_by_id: t.ownerId, created_by_table: 'notion_user', step: structuredClone(step) };
  }
  recordRole(id, table, scope) { return this.record(id, table, scope)?.notion_switch_preview ? 'reader' : undefined; }
  previewQuery(input, meta = {}) {
    const id = uuid(input?.source?.id), viewId = uuid(input?.collectionView?.id), t = this.previewOwner(id, 'collection') || this.previewOwner(viewId, 'collection_view');
    if (!t) return null;
    if (!this.scope(t, { userId: meta.userId }) || [input.source?.spaceId, input.collectionView?.spaceId].some(spaceId => spaceId !== undefined && uuid(spaceId) !== t.spaceId)) return json({ message: 'Notion AI 建库预览账号或工作区不匹配。' }, 403);
    const item = t.plans.find(item => ['prepared', 'confirmed'].includes(item.status) && item.plan.collectionId === id && (item.plan.viewIds || [item.plan.viewId]).includes(viewId));
    if (!item) return json({ message: 'Notion AI 建库预览已关闭或正在核验创建，请重新加载。' }, 409);
    let reducerResults;
    try {
      const schema = item.plan.step.threadOperations.find(({ operation }) => operation.command === 'set' && operation.pointer.table === 'collection').operation.args.schema;
      const language = meta.request?.headers.get('accept-language')?.split(',')[0]?.split(';')[0]?.trim();
      reducerResults = emptyPreviewReducers(input.loader?.reducers, schema, language);
    } catch (error) { return json({ message: message(error) }, 400); }
    const recordMap = { __version__: 3 };
    for (const [table, recordId] of [['block', item.plan.databaseId], ['collection', id], ...(item.plan.viewIds || [item.plan.viewId]).map(id => ['collection_view', id])]) {
      (recordMap[table] ||= {})[recordId] = { spaceId: t.spaceId, value: { role: 'reader', value: this.record(recordId, table, { userId: t.ownerId, spaceId: t.spaceId }) } };
    }
    return json({ recordMap, result: { type: 'reducer', reducerResults } });
  }
  recordMap(t) {
    const scope = { userId: t.ownerId, spaceId: t.spaceId }, result = { __version__: 3, thread: {}, thread_message: {} };
    const put = (table, value) => { result[table][value.id] = { spaceId: t.spaceId, value: { role: 'editor', value } }; };
    put('thread', this.threadRecord(t)); for (const step of t.steps) put('thread_message', this.record(step.id, 'thread_message', scope)); return result;
  }
  save() {
    const body = JSON.stringify({ version: 1, threads: [...this.threads.values()] });
    if (Buffer.byteLength(body) > 20 * 1024 * 1024) fail('本地确认记录过大，请保留记录并检查。', 503);
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); const temporary = this.file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, body, { mode: 0o600, flush: true });
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, this.file); break; }
      catch (error) { if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1)); }
    }
  }
  changed(t) { t.version++; t.updatedAt = Date.now(); }
  enqueue(id, run) {
    const prior = this.queues.get(id) || Promise.resolve(), task = prior.catch(() => {}).then(run);
    this.queues.set(id, task); this.tasks.add(task);
    void task.finally(() => { this.tasks.delete(task); if (this.queues.get(id) === task) this.queues.delete(id); }).catch(() => {}); return task;
  }
  visibleSteps(t) { return (t.visibleIds || t.steps.map(step => step.id)).map(id => t.steps.find(step => step.id === id)); }
  sourceKey(t) { return hash(this.visibleSteps(t).filter(step => ['config', 'context', 'user', 'user-injected', 'user-specified-context'].includes(step.type))); }
  merge(t, input) {
    if (!Array.isArray(input.transcript) || input.transcript.length > 200 || JSON.stringify(input.transcript).length > 500000) fail('请求内容缺失或过长。');
    t.visibleIds ||= t.steps.map(step => step.id);
    const incomingIds = [];
    for (const step of input.transcript) {
      if (!uuid(step?.id)) fail('消息标识无效。'); incomingIds.push(uuid(step.id));
      const existing = t.steps.find(value => value.id === uuid(step?.id));
      if (['agent-inference', 'agent-tool-result'].includes(step?.type)) {
        if (!existing || existing.type !== step.type) fail('不能导入未经本地核对的模型输出或工具方案。');
        if (!t.visibleIds.includes(existing.id)) t.visibleIds.push(existing.id);
        continue; // Canonical saved outputs, not client edits, remain authoritative.
      }
      const value = sanitizeStep(step, t.ownerId), owner = this.findRecord(value.id, 'thread_message');
      if (owner && owner.id !== t.id) fail('消息不属于当前建库线程。');
      const index = t.steps.findIndex(step => step.id === value.id);
      if (index >= 0) t.steps[index] = value; else t.steps.push(value);
      if (!t.visibleIds.includes(value.id)) t.visibleIds.push(value.id);
    }
    if (input.isPartialTranscript !== true) t.visibleIds = [...new Set(incomingIds)];
    if (t.steps.length > 400 || t.steps.filter(step => step.type === 'config').length !== 1) fail('历史过长或建库配置不完整。');
  }
  modelInput(t) {
    const transcript = this.visibleSteps(t).flatMap(step => {
      if (step.type !== 'agent-tool-result') return [step];
      const item = t.plans.find(item => item.plan.step.id === step.id);
      return item ? [{ id: step.id, type: 'agent-inference', value: [{ type: 'text', content: '此前数据库方案（' + item.status + '，不是新的创建授权）：\n' + JSON.stringify(item.plan.draft) }] }] : [];
    });
    return { spaceId: t.spaceId, threadId: t.id, transcript };
  }
  parentPointer(t) {
    const context = this.visibleSteps(t).findLast(step => step.type === 'context')?.value, id = uuid(context?.peekBlockId || context?.blockId);
    return id ? { table: 'block', id, spaceId: t.spaceId } : { table: 'space', id: t.spaceId, spaceId: t.spaceId };
  }
  async store(t, meta) {
    const store = meta.store || await this.storeFactory({ spaceId: t.spaceId, threadId: t.id }, meta);
    if (store.userId !== t.ownerId || store.spaceId !== t.spaceId) fail('原生会话账号或工作区不匹配。', 403); return store;
  }
  output(t, steps, input, emit, status = 'success') {
    const ids = new Set(t.steps.map(step => step.id));
    for (const step of steps) if (!ids.has(step.id)) { t.steps.push(structuredClone(step)); ids.add(step.id); }
    for (const step of steps) if (!t.visibleIds.includes(step.id)) t.visibleIds.push(step.id);
    t.lastOutputIds = steps.map(step => step.id); t.status = status === 'success' ? 'idle' : 'failed'; this.changed(t);
    t.outcome = { inference_id: uuid(input.traceId) || steps.at(-1)?.traceId || randomUUID(), status, completed_time: Date.now(),
      step_count: steps.length, final_step_id: steps.at(-1)?.id };
    this.save(); emit({ type: 'record-map', recordMap: this.recordMap(t) });
    if (input.asPatchResponse === true) emit({ type: 'patch-start', data: { s: steps } }); else steps.forEach(emit);
  }
  assistant(text, input) { return { id: randomUUID(), type: 'agent-inference', traceId: uuid(input.traceId) || randomUUID(),
    startedAt: Date.now(), finishedAt: Date.now(), value: [{ type: 'text', content: text }] }; }
  async stream(input, signal, meta = {}) {
    const id = uuid(input?.threadId), spaceId = uuid(input?.spaceId), userId = uuid(meta.userId);
    if (!id || !spaceId || !userId) return json({ message: 'Notion AI 建库线程或登录账号无效。' }, 400);
    let t = this.threads.get(id);
    if (t && !this.scope(t, { userId, spaceId })) return json({ message: 'Notion AI 建库线程不属于当前账号或工作区。' }, 403);
    if (!t) {
      if (input.createThread !== true || !isDatabaseBuild(input)) return json({ message: 'Notion AI 建库本地线程不存在，请从客户端重新开始。' }, 404);
      const now = Date.now(); t = { id, ownerId: userId, spaceId, createdAt: now, updatedAt: now, version: 1, status: 'idle', steps: [], visibleIds: [], plans: [] }; this.threads.set(id, t);
    }
    const generation = new AbortController(), active = signal ? AbortSignal.any([signal, generation.signal]) : generation.signal;
    this.running.get(id)?.controller.abort(); const turn = { controller: generation }; this.running.set(id, turn);
    const encoder = new TextEncoder(); let controller, ended = false;
    const emit = value => { if (!ended) controller.enqueue(encoder.encode(JSON.stringify(value) + '\n')); };
    const finish = () => { if (!ended) { ended = true; try { controller.close(); } catch {} } };
    const snapshot = structuredClone(input);
    const response = new Response(new ReadableStream({ start: value => { controller = value; }, cancel: () => { generation.abort(); finish(); } }),
      { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
    const task = this.enqueue(id, async () => {
      try {
        active.throwIfAborted(); this.running.set(id, turn); this.merge(t, snapshot);
        if (this.provider.status().mode !== 'deepseek') fail('请先在配置中启用 DeepSeek。');
        const decisions = [];
        for (const [key, decision] of [['confirmToolStepIds', 'confirmed'], ['rejectToolStepIds', 'rejected']]) {
          if (snapshot[key] === undefined) continue;
          if (!Array.isArray(snapshot[key]) || snapshot[key].length > 32) fail('确认列表无效。');
          for (const stepId of snapshot[key]) {
            if (!uuid(stepId) || decisions.some(value => value.stepId === uuid(stepId)) || !t.plans.some(item => item.plan.step.id === uuid(stepId))) fail('确认方案不存在或重复。');
            decisions.push({ stepId: uuid(stepId), decision });
          }
        }
        if (decisions.length) {
          const steps = [];
          for (const decision of decisions) {
            const actual = await this.decide(t, decision, active, meta); if (actual) emit({ type: 'record-map', recordMap: actual });
            const item = t.plans.find(item => item.plan.step.id === decision.stepId);
            if (item.completedMessageId) steps.push(t.steps.find(step => step.id === item.completedMessageId));
            else steps.push(this.assistant('已拒绝此建库方案，未创建数据库。', snapshot));
            steps.push(t.steps.find(step => step.id === decision.stepId));
          }
          this.output(t, steps, snapshot, emit); return;
        }
        const key = this.sourceKey(t), messages = buildMessages(this.modelInput(t));
        const verified = t.plans.findLast(item => item.sourceKey === key && item.status === 'verified');
        if (verified || t.lastSourceKey === key && snapshot.isRetry !== true && t.lastOutputIds?.length) {
          const ids = verified ? [verified.completedMessageId, verified.plan.step.id] : t.lastOutputIds;
          this.output(t, ids.map(id => t.steps.find(step => step.id === id)).filter(Boolean), snapshot, emit); return;
        }
        if (t.plans.some(item => ['submitted', 'uncertain', 'confirmed'].includes(item.status))) fail('此前确认或写入结果尚未核对；请先重试原方案的确认，不能另建重复方案。', 409);
        t.status = 'generating'; t.currentTraceId = uuid(snapshot.traceId) || randomUUID(); this.changed(t); this.save(); emit({ type: 'record-map', recordMap: this.recordMap(t) });
        let output = '';
        for await (const delta of this.provider.generate({ config: { ...this.provider.config(), maxTokens: 16384, multiAgent: false }, messages, signal: active })) {
          active.throwIfAborted(); output += delta; if (output.length > 200000) fail('模型方案过长。');
        }
        active.throwIfAborted(); const draft = parseBuildOutput(output);
        if (draft.type === 'chat') { t.lastSourceKey = key; this.output(t, [this.assistant(draft.message, snapshot)], snapshot, emit); return; }
        if (t.steps.find(step => step.type === 'config')?.value.useReadOnlyMode === true) fail('当前为只读模式；请启用编辑后重新生成可确认的建库预览。');
        const store = await this.store(t, meta), plan = await store.prepare(draft, this.parentPointer(t), active); active.throwIfAborted();
        for (const item of t.plans) if (item.status === 'prepared') {
          item.status = 'superseded'; const old = t.steps.find(step => step.id === item.plan.step.id);
          if (old) { old.state = 'confirmation:rejected'; old.done = true; delete old.threadOperations; }
        }
        if (t.plans.length >= 100) fail('此线程方案过多，请新建建库对话。');
        const step = { ...structuredClone(plan.step), notionSwitchBuild: { version: 1, planId: plan.step.id, planHash: plan.planHash } };
        t.plans.push({ plan, status: 'prepared', sourceKey: key }); t.title = draft.title; t.lastSourceKey = key;
        this.output(t, [this.assistant(schemaText(plan), snapshot), step], snapshot, emit);
      } catch (error) {
        t.status = 'failed'; t.error = active.aborted ? 'Notion AI 建库生成已停止，未提交新的创建事务。' : message(error); this.changed(t);
        try { this.save(); } catch {}
        if (!active.aborted) this.output(t, [this.assistant(t.error, snapshot)], snapshot, emit, 'failure');
        else { t.outcome = { inference_id: t.currentTraceId || randomUUID(), status: 'failure', completed_time: Date.now(), step_count: 0 }; try { this.save(); } catch {} }
      } finally { if (this.running.get(id) === turn) this.running.delete(id); finish(); }
    });
    void task.catch(() => finish()); return response;
  }
  inspectTransactions(input, meta) {
    if (!Array.isArray(input?.transactions)) return null;
    const ops = input.transactions.flatMap(transaction => Array.isArray(transaction.operations) ? transaction.operations.map(operation => ({ operation, spaceId: transaction.spaceId })) : []);
    const owned = ops.map(({ operation: op }) => this.findRecord(op.pointer?.id, op.pointer?.table) || this.previewOwner(op.pointer?.id, op.pointer?.table) || this.previewParentOwner(op) ||
      (op.pointer?.table === 'thread_message' && op.command === 'set' && equal(op.path, []) && op.args?.parent_table === 'thread' ? this.threads.get(uuid(op.args.parent_id)) : undefined));
    const marked = ops.some(({ operation }) => operation.args?.notionSwitchBuild || operation.args?.step?.notionSwitchBuild);
    if (!owned.some(Boolean) && !marked) return null;
    if (!ops.length || ops.length > 256 || JSON.stringify(input).length > 1000000 || owned.some(t => !t)) fail('不能混合提交本地建库消息与其他记录修改。', 409);
    const ids = new Set(owned.map(t => t.id)); if (ids.size !== 1) fail('请分别确认各建库线程，未拆分提交。', 409);
    const t = owned[0]; if (!this.scope(t, { userId: meta.userId })) fail('确认不属于当前登录账号。', 403);
    const decisions = [], steps = structuredClone(t.steps), visibleIds = [...(t.visibleIds || t.steps.map(step => step.id))], newIds = new Set(), linked = new Set(); let threadTitle = t.title, alive = t.alive;
    for (let at = 0; at < ops.length; at++) {
      const { operation: op, spaceId } = ops[at];
      if (spaceId !== undefined && uuid(spaceId) !== t.spaceId || uuid(op.pointer?.spaceId) !== t.spaceId) fail('确认事务工作区不匹配。', 403);
      if (op.pointer.table === 'thread_message') {
        let step = steps.find(step => step.id === uuid(op.pointer.id));
        if (op.command === 'set' && equal(op.path, [])) {
          if (!object(op.args) || uuid(op.args.id) !== uuid(op.pointer.id) || uuid(op.args.parent_id) !== t.id || op.args.parent_table !== 'thread' ||
              op.args.space_id !== undefined && uuid(op.args.space_id) !== t.spaceId || op.args.created_by_id !== undefined && uuid(op.args.created_by_id) !== t.ownerId) fail('新消息不属于当前建库线程。', 403);
          if (step && ['agent-inference', 'agent-tool-result'].includes(step.type)) { if (!equal(op.args.step, step)) fail('不能修改已保存的生成方案。'); continue; }
          const value = sanitizeStep(op.args.step, t.ownerId); if (value.id !== uuid(op.pointer.id)) fail('消息标识不匹配。');
          if (step) steps[steps.findIndex(step => step.id === value.id)] = value;
          else { steps.push(value); newIds.add(value.id); }
          continue;
        }
        if (!step || !['update', 'set'].includes(op.command) || !equal(op.path, ['step']) || !object(op.args)) fail('本地消息修改协议尚未支持。');
        if (step.type === 'agent-inference') { if (!equal(op.args, step)) fail('不能修改本地生成结果。'); continue; }
        if (step.type === 'agent-tool-result') {
          const item = t.plans.find(item => item.plan.step.id === step.id); if (!item) fail('找不到对应的原始建库方案。');
          const state = op.args.state;
          if (!['confirmation:confirmed', 'confirmation:rejected'].includes(state)) {
            if (equal(op.args, step)) continue; fail('客户端不能自行把方案标记为已创建。');
          }
          const expected = { ...structuredClone(item.plan.step), notionSwitchBuild: { version: 1, planId: step.id, planHash: item.plan.planHash } };
          const immutable = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['state', 'done', 'userConfirmation', 'threadOperations'].includes(key)));
          if (!equal(immutable(op.args), immutable(expected)) || op.args.threadOperations !== undefined && !equal(op.args.threadOperations, item.plan.step.threadOperations))
            fail('确认中的字段、位置或方案内容已变化，未创建数据库。');
          decisions.push({ stepId: step.id, decision: state === 'confirmation:confirmed' ? 'confirmed' : 'rejected' });
        } else {
          const updated = sanitizeStep(op.args, t.ownerId); if (updated.id !== step.id || updated.type !== step.type) fail('消息所属或类型已经变化。'); steps[steps.findIndex(value => value.id === step.id)] = updated;
        }
      } else if (op.pointer.table === 'thread') {
        if (!Array.isArray(op.path)) fail('线程修改协议尚未支持。');
        if (equal(op.path, ['messages'])) {
          if (['listAfter', 'listBefore'].includes(op.command) && uuid(op.args?.id) && steps.some(step => step.id === uuid(op.args.id))) {
            const id = uuid(op.args.id), relative = op.command === 'listAfter' ? op.args.after : op.args.before;
            if (relative !== undefined && !visibleIds.includes(uuid(relative))) fail('消息插入位置无效。');
            const prior = visibleIds.indexOf(id); if (prior >= 0) visibleIds.splice(prior, 1);
            const index = relative === undefined ? op.command === 'listAfter' ? 0 : visibleIds.length : visibleIds.indexOf(uuid(relative)) + (op.command === 'listAfter' ? 1 : 0);
            visibleIds.splice(index, 0, id); linked.add(id);
          } else if (op.command === 'set' && Array.isArray(op.args) && op.args.every(id => uuid(id) && steps.some(step => step.id === uuid(id))) && new Set(op.args.map(uuid)).size === op.args.length) {
            visibleIds.splice(0, visibleIds.length, ...op.args.map(uuid)); op.args.map(uuid).forEach(id => linked.add(id));
          } else if (op.command === 'listRemove' && uuid(op.args?.id) && visibleIds.includes(uuid(op.args.id))) visibleIds.splice(visibleIds.indexOf(uuid(op.args.id)), 1);
          else fail('消息列表修改超出当前线程。');
        } else if (op.command === 'update' && equal(op.path, ['data']) && object(op.args) && Object.keys(op.args).every(key => key === 'title') && typeof op.args.title === 'string' && op.args.title.length <= 500) threadTitle = op.args.title;
        else if (op.command === 'set' && equal(op.path, ['data', 'title']) && typeof op.args === 'string' && op.args.length <= 500) threadTitle = op.args;
        else if (op.command === 'update' && equal(op.path, []) && object(op.args) && Object.keys(op.args).every(key => ['updated_time', 'latest_user_or_trigger_time', 'has_transcript_content', 'alive'].includes(key))) {
          if (op.args.alive !== undefined) { if (typeof op.args.alive !== 'boolean') fail('线程状态无效。'); alive = op.args.alive; }
          // Native edit metadata is represented by this service's own version.
        } else fail('线程修改超出本地建库消息范围。');
      } else fail('尚未创建的预览只能确认或通过对话调整，未提交页面修改。', 409);
    }
    if ([...newIds].some(id => !linked.has(id)) || steps.length > 400) fail('新消息没有完整关联到线程，或历史过长。');
    if (new Set(decisions.map(value => value.stepId)).size !== decisions.length) fail('同一事务重复确认了方案。');
    return { t, decisions, steps, visibleIds, threadTitle, alive };
  }
  async decide(t, decision, signal, meta) {
    const item = t.plans.find(item => item.plan.step.id === decision.stepId), step = t.steps.find(step => step.id === decision.stepId);
    if (!item || !step) fail('原始方案不存在。');
    if (decision.decision === 'rejected') {
      if (['submitted', 'uncertain', 'verified'].includes(item.status)) fail('创建事务已经提交或结果未确认；拒绝不会撤销已提交修改。', 409);
      item.status = 'rejected'; step.state = 'confirmation:rejected'; step.done = true; delete step.threadOperations; this.changed(t); this.save(); return;
    }
    if (['superseded', 'rejected', 'failed'].includes(item.status)) fail('此方案已被拒绝、替换或失效，请重新生成预览。', 409);
    if (t.alive === false || item.sourceKey !== this.sourceKey(t) || t.steps.find(step => step.type === 'config')?.value.useReadOnlyMode === true) fail('问题、位置或编辑权限开关已变化，请重新生成预览。', 409);
    const store = await this.store(t, meta); store.check(item.plan);
    const complete = actual => {
      item.status = 'verified'; delete item.error; step.state = 'applied'; step.done = true; delete step.error; delete step.threadOperations;
      if (!item.completedMessageId) {
        const result = this.assistant('数据库已创建：[' + escape(item.plan.draft.title) + '](' + url(item.plan.databaseId) + ')。', {});
        item.completedMessageId = result.id; t.steps.push(result); if (!t.visibleIds.includes(result.id)) t.visibleIds.push(result.id);
      }
      t.status = 'idle'; t.outcome = { inference_id: step.traceId || randomUUID(), status: 'success', completed_time: Date.now(), step_count: 1, final_step_id: step.id };
      this.changed(t); this.save(); return actual.recordMap;
    };
    if (['submitted', 'uncertain', 'verified'].includes(item.status)) {
      const actual = await store.verify(item.plan, signal).catch(() => ({ ok: false }));
      if (actual.ok) return complete(actual); fail('此前创建结果尚未确认，本次只读取核对，不重复提交。', 409);
    }
    item.status = 'confirmed'; item.confirmation = { decision: 'confirmed', stepId: step.id, planHash: item.plan.planHash, userId: t.ownerId, spaceId: t.spaceId };
    t.status = 'committing'; this.changed(t); this.save();
    let error;
    try { await store.submit(item.plan, { signal, confirmation: item.confirmation, onSubmit: () => { item.status = 'submitted'; this.save(); } }); }
    catch (value) { error = value; }
    if (item.status !== 'submitted' && error) {
      item.status = 'failed'; step.state = 'applied:error'; step.done = true; delete step.threadOperations;
      item.error = message(error); step.error = { type: 'notionSwitchBuild', message: item.error }; t.status = 'failed'; this.changed(t); this.save(); throw error;
    }
    const actual = await store.verify(item.plan, AbortSignal.timeout(15000)).catch(() => ({ ok: false }));
    if (actual.ok) return complete(actual);
    item.status = error?.notSubmitted === true ? 'failed' : 'uncertain'; item.error = item.status === 'uncertain'
      ? 'Notion AI 建库创建结果尚未确认，已保留原始方案与记录标识；重试只核对，不重复创建。' : 'Notion AI 建库事务被拒绝，未核验到新数据库，请检查权限后重新预览。';
    step.state = 'applied:error'; step.done = true; step.error = { type: 'notionSwitchBuild', message: item.error }; delete step.threadOperations;
    t.status = 'failed'; this.changed(t); this.save(); fail(item.error.replace(/^Notion AI 建库/, ''), item.status === 'uncertain' ? 409 : 400);
  }
  async transactions(input, signal, meta = {}) {
    let inspected;
    try { inspected = this.inspectTransactions(input, meta); if (!inspected) return null; }
    catch (error) { return json({ name: 'NotionSwitchDatabaseBuild', message: message(error) }, error.status || 400); }
    const { t } = inspected;
    return this.enqueue(t.id, async () => {
      const controller = new AbortController(), active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, turn = { controller };
      this.running.set(t.id, turn);
      try {
        const current = this.inspectTransactions(input, meta); if (!current) fail('建库确认范围已变化。');
        t.steps = current.steps; t.visibleIds = current.visibleIds; t.title = current.threadTitle; t.alive = current.alive;
        this.changed(t); this.save(); const actual = { __version__: 3 };
        for (const decision of current.decisions) {
          const result = await this.decide(t, decision, active, meta);
          for (const [table, records] of Object.entries(result || {})) if (table !== '__version__') Object.assign(actual[table] ||= {}, records);
        }
        const recordMap = this.recordMap(t); for (const [table, records] of Object.entries(actual)) if (table !== '__version__') Object.assign(recordMap[table] ||= {}, records);
        return json({ recordMap });
      } catch (error) { return json({ name: 'NotionSwitchDatabaseBuild', message: message(error), recordMap: this.recordMap(t) }, error.status || (active.aborted ? 499 : 400)); }
      finally { if (this.running.get(t.id) === turn) this.running.delete(t.id); }
    });
  }
  async stop(input, meta = {}) {
    const t = this.threads.get(uuid(input?.threadId)); if (!this.scope(t, { userId: meta.userId, spaceId: input.spaceId })) return json({ message: 'Notion AI 建库线程不存在或账号不匹配。' }, 404);
    this.running.get(t.id)?.controller.abort(); return json({ stopped: true });
  }
  async whenIdle() { while (this.tasks.size) await Promise.allSettled([...this.tasks]); }
  close() { for (const turn of this.running.values()) turn.controller.abort(); }
}
function createNativeBuildService(options) {
  try { return new NativeBuildService(options); }
  catch {
    options.log?.({ type: 'native-build-storage-unavailable' });
    const unavailable = () => json({ name: 'NotionSwitchDatabaseBuild', message: 'Notion AI 建库本地确认记录无法读取，已保留原文件并停止创建；请先检查本机记录。' }, 503);
    return { available: false, active: 0, threads: new Map(), accepts: isDatabaseBuild, owns: () => false, record() {}, recordRole() {}, previewQuery: () => null, historyRecord() {}, historyThreads: () => new Map(),
      stream: async () => unavailable(), stop: async () => unavailable(), transactions: async input => JSON.stringify(input).includes('notionSwitchBuild') ? unavailable() : null,
      close() {}, whenIdle: async () => {} };
  }
}
module.exports = { NativeBuildService, createNativeBuildService };
