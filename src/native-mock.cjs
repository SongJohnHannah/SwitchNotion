const { randomUUID } = require('node:crypto');
const { AgentMock } = require('./agent-mock.cjs');
const { LocalHistory } = require('./local-history.cjs');
const { isWriter, streamInline } = require('./native-inline.cjs');
const { InlineRecords } = require('./inline-records.cjs');
const path = require('node:path');

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const blocked = endpoint => json({ name: 'NotionSwitchPrototype', message: `NotionSwitch mock adapter is not ready for ${endpoint}; the request was not forwarded.`, errorId: randomUUID() }, 501);

class NativeMock {
  constructor({ log = () => {}, delayMs = 140, stateFile, provider, workspace } = {}) { this.log = log; this.delayMs = delayMs; this.provider = provider; this.requests = []; this.threads = new Map(); this.completed = 0; this.stopped = 0; this.agent = new AgentMock({ log, delayMs, stateFile, provider, workspace }); this.history = new LocalHistory({ log }); this.inline = new InlineRecords(stateFile && path.join(path.dirname(stateFile), 'inline-conversations.local.json')); }
  record(id, table = 'thread') { return (table === 'thread' && this.agent.record(id)) || this.inline.record(id, table); }
  owns(input) { return this.agent.owns(input); }
  async handle(endpoint, input, signal, meta) {
    this.requests.push({ endpoint, keys: Object.keys(input || {}).sort(), at: new Date().toISOString() });
    this.log({ type: 'ai-intercepted', endpoint, keys: Object.keys(input || {}).sort() });
    if (endpoint === 'getInferenceTranscriptsForUser') return this.history.list({ input, agent: this.agent, userId: meta?.userId, fetchRemote: meta?.fetchHistory || meta?.passthrough || (async () => json({ threadIds: [], nextCursor: null })) });
    if (endpoint === 'createAgentThread' || endpoint === 'createCalendarAgentThread') return this.agent.create(input, meta);
    if (endpoint === 'sendEventToAgentThread') return this.agent.send(input, meta);
    if (endpoint === 'getThreadTranscript') return this.agent.transcript(input);
    if (endpoint === 'getThreadQueuedMessages') return json({ messages: [] });
    if (endpoint === 'listenToThreadTranscript' && this.agent.owns(input)) return this.agent.listen(input, signal);
    if (endpoint === 'runInferenceTranscript') {
      if (this.provider?.status().mode !== 'deepseek') return this.legacy(input, signal);
      if (!isWriter(input)) return blocked(endpoint);
      const id = input.threadId || randomUUID();
      let thread = this.threads.get(id);
      if (!thread) { thread = { turns: [], stop: null }; this.threads.set(id, thread); }
      return streamInline({ input, signal, provider: this.provider, thread, log: this.log, onSnapshot: (step, status) => this.inline.snapshot(input, step, status, meta?.userId), onFinish: reason => { if (reason === 'completed') this.completed++; else if (reason !== 'failed') this.stopped++; } });
    }
    if (endpoint === 'stopWorkflowAutomationRunThread') {
      const thread = this.threads.get(input.threadId);
      thread?.stop?.('stop-api');
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
  status() { const a = this.agent.status(); return { mode: 'mock', upstreamGenerationRequests: 0, ...this.provider?.status(), interceptedRequests: this.requests.length, requestShapes: this.requests.slice(-15), threadCount: this.threads.size + a.threads, completedTurns: this.completed + a.completed, stoppedTurns: this.stopped + a.stopped, failedTurns: a.failed, activeTurns: [...this.threads.values()].filter(t => t.stop).length + a.active }; }
}
module.exports = { NativeMock, json };
