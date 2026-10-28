// Native read-only research, using the selected workspace scope and optional
// public web sources. External connectors remain outside this reader.
const { randomUUID } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { normalizeResearch } = require('./native-research.cjs');
const { explicitPages } = require('./native-instruction-selection.cjs');
const { explicitUrls } = require('./web-sources.cjs');
const { runAgent } = require('./agent-runtime.cjs');
const { researchMessages } = require('./native-research.cjs');
const { researchWorkspace } = require('./research-scope.cjs');
const { createInlineReferenceReader } = require('./inline-references.cjs');
const { selectionFrom } = require('./native-models.cjs');
const plain = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(span => typeof span?.[0] === 'string' ? span[0] : '').join('') : '';
const fail = message => { throw Error('Notion 网页研究' + message); };
function preparePublicResearch(input, records, userId, { forInference = true, allowNotion = false } = {}) {
  if (!uuid(userId)) fail('缺少当前账号，请重新登录后发送。');
  const saved = records.record(input?.threadId, 'thread', { userId, spaceId: input?.spaceId });
  if (saved && (saved.created_source !== 'researcher' || saved.data?.notion_switch_research?.web_only !== true && !(allowNotion && saved.data?.notion_switch_research?.notion_sources === true))) fail('线程不属于本地研究入口。');
  if (!Array.isArray(input?.transcript)) fail('对话步骤格式无效。');
  let steps = input.transcript;
  if (saved && !steps.some(step => step?.type === 'config')) {
    const incoming = new Set(steps.map(step => uuid(step?.id)));
    steps = [...saved.messages.map(id => records.record(id, 'thread_message', { userId, spaceId: saved.space_id })?.step)
      .filter(step => step && !incoming.has(uuid(step.id))), ...steps];
  }
  steps = steps.map(step => {
    if (step?.type !== 'agent-inference') return step;
    const original = records.record(step.id, 'thread_message', { userId, spaceId: input.spaceId });
    if (!original || uuid(original.parent_id) !== uuid(input.threadId) || original.step.type !== 'agent-inference') fail('历史回复未匹配本地原始记录。');
    return structuredClone(original.step);
  });
  const normalized = normalizeResearch({ ...input, transcript: steps }, userId);
  for (const step of normalized.input.transcript) if (step.type === 'agent-inference') {
    const canonical = records.record(step.id, 'thread_message', { userId, spaceId: input.spaceId }).step;
    if (uuid(canonical.traceId)) step.traceId = uuid(canonical.traceId);
    for (const key of ['startedAt', 'finishedAt']) if (Number.isSafeInteger(canonical[key]) && canonical[key] >= 0) step[key] = canonical[key];
  }
  if (normalized.config.notion && !allowNotion) return null;
  if (!normalized.config.notion && !normalized.config.useWebSearch) fail('请明确选择 Notion 或网页来源。');
  const originalConfig = steps.find(step => step?.type === 'config').value;
  normalized.modelSelection = originalConfig.modelFromUser === true ? selectionFrom({ model: originalConfig.model }) : { type: 'automatic' };
  if (normalized.modelSelection.type === 'explicit') Object.assign(normalized.input.transcript.find(step => step.type === 'config').value,
    { model: normalized.modelSelection.model, modelFromUser: true });
  for (const step of normalized.config.notion ? [] : normalized.input.transcript) {
    if (step.type === 'user-specified-context' && (step.value.pointers.length || step.value.textSelection || step.value.blockSelection)) fail('当前只接通公开网页来源，页面引用和选区正文尚未接入此分支。');
    if (step.type === 'user-injected') fail('暂不接收自动注入的工作区上下文，请直接输入网页研究问题。');
    if (step.type === 'user' && explicitPages([{ type: 'text', text: step.actualMessage ?? step.value }], input.spaceId).length) fail('当前只接通公开网页来源，Notion 页面提及尚未接入此分支。');
  }
  if (forInference && normalized.input.transcript.findLast(step => ['user', 'agent-inference'].includes(step.type))?.type !== 'user') fail('请先输入新的问题，或从原问题重新生成；未重复运行已经完成的报告。');
  return normalized;
}
function streamPublicResearch({ normalized, records, userId, provider, workspace, webSources, pageFiles, thread, signal, timeoutMs = 300000, log = () => {}, onFinish = () => {} }) {
  const { input, config } = normalized, generation = new AbortController();
  const active = signal ? AbortSignal.any([signal, generation.signal]) : generation.signal;
  const step = { id: randomUUID(), type: 'agent-inference', traceId: input.traceId, startedAt: Date.now(), value: [{ type: 'text', content: '' }] };
  const turn = { status: 'running' }; thread.turns.push(turn);
  const encoder = new TextEncoder(), sources = new Map();
  let controller, ended = false, disconnected = false, started = false, timer, web, lastSaved = 0, sourceCharacters = 0;
  const emit = value => { if (!ended && !disconnected) { try { controller.enqueue(encoder.encode(JSON.stringify(value) + '\n')); } catch { disconnected = true; } } };
  const flush = () => { emit(input.asPatchResponse ? { type: started ? 'patch-sync' : 'patch-start', data: { s: [step] } } : step); started = true; };
  const snapshot = status => {
    const proof = web?.authorizedUrls ? { userId, spaceId: input.spaceId, urls: web.authorizedUrls() } : undefined;
    emit(records.snapshot(input, step.value[0].content ? step : null, status, userId, { source: 'researcher', research: {
      web_only: !config.notion, notion_sources: config.notion, sources: [...sources.values()], ...(proof ? { webSources: proof } : {}) } }));
    lastSaved = Date.now();
  };
  const finish = status => {
    if (ended) return;
    step.finishedAt = Date.now(); turn.status = status;
    try { flush(); snapshot(status); } catch { log({ type: 'public-research-save-failed' }); status = turn.status = 'failed'; }
    ended = true; clearTimeout(timer); active.removeEventListener('abort', abort);
    if (thread.stop === stop) thread.stop = null;
    generation.abort(); web?.close();
    if (!disconnected) { try { controller.close(); } catch {} }
    onFinish(status); log({ type: 'native-public-research-ended', status, sourceCount: sources.size });
  };
  const stop = reason => {
    if (ended) return;
    step.value[0].content += '\n\n' + (reason === 'timeout' ? '网页研究达到本轮时间上限，已保存部分结果。' : '网页研究已停止，已保存部分结果。');
    finish(reason === 'timeout' ? 'timeout' : 'stopped');
  };
  const abort = () => stop('request-aborted');
  const collect = (result, name) => {
    for (const item of [result, ...(result.results || [])]) {
      if (typeof item.url !== 'string' || item.url.length > 4000) continue;
      const old = sources.get(item.url);
      if (!old && (sources.size >= 32 || sourceCharacters + item.url.length > 16000)) continue;
      if (!old) sourceCharacters += item.url.length;
      const file = result.source === 'notion-page-file';
      sources.set(item.url, { url: item.url, title: String(item.title || old?.title || '公开网页').replace(/[\r\n\[\]\\`]/g, ' ').slice(0, 160),
        body_available: file ? result.body_available === true : name === 'read_web_page' || !!old?.body_available, complete: file ? result.complete === true : name === 'read_web_page' && result.complete === true || !!old?.complete,
        ...(result.fetched_at ? { fetched_at: result.fetched_at } : {}) });
    }
  };
  const run = async () => {
    try {
      active.throwIfAborted(); snapshot('running');
      const users = input.transcript.filter(value => value.type === 'user').map(value => ({ type: 'text', text: value.actualMessage ?? value.value }));
      web = config.useWebSearch ? await webSources?.open({ purpose: 'research', input: config, userId, spaceId: input.spaceId, content: users,
        priorSources: records.record(input.threadId)?.data?.notion_switch_research?.webSources, signal: active }) : undefined;
      active.throwIfAborted(); if (config.useWebSearch && !web) fail('本地联网设置尚未启用，请在配置中心开启后重新发送。');
      const scoped = config.notion ? researchWorkspace(workspace, { spaceId: input.spaceId, config, onSource: row => {
        collect(row, row.body_available ? 'read_web_page' : 'search_pages');
      } }) : null;
      const fileReader = config.notion && pageFiles ? pageFiles.open({ spaceId: input.spaceId, signal: active,
        session: await scoped.open({ signal: active, nativeContext: normalized.nativeContext }) }) : null;
      const fileService = fileReader && { ...fileReader, execute: async (name, args) => {
        const result = await fileReader.execute(name, args);
        collect({ ...result, title: result.document?.filename || 'Notion 附件', complete: result.document?.complete === true }, 'read_web_page'); return result;
      } };
      const resolveFile = fileService ? ({ blockId, spaceId }) => {
        if (spaceId !== input.spaceId) fail('附件不属于本轮所选工作区。');
        return fileService.execute('read_notion_file', { block_id: blockId });
      } : undefined;
      const messages = config.notion ? await researchMessages(input, { signal: active, resolveReferences: createInlineReferenceReader({ workspace: scoped, resolveFile }) }) : [{ role: 'system', content: '' }];
      for (const original of config.notion ? [] : input.transcript) {
        if (original.type === 'user') {
          const content = original.actualMessage ?? original.value, urls = [...explicitUrls([{ type: 'text', text: content }])];
          messages.push({ role: 'user', content: plain(content) + (urls.length ? '\n本条消息明确提供的公开网址：' + JSON.stringify(urls) : '') });
        } else if (original.type === 'agent-inference') messages.push({ role: 'assistant', content: original.value.map(part => part.content).join('') });
      }
      const lastUser = messages.findLastIndex(value => value.role === 'user');
      messages.splice(lastUser, 0, { role: 'user', notionSwitchResearch: true, content: config.notion ? '本轮只读研究仅使用所选工作区的已授权 Notion 来源' + (config.useWebSearch ? '及启用的公开网页。' : '。') + config.notice + '报告必须标明读取来源和未读完的范围。' : '本轮原生来源范围仅为公开网页。未提供任何 Notion 工作区连接、页面正文、个人指令或技能工具。报告须给出实际来源及未完成的范围；引用搜索摘要时标明尚未读取正文。' });
      const tracked = web ? { ...web, execute: async (name, args) => { const result = await web.execute(name, args); collect(result, name); return result; } } : undefined;
      await runAgent({ provider, config: provider.config(normalized.modelSelection), messages, workspace: scoped, nativeContext: normalized.nativeContext, web: tracked, nativeServices: fileService ? [fileService] : [], research: true, operationScope: input.threadId + ':' + input.traceId, signal: active,
        onText: delta => { if (!ended) { if (step.value[0].content.length + delta.length > 120000) fail('报告达到长度上限，请缩小范围。'); step.value[0].content += delta; flush(); if (Date.now() - lastSaved >= 1000) snapshot('running'); } },
        onTextReset: count => { if (!ended && count) { step.value[0].content = step.value[0].content.slice(0, -count); flush(); } },
        onStep: value => log({ type: 'native-public-research-tool-step', ...value }) });
      active.throwIfAborted(); if (ended) return;
      const encode = value => value.replaceAll('(', '%28').replaceAll(')', '%29');
      step.value[0].content += sources.size ? '\n\n本轮返回的' + (config.notion ? '研究' : '公开') + '来源：\n' + [...sources.values()].map(source => '- [' + source.title + '](' + encode(source.url) + ')' + (!source.body_available ? '（搜索线索，未读正文）' : !source.complete ? '（正文未完整输出）' : '')).join('\n') : '\n\n本轮未取得可核对的来源链接，以上不能视为已检索验证的报告。';
      finish('completed');
    } catch (error) {
      if (ended) return;
      if (active.aborted || web?.signal?.aborted) return stop('aborted');
      step.value[0].content += '\n\n' + (/^(Notion |DeepSeek |本地 Agent|Notion 网页研究)/.test(error.message || '') ? error.message : 'Notion 网页研究未完成，请检查联网配置与来源。');
      finish('failed');
    } finally { web?.close(); }
  };
  const body = new ReadableStream({ start(c) {
    controller = c; thread.stop = stop; active.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('timeout'), timeoutMs); timer.unref?.(); void run();
  }, cancel() { disconnected = true; stop('reader-cancelled'); } });
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
}
module.exports = { preparePublicResearch, streamPublicResearch };
