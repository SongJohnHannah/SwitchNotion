const { randomUUID } = require('node:crypto');
const { AgentMock } = require('./agent-mock.cjs');
const { LocalHistory } = require('./local-history.cjs');
const { isWriter, streamInline } = require('./native-inline.cjs');
const { isFormula, streamFormula } = require('./native-formula.cjs');
const { InlineRecords } = require('./inline-records.cjs');
const path = require('node:path');
const { mayUseRecord, requestScope } = require('./local-ai-scope.cjs');
const { uuid } = require('./native-context.cjs');
const { isResearch } = require('./native-research.cjs');
const { preparePublicResearch, streamPublicResearch } = require('./native-web-research.cjs');
const { researchTransactions } = require('./research-transactions.cjs');

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const blocked = endpoint => json({ name: 'NotionSwitchPrototype', message: `NotionSwitch mock adapter is not ready for ${endpoint}; the request was not forwarded.`, errorId: randomUUID() }, 501);

class NativeMock {
  constructor({ log = () => {}, delayMs = 140, stateFile, provider, workspace, inlineReferences, webSources, memory, extensions, workspaceResearch = false } = {}) { this.log = log; this.delayMs = delayMs; this.provider = provider; this.inlineReferences = inlineReferences; this.webSources = webSources; this.workspaceResearch = workspaceResearch; this.requests = []; this.threads = new Map(); this.formulaTurns = new Set(); this.formulaFailures = 0; this.researchFailures = 0; this.completed = 0; this.stopped = 0; this.agent = new AgentMock({ log, delayMs, stateFile, provider, workspace, webSources, memory, extensions }); this.history = new LocalHistory({ log }); this.inline = new InlineRecords(stateFile && path.join(path.dirname(stateFile), 'inline-conversations.local.json')); }
  record(id, table = 'thread', scope) { return (table === 'thread' && this.agent.record(id, table, scope)) || this.inline.record(id, table, scope); }
  get workspace() { return this.agent.workspace; }
  hasRecord(id, table = 'thread') { return !!this.record(id, table); }
  owns(input) { return this.agent.owns(input); }
  reserveInlineUpload({ threadId, spaceId, userId }) {
    const input = { threadId: uuid(threadId), spaceId: uuid(spaceId), transcript: [] };
    if (!input.threadId || !input.spaceId || !uuid(userId) || this.agent.record(input.threadId)) throw Error('Notion 浮动附件需要当前账号的新建或已有本地浮动对话。');
    this.inline.validate(input, null, userId);
    const existing = this.inline.record(input.threadId);
    if (existing && (existing.created_source !== 'writer' || existing.alive === false)) throw Error('Notion 浮动附件不能使用其他类型或已归档的对话。');
    const active = this.threads.get(input.threadId);
    if (active && !mayUseRecord(active.scopeRecord, { userId, spaceId: input.spaceId })) throw Error('Notion 浮动附件对话归属不匹配。');
    if (!existing) this.inline.snapshot(input, null, 'draft', userId);
  }
  historyThreads() { return new Map([...this.agent.threads, ...this.inline.researchThreads()]); }
  historyRecord(id) { return this.agent.record(id) || (this.inline.record(id)?.created_source === 'researcher' ? this.inline.record(id) : undefined); }
  transactions(input, meta) { return researchTransactions(this.inline, input, meta, id => this.threads.get(id)?.stop?.('input-edited'), { allowNotion: this.workspaceResearch && !!this.workspace?.open }); }
  async handle(endpoint, input, signal, meta) {
    this.requests.push({ endpoint, keys: Object.keys(input || {}).sort(), at: new Date().toISOString() });
    this.log({ type: 'ai-intercepted', endpoint, keys: Object.keys(input || {}).sort() });
    if (endpoint === 'getInferenceTranscriptsForUser') return this.history.list({ input, agent: meta?.historyAgent || { threads: this.historyThreads(), record: id => this.historyRecord(id) }, userId: meta?.userId, fetchRemote: meta?.fetchHistory || meta?.passthrough || (async () => json({ threadIds: [], nextCursor: null })) });
    if (endpoint === 'createAgentThread' || endpoint === 'createCalendarAgentThread') {
      if (this.inline.hasRecord(input.threadId) || this.threads.get(uuid(input.threadId) || input.threadId)?.scopeRecord)
        return json({ message: 'Notion 对话标识已属于浮动 AI 入口，请新建侧栏对话。' }, 409);
      return this.agent.create(endpoint === 'createCalendarAgentThread' ? { ...input, type: 'calendar_agent' } : input, meta);
    }
    if (endpoint === 'sendEventToAgentThread') return this.agent.send(input, meta);
    if (endpoint === 'getThreadTranscript') return this.agent.transcript(input, meta);
    if (endpoint === 'getThreadQueuedMessages') {
      const t = this.agent.find(input);
      if (!t) return json({ message: 'Notion 本地对话不存在。' }, 404);
      return mayUseRecord(t.thread, requestScope(input, meta)) ? json({ messages: [] }) : json({ message: 'Notion 本地对话不属于当前账号或工作区。' }, 403);
    }
    if (endpoint === 'listenToThreadTranscript' && this.agent.owns(input)) return this.agent.listen(input, signal, meta);
    if (endpoint === 'runInferenceTranscript') {
      if (this.provider?.status().mode !== 'deepseek') return this.legacy(input, signal);
      if (isResearch(input) || this.inline.record(input.threadId)?.created_source === 'researcher') {
        input = { ...input, threadId: uuid(input.threadId) || input.threadId, spaceId: uuid(input.spaceId) || input.spaceId };
        const userId = uuid(meta?.userId), scope = { userId, spaceId: input.spaceId };
        let normalized;
        try {
          if (!userId) throw Error('Notion 网页研究缺少当前登录账号。');
          this.inline.validate(input, null, userId);
          if (this.agent.record(input.threadId) || this.inline.record(input.threadId)?.created_source === 'writer') return json({ message: 'Notion 对话标识已属于其他本地 AI 入口。' }, 409);
          if (this.inline.record(input.threadId)?.alive === false) return json({ message: 'Notion 研究对话已归档，请恢复或新建对话。' }, 409);
          const running = this.threads.get(input.threadId);
          if (running && !mayUseRecord(running.scopeRecord, scope)) return json({ message: 'Notion 网页研究不属于当前账号或工作区。' }, 403);
          normalized = preparePublicResearch(input, this.inline, userId, { allowNotion: this.workspaceResearch && !!this.workspace?.open });
        } catch (error) { return json({ message: error.message }, 403); }
        if (!normalized) { this.threads.get(input.threadId)?.stop?.('source-changed'); return blocked(endpoint); }
        let thread = this.threads.get(input.threadId);
        thread?.stop?.('superseded');
        try { normalized = preparePublicResearch(input, this.inline, userId, { allowNotion: this.workspaceResearch && !!this.workspace?.open }); }
        catch (error) { return json({ message: error.message }, 400); }
        if (!thread) { thread = { kind: 'web-research', turns: [], stop: null, scopeRecord: { created_by_id: userId, space_id: input.spaceId } }; this.threads.set(input.threadId, thread); }
        return streamPublicResearch({ normalized, signal, provider: this.provider, workspace: this.workspace, webSources: this.webSources, pageFiles: this.agent.extensions?.pageFiles, records: this.inline, userId, thread, log: this.log,
          onFinish: status => { if (status === 'completed') this.completed++; else if (status === 'failed') this.researchFailures++; else this.stopped++; } });
      }
      if (isFormula(input)) {
        const turn = {}; this.formulaTurns.add(turn);
        return streamFormula({ input, signal, provider: this.provider, log: this.log, onFinish: status => {
          this.formulaTurns.delete(turn);
          if (status === 'completed') this.completed++; else if (status === 'stopped') this.stopped++; else this.formulaFailures++;
        } });
      }
      if (!isWriter(input)) return blocked(endpoint);
      input = { ...input, threadId: uuid(input.threadId) || input.threadId, spaceId: uuid(input.spaceId) || input.spaceId };
      const userId = meta === undefined ? undefined : meta?.userId ?? null;
      try { this.inline.validate(input, null, userId); }
      catch (error) { return json({ message: error.message }, 403); }
      if (this.agent.record(input.threadId)) return json({ message: 'Notion 对话标识已属于另一种本地 AI 入口，请新建浮动对话。' }, 409);
      const id = input.threadId || randomUUID();
      let thread = this.threads.get(id);
      if (thread && !mayUseRecord(thread.scopeRecord, requestScope(input, meta)))
        return json({ message: 'Notion 浮动 AI 生成不属于当前账号或工作区。' }, 403);
      if (!thread) { thread = { turns: [], stop: null, scopeRecord: { created_by_id: userId, space_id: input.spaceId } }; this.threads.set(id, thread); }
      return streamInline({ input, signal, provider: this.provider, thread, resolveReferences: this.inlineReferences, resolveAttachment: meta?.inlineAttachment, log: this.log,
        onSnapshot: (step, status, details) => this.inline.snapshot(input, step, status, userId, details), onFinish: reason => { if (reason === 'completed') this.completed++; else if (reason !== 'failed') this.stopped++; } });
    }
    if (endpoint === 'stopWorkflowAutomationRunThread') {
      const id = uuid(input.threadId) || input.threadId;
      if (this.hasRecord(id) && !this.record(id, 'thread', requestScope(input, meta)) ||
          this.threads.get(id)?.scopeRecord && !mayUseRecord(this.threads.get(id).scopeRecord, requestScope(input, meta)))
        return json({ message: 'Notion 浮动 AI 对话不属于当前账号或工作区。' }, 403);
      const thread = this.threads.get(id);
      thread?.stop?.('stop-api');
      this.agent.find(input)?.stop?.('native-stop-api');
      return json({});
    }
    return blocked(endpoint);
  }
  legacy(input, signal) {
    this.log({ type: 'legacy-shape', steps: (input.transcript || []).map(s => ({ type: s.type, keys: Object.keys(s), valueType: Array.isArray(s.value) ? 'array' : typeof s.value })), patchVersion: input.patchResponseVersion });
    const threadId = input.threadId || randomUUID();
    let thread = this.threads.get(threadId);
    if (!thread) { thread = { turns: [], stop: null }; this.threads.set(threadId, thread); }
    thread.stop?.('superseded');
    const number = thread.turns.length + 1;
    const step = { id: randomUUID(), type: 'agent-inference', value: [{ type: 'text', content: '' }] };
    const turn = { number, step, status: 'running' };
    thread.turns.push(turn);
    const text = `NotionSwitch 本地模拟回复 · 第 ${number} 轮\n\n原生 AI 请求已由本机原型接管。${number > 1 ? `已保留前 ${number - 1} 轮上下文，其中上一轮状态为 ${thread.turns[number - 2].status}。` : '这是第一轮模拟对话。'}\n\n此回复逐段输出，用于验证停止与续聊。本轮没有调用 Notion 推理服务或 DeepSeek。\n\n${'流式验证正在进行，可以点击原生停止按钮。'.repeat(5)}\n\n[NS-MOCK-DONE-${number}]`;
    let offset = 0, timer, controller, ended = false;
    const encoder = new TextEncoder();
    const send = event => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
    const finish = (reason, close = true) => {
      if (ended) return;
      ended = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      turn.status = reason === 'completed' ? 'completed' : 'stopped';
      if (reason === 'completed') this.completed++; else this.stopped++;
      if (thread.stop === finish) thread.stop = null;
      this.log({ type: 'mock-turn-ended', protocol: 'legacy', number, status: turn.status, reason });
      if (close) { try { controller.close(); } catch {} }
    };
    const abort = () => finish('request-aborted');
    thread.stop = finish;
    const tick = () => {
      if (ended) return;
      offset = Math.min(text.length, offset + 4);
      step.value[0].content = text.slice(0, offset);
      send({ type: offset <= 4 ? 'patch-start' : 'patch-sync', data: { s: [step] } });
      if (offset === text.length) finish('completed'); else timer = setTimeout(tick, this.delayMs);
    };
    const stream = new ReadableStream({
      start(c) { controller = c; },
      cancel: () => finish('reader-cancelled', false),
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else timer = setTimeout(tick, this.delayMs);
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
  }
  close() { for (const thread of this.threads.values()) thread.stop?.('app-quit'); }
  status() { const a = this.agent.status(); return { mode: 'mock', upstreamGenerationRequests: 0, ...this.provider?.status(), interceptedRequests: this.requests.length, requestShapes: this.requests.slice(-15), threadCount: this.threads.size + a.threads, completedTurns: this.completed + a.completed, stoppedTurns: this.stopped + a.stopped, failedTurns: a.failed + this.formulaFailures + this.researchFailures, activeTurns: [...this.threads.values()].filter(t => t.stop).length + a.active + this.formulaTurns.size }; }
}
module.exports = { NativeMock, json };
