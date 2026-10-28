const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { renderChatShare } = require('./chat-share.cjs');
const fail = text => { throw Error('Notion 对话与记忆同步' + text); };
const plain = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => typeof part?.[0] === 'string' ? part[0] : '').join('') : '';
class AiTransfer {
  constructor({ memory, agent, native, chooseSave, chooseOpen, approve }) { Object.assign(this, { memory, agent, native, chooseSave, chooseOpen, approve }); }
  threads(key) {
    const scope = this.memory.state(key);
    const rows = [...this.agent.threads.values()].map(item => ({ thread: item.thread, running: item.session?.status === 'running' }));
    for (const thread of this.native?.inline.threads.values() || []) rows.push({ thread, running: this.native.threads.get(thread.id)?.turns.at(-1)?.status === 'running' });
    return rows.filter(item => uuid(item.thread.created_by_id) === scope.userId && uuid(item.thread.space_id) === scope.spaceId && item.thread.alive !== false).map(item => ({ id: item.thread.id, title: plain(item.thread.data.title).slice(0, 200) || 'AI 对话', running: item.running }));
  }
  snapshot(key, id, { includeSources = true } = {}) {
    if (!this.threads(key).some(item => item.id === id)) fail('对话不属于当前工作区。');
    const scope = this.memory.state(key), owns = thread => thread && uuid(thread.created_by_id) === scope.userId && uuid(thread.space_id) === scope.spaceId && thread.alive !== false;
    const candidate = this.agent.threads.get(id), nativeCandidate = this.native?.inline.record(id);
    const item = owns(candidate?.thread) ? candidate : undefined, inline = owns(nativeCandidate) ? nativeCandidate : undefined;
    if (!item && !inline) fail('对话不属于当前工作区。');
    if (this.threads(key).find(item => item.id === id).running) fail('请等待当前对话停止生成后再导出。');
    const messages = [];
    if (item) for (const entity of [...item.entities.values()].sort((a, b) => a.sequence - b.sequence)) {
      if (entity.kind === 'user_message') { const visible = plain(entity.text), text = entity.user_prompt_text ?? visible, sourceData = entity.notion_switch_imported_source || (text !== visible ? visible : ''); messages.push({ role: 'user', text, ...(includeSources && sourceData ? { sourceData } : {}) }); }
      else if (entity.kind === 'assistant_message') messages.push({ role: 'assistant', text: (entity.content || []).filter(part => part.type === 'text').map(part => part.text).join('') });
    }
    else {
      let sourceData = '';
      for (const id of inline.messages) {
        const step = this.native.inline.record(id, 'thread_message')?.step;
        if (step?.type === 'user-specified-context') sourceData += JSON.stringify(step.value);
        else if (['attachment', 'computer-file'].includes(step?.type)) sourceData += '\n附件：' + String(step.fileName || '未命名附件') + '（原件需重新上传）';
        else if (step?.type === 'user-injected') sourceData += '\n历史自动上下文资料：' + plain(step.actualMessage ?? step.value);
        else if (step?.type === 'user') { messages.push({ role: 'user', text: plain(step.actualMessage ?? step.value), ...(includeSources && sourceData ? { sourceData } : {}) }); sourceData = ''; }
        else if (step?.type === 'agent-inference') {
          if (includeSources && sourceData) { const user = messages.findLast(message => message.role === 'user'); if (user) user.sourceData = (user.sourceData || '') + sourceData; sourceData = ''; }
          messages.push({ role: 'assistant', text: typeof step.value === 'string' ? step.value : (step.value || []).filter(part => part.type === 'text').map(part => part.content).join('') });
        }
      }
    }
    if (!messages.length || messages.length > 500 || JSON.stringify(messages).length > 500000) fail('对话为空或超过导出上限。');
    return { version: 1, kind: 'notion-switch-chat', workspaceId: scope.spaceId, userId: scope.userId, title: plain(item?.thread.data.title || inline?.data.title).slice(0, 200) || 'AI 对话', messages, notice: '包含文字和所选引用资料；不导出配置中的 API Key、Cookie、原始附件、工具授权或待执行操作。聊天中自行输入的内容会随文字导出。' };
  }
  importChat(key, data) {
    const scope = this.memory.state(key);
    if (!Array.isArray(data.messages) || !data.messages.length || data.messages.length > 500 || data.messages[0].role !== 'user' || data.messages.some(item => !['user', 'assistant'].includes(item.role) || typeof item.text !== 'string' || item.text.length > 120000 || item.sourceData !== undefined && (item.role !== 'user' || typeof item.sourceData !== 'string' || item.sourceData.length > 200000)) || JSON.stringify(data.messages).length > 500000 || typeof data.title !== 'string' || data.title.length > 200) fail('对话格式或大小无效。');
    const id = randomUUID(), sessionId = randomUUID(), now = Date.now(), thread = { id, version: 1, space_id: scope.spaceId, alive: true, type: 'workflow', messages: [], parent_id: scope.spaceId, parent_table: 'space', created_time: now, updated_time: now, latest_user_or_trigger_time: now, has_transcript_content: true, session_id: sessionId, created_by_id: scope.userId, created_by_table: 'notion_user', updated_by_id: scope.userId, updated_by_table: 'notion_user', data: { title: data.title, type: 'personal_agent', agent_provider: { providerId: 'agent_service', sessionId } }, permissions: [{ type: 'user_permission', role: 'editor', user_id: scope.userId }] };
    const item = { thread, sessionId, turns: [], sequence: 0, frames: [], entities: new Map(), session: null, stop: null, eventIds: new Set(), attachments: {}, attachmentScopes: {}, modelSelection: { type: 'automatic' } };
    for (const message of data.messages) {
      const turnId = randomUUID(), entity = this.agent.entity(item, message.role === 'user' ? 'user_message' : 'assistant_message', message.role === 'user' ? { text: [[message.text]], files: [], is_current_user: true, render_on_user_side: true, user_message_kind: 'direct', client_message_id: randomUUID(), sender_actor_kind: 'user', sender_actor_id: scope.userId } : { turn_id: turnId, content: [{ type: 'text', text: message.text }] });
      item.entities.set(entity.id, entity);
      if (message.role === 'user' && message.sourceData) entity.notion_switch_imported_source = message.sourceData;
      if (message.role === 'assistant') { item.turns.push({ number: item.turns.length + 1, status: 'completed', turnId, nativeContext: { workspace_id: scope.spaceId } }); const complete = this.agent.entity(item, 'turn_completed', { turn_id: turnId, stop_reason: 'end_turn' }); item.entities.set(complete.id, complete); }
    }
    item.session = this.agent.session(item, 'idle'); this.agent.syncModel(item); this.agent.threads.set(id, item);
    try { this.agent.save(); } catch (error) { this.agent.threads.delete(id); throw error; }
    return { id, message: '已导入文字对话，重新打开 Notion AI 历史列表后可继续提问；原始附件需重新上传。' };
  }
  importMemory(key, data) {
    const current = this.memory.state(key), value = data.memory;
    if (!value || typeof value.enabled !== 'boolean' || typeof value.instructions !== 'string' || value.instructions.length > 16000 || !Array.isArray(value.memories) || value.memories.length > 100 || value.memories.some(item => typeof item.content !== 'string' || !item.content.trim() || item.content.length > 4000) || value.memories.reduce((n, item) => n + item.content.length, 0) > 40000 || !Array.isArray(value.skills) || value.skills.length > 30 || value.skills.some(item => typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80 || typeof item.description !== 'string' || item.description.length > 500 || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 12000 || typeof item.enabled !== 'boolean' || typeof item.automatic !== 'boolean')) fail('记忆或技能格式无效。');
    if (new Set(value.skills.map(item => item.name)).size !== value.skills.length) fail('技能名称重复。');
    return this.memory.change(key, current.revision, row => {
      row.enabled = value.enabled; row.instructions = value.instructions;
      row.memories = value.memories.map(item => ({ id: randomUUID(), content: item.content, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
      row.skills = value.skills.map(item => ({ id: randomUUID(), name: item.name, description: item.description, content: item.content, enabled: item.enabled, automatic: item.automatic }));
    });
  }
  async request(action, input) {
    try {
      if (!['transfer.list', 'transfer.chat.export', 'transfer.chat.share', 'transfer.chat.import', 'transfer.memory.export', 'transfer.memory.import'].includes(action) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !(action === 'transfer.chat.share' ? ['key', 'id', 'password', 'includeSources'] : ['key', 'id']).includes(key))) fail('操作参数无效。');
      const scope = this.memory.state(input.key);
      if (action === 'transfer.list') return { ok: true, result: { threads: this.threads(input.key) } };
      if (action === 'transfer.chat.share') {
        if (input.includeSources !== undefined && typeof input.includeSources !== 'boolean') fail('引用资料开关无效。');
        const data = this.snapshot(input.key, input.id, { includeSources: input.includeSources === true }), document = await renderChatShare(data, { password: input.password, includeSources: input.includeSources });
        const file = await this.chooseSave('Notion-AI-只读对话.html', { format: 'html' });
        if (!file) return { ok: true, result: { message: '已取消共享导出。' } };
        if (!this.threads(input.key).some(thread => thread.id === input.id)) fail('对话已移除，未写入共享文件。');
        if (!/\.html$/i.test(file)) fail('请选择普通的 .html 文件。');
        try { const target = fs.lstatSync(file); if (!target.isFile() || target.isSymbolicLink()) fail('请选择普通的 .html 文件。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        fs.writeFileSync(file, document, { mode: 0o600, flush: true });
        return { ok: true, result: { message: input.password ? '已保存加密的只读 HTML；查看者需要文件和密码。密码未保存在配置中。' : '已保存只读 HTML；拥有文件的人都能查看。文件发出后无法远程撤回。' } };
      }
      if (action.endsWith('.export')) {
        const data = action === 'transfer.chat.export' ? this.snapshot(input.key, input.id) : { version: 1, kind: 'notion-switch-memory', userId: scope.userId, workspaceId: scope.spaceId, memory: { enabled: scope.enabled, instructions: scope.instructions, memories: scope.memories, skills: scope.skills } };
        const file = await this.chooseSave(action === 'transfer.chat.export' ? 'Notion-AI-对话.json' : 'Notion-AI-工作区记忆.json');
        if (!file) return { ok: true, result: { message: '已取消导出。' } };
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flush: true });
        return { ok: true, result: { message: '已导出。可在另一台电脑的同一账号、同一工作区导入。' } };
      }
      const file = await this.chooseOpen(); if (!file) return { ok: true, result: { message: '已取消导入。' } };
      const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail('文件无效或超过 2 MB。');
      let data; try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('文件不是有效 JSON。'); }
      if (data.version !== 1 || uuid(data.userId) !== scope.userId || uuid(data.workspaceId) !== scope.spaceId || data.kind !== (action === 'transfer.chat.import' ? 'notion-switch-chat' : 'notion-switch-memory')) fail('文件不属于当前账号、工作区或选定类型。');
      if (action === 'transfer.memory.import' && !await this.approve({ title: '导入工作区记忆', message: '替换这个工作区现有的记忆、指令和技能？', detail: '导入文件只用于当前工作区。建议先导出现有记忆留作备份。' })) return { ok: true, result: { message: '已取消导入。' } };
      if (action === 'transfer.chat.import') return { ok: true, result: this.importChat(input.key, data) };
      this.importMemory(input.key, data); return { ok: true, result: { message: '已导入当前工作区记忆，下一轮 AI 对话生效。' } };
    } catch (error) { return { ok: false, error: /^Notion (?:对话与记忆同步|对话共享|工作区记忆)/.test(error.message) ? error.message : '导入、导出或共享未完成，请检查文件。' }; }
  }
}
module.exports = { AiTransfer };
