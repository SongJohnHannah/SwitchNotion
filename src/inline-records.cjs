const fs = require('node:fs');
const { threadContext } = require('./native-selection.cjs');
const uuid = value => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));

// Only the native writer's thread records live here. No page records, account
// profile, rendered page snapshots, Cookies or provider credentials are stored.
class InlineRecords {
  constructor(file) {
    this.file = file; this.threads = new Map(); this.messages = new Map();
    if (file && fs.existsSync(file)) {
      if (fs.statSync(file).size > 10 * 1024 * 1024) throw Error('Local inline conversation store exceeds prototype limit');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const record of saved.threads || []) this.threads.set(record.id, record);
      for (const record of saved.messages || []) this.messages.set(record.id, record);
    }
  }
  record(id, table = 'thread') { return (table === 'thread' ? this.threads : table === 'thread_message' ? this.messages : new Map()).get(id); }
  snapshot(input, generated, status, userId) {
    if (!uuid(input.threadId) || !uuid(input.spaceId)) throw Error('Notion 浮动 AI 线程标识无效，请重新选择文字后发送。');
    const now = Date.now(), prior = this.threads.get(input.threadId);
    if (prior && prior.space_id !== input.spaceId) throw Error('Notion 浮动 AI 工作区不匹配。');
    const steps = [];
    let pageId;
    for (const original of input.transcript) {
      if (!uuid(original.id)) continue;
      let step;
      if (original.type === 'config') step = { ...pick(original, ['id', 'type']), value: pick(original.value, ['type', 'writerMode', 'locale', 'model', 'modelFromUser', 'enableMarkdownVNext']) };
      else if (original.type === 'context') {
        pageId = original.value?.peekBlockId || original.value?.blockId;
        step = { ...pick(original, ['id', 'type']), value: pick(original.value, ['blockId', 'peekBlockId', 'spaceId', 'surface']) };
      } else if (original.type === 'user-specified-context') {
        const selection = original.value?.textSelection || original.value?.blockSelection;
        const context = selection && threadContext({ threadContext: { selection, selectionPageId: pageId } }, input.spaceId);
        step = { ...pick(original, ['id', 'type']), value: { pointers: [], ...(context ? { [selection.type === 'text' ? 'textSelection' : 'blockSelection']: context.selection } : {}) } };
      } else if (['user', 'user-injected', 'agent-prebuilt-prompt', 'agent-inference'].includes(original.type)) step = pick(original, ['id', 'type', 'value', 'actualMessage', 'displayMessage', 'userId', 'createdAt', 'promptType', 'locale', 'traceId', 'startedAt', 'finishedAt']);
      if (step) steps.push(step);
    }
    if (generated) steps.push(generated);
    const ids = [...new Set([...(prior?.messages || []), ...steps.map(step => step.id)])];
    const record = { ...prior, id: input.threadId, version: (prior?.version || 0) + 1, space_id: input.spaceId, alive: true, type: 'workflow', messages: ids, parent_id: input.spaceId, parent_table: 'space', created_time: prior?.created_time || now, updated_time: now, latest_user_or_trigger_time: now, has_transcript_content: true, created_source: 'writer', data: prior?.data || { title: 'DeepSeek 选区编辑' }, ...(uuid(userId) ? { created_by_id: userId, created_by_table: 'notion_user', permissions: [{ type: 'user_permission', role: 'editor', user_id: userId }] } : {}) };
    if (status !== 'running' && generated) record.last_turn_outcome = { inference_id: generated.traceId, status: status === 'completed' ? 'success' : 'failure', completed_time: now, step_count: 1, final_step_id: generated.id };
    this.threads.set(record.id, record);
    const recordMap = { __version__: 3, thread: {}, thread_message: {} };
    const put = (table, value) => { recordMap[table][value.id] = { spaceId: input.spaceId, value: { role: 'editor', value } }; };
    put('thread', record);
    for (const step of steps) {
      const old = this.messages.get(step.id);
      if (old && old.parent_id !== input.threadId) throw Error('Notion 浮动 AI 消息所属线程不匹配。');
      const message = { id: step.id, version: (old?.version || 0) + 1, space_id: input.spaceId, parent_id: input.threadId, parent_table: 'thread', created_time: old?.created_time || now, ...(uuid(userId) ? { created_by_id: userId, created_by_table: 'notion_user' } : {}), step };
      this.messages.set(message.id, message); put('thread_message', message);
    }
    if (this.file) {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ threads: [...this.threads.values()], messages: [...this.messages.values()] }));
      fs.renameSync(this.file + '.tmp', this.file);
    }
    return { type: 'record-map', recordMap };
  }
}
module.exports = { InlineRecords };
