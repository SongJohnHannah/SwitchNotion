const fs = require('node:fs');
const { threadContext } = require('./native-selection.cjs');
const { referencePointers } = require('./inline-references.cjs');
const { mayUseRecord } = require('./local-ai-scope.cjs');
const { uuid: normalizedId } = require('./native-context.cjs');
const uuid = value => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));

// Native writer and researcher thread records live here. No page records, account
// profile, rendered page snapshots, Cookies or provider credentials are stored.
class InlineRecords {
  constructor(file) {
    this.file = file; this.threads = new Map(); this.messages = new Map();
    if (file && fs.existsSync(file)) {
      if (fs.statSync(file).size > 10 * 1024 * 1024) throw Error('Local inline conversation store exceeds prototype limit');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [records, target] of [[saved.threads || [], this.threads], [saved.messages || [], this.messages]]) for (const record of records) {
        const key = normalizedId(record.id);
        if (!key || target.has(key)) throw Error('Notion 浮动 AI 本地记录标识无效或重复，请保留记录并检查。');
        target.set(key, record);
      }
      let recovered = false;
      for (const record of this.threads.values()) if (record.created_source === 'researcher' && record.data?.notion_switch_research?.status === 'running') {
        record.data.notion_switch_research.status = 'interrupted'; delete record.active_inference_lease;
        delete record.current_inference_id; record.current_inference_lease_expiration = 0;
        record.version++; recovered = true;
      }
      if (recovered) this.save();
    }
  }
  record(id, table = 'thread', scope) {
    const record = (table === 'thread' ? this.threads : table === 'thread_message' ? this.messages : new Map()).get(normalizedId(id));
    const owner = table === 'thread_message' ? this.threads.get(normalizedId(record?.parent_id)) : record;
    return mayUseRecord(owner, scope) ? record : undefined;
  }
  hasRecord(id, table = 'thread') { return !!this.record(id, table); }
  validate(input, generated, userId) {
    if (!uuid(input.threadId) || !uuid(input.spaceId)) throw Error('Notion 浮动 AI 线程标识无效，请重新选择文字后发送。');
    if (generated && !uuid(generated.id)) throw Error('Notion 浮动 AI 生成消息标识无效。');
    const prior = this.threads.get(normalizedId(input.threadId));
    if (prior && normalizedId(prior.space_id) !== normalizedId(input.spaceId)) throw Error('Notion 浮动 AI 工作区不匹配。');
    if (userId !== undefined && !mayUseRecord(prior || { created_by_id: userId, space_id: input.spaceId }, { userId, spaceId: input.spaceId }))
      throw Error('Notion 浮动 AI 账号或旧记录归属不匹配，请从当前账号新建对话。');
    for (const step of [...(input.transcript || []), ...(generated ? [generated] : [])]) {
      const old = this.messages.get(normalizedId(step?.id));
      if (old && (normalizedId(old.parent_id) !== normalizedId(input.threadId) || normalizedId(old.space_id) !== normalizedId(input.spaceId))) throw Error('Notion 浮动 AI 消息所属线程不匹配。');
      if (userId !== undefined && ['user', 'user-injected'].includes(step?.type) && step.userId !== undefined && normalizedId(step.userId) !== normalizedId(userId))
        throw Error('Notion 浮动 AI 消息账号不匹配。');
    }
  }
  snapshot(input, generated, status, userId, { source = 'writer', research, attachmentSteps = [] } = {}) {
    if (!['writer', 'researcher'].includes(source)) throw Error('Notion 本地 AI 来源类型无效。');
    this.validate(input, generated, userId);
    input = { ...input, threadId: normalizedId(input.threadId), spaceId: normalizedId(input.spaceId) };
    if (userId !== undefined) userId = normalizedId(userId);
    const now = Date.now(), prior = this.threads.get(input.threadId);
    if (prior && prior.created_source !== source) throw Error('Notion 本地 AI 线程类型不匹配。');
    const steps = [];
    let pageId;
    for (const original of input.transcript) {
      if (!uuid(original.id)) continue;
      let step;
      if (original.type === 'config') step = { ...pick(original, ['id', 'type']), value: pick(original.value, source === 'researcher' ? ['type', 'isAgentResearchRequest', 'useWebSearch', 'searchScope', 'searchScopes', 'model', 'modelFromUser'] : ['type', 'writerMode', 'locale', 'model', 'modelFromUser', 'enableMarkdownVNext']) };
      else if (original.type === 'context') {
        pageId = original.value?.peekBlockId || original.value?.blockId;
        step = { ...pick(original, ['id', 'type']), value: pick(original.value, ['blockId', 'peekBlockId', 'spaceId', 'surface']) };
      } else if (original.type === 'user-specified-context') {
        const selection = original.value?.textSelection || original.value?.blockSelection;
        const context = selection && threadContext({ threadContext: { selection, selectionPageId: pageId } }, input.spaceId);
        step = { ...pick(original, ['id', 'type']), value: { pointers: referencePointers(original.value?.pointers, input.spaceId), ...(context ? { [selection.type === 'text' ? 'textSelection' : 'blockSelection']: context.selection } : {}) } };
      } else if (source === 'writer' && ['attachment', 'computer-file'].includes(original.type)) {
        // Only the resolver's verified local references may reach persistence.
        const verified = attachmentSteps.find(value => normalizedId(value.id) === normalizedId(original.id));
        if (verified) step = pick(verified, ['id', 'type', 'fileUrl', 'fileName', 'contentType', 'metadata']);
      } else if (['user', 'user-injected', 'agent-prebuilt-prompt', 'agent-inference'].includes(original.type)) step = pick(original, ['id', 'type', 'value', 'actualMessage', 'displayMessage', 'userId', 'createdAt', 'promptType', 'locale', 'traceId', 'startedAt', 'finishedAt']);
      if (step) steps.push({ ...step, id: normalizedId(step.id) });
    }
    if (generated) steps.push({ ...generated, id: normalizedId(generated.id) });
    const ids = [...new Set([...(source === 'researcher' ? [] : prior?.messages || []).map(value => normalizedId(value) || value), ...steps.map(step => step.id)])];
    const record = { ...prior, id: input.threadId, version: (prior?.version || 0) + 1, space_id: input.spaceId, alive: true, type: 'workflow', messages: ids, parent_id: input.spaceId, parent_table: 'space', created_time: prior?.created_time || now, updated_time: now, latest_user_or_trigger_time: now, has_transcript_content: true, created_source: source, data: { ...prior?.data, title: prior?.data?.title || (source === 'researcher' ? 'DeepSeek 研究报告' : 'DeepSeek 选区编辑') }, ...(uuid(userId) ? { created_by_id: userId, created_by_table: 'notion_user', permissions: [{ type: 'user_permission', role: 'editor', user_id: userId }] } : {}) };
    if (source === 'researcher') {
      record.data.notion_switch_research = { ...prior?.data?.notion_switch_research, ...research, status };
      delete record.active_inference_lease;
      if (status === 'running') { record.current_inference_id = generated?.traceId || input.traceId; record.current_inference_lease_expiration = now + 300000; }
      else { delete record.current_inference_id; record.current_inference_lease_expiration = 0; }
    }
    if (status !== 'running' && generated) record.last_turn_outcome = { inference_id: generated.traceId, status: status === 'completed' ? 'success' : 'failure', completed_time: now, step_count: 1, final_step_id: normalizedId(generated.id) };
    this.threads.set(record.id, record);
    const recordMap = { __version__: 3, thread: {}, thread_message: {} };
    const put = (table, value) => { recordMap[table][value.id] = { spaceId: input.spaceId, value: { role: 'editor', value } }; };
    put('thread', record);
    for (const step of steps) {
      const old = this.messages.get(step.id);
      // All message ownership was checked before any map mutation. Legacy UUID
      // spelling differences must not fail after publishing the thread record.
      const message = { id: step.id, version: (old?.version || 0) + 1, space_id: input.spaceId, parent_id: input.threadId, parent_table: 'thread', created_time: old?.created_time || now, ...(uuid(userId) ? { created_by_id: userId, created_by_table: 'notion_user' } : {}), step };
      this.messages.set(message.id, message); put('thread_message', message);
    }
    this.save();
    return { type: 'record-map', recordMap };
  }
  researchThreads() { return new Map([...this.threads].filter(([, record]) => record.created_source === 'researcher').map(([id, thread]) => [id, { thread }])); }
  save() {
    if (!this.file) return;
    const data = JSON.stringify({ threads: [...this.threads.values()], messages: [...this.messages.values()] });
    if (Buffer.byteLength(data) > 10 * 1024 * 1024) throw Error('Notion 本地 AI 对话存储已达上限，请保留记录后清理。');
    fs.writeFileSync(this.file + '.tmp', data, { mode: 0o600, flush: true });
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(this.file + '.tmp', this.file); break; }
      catch (error) { if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1)); }
    }
  }
}
module.exports = { InlineRecords };
