const { InlineRecords } = require('./inline-records.cjs');
const { preparePublicResearch } = require('./native-web-research.cjs');
const { uuid } = require('./native-context.cjs');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const fail = (message, status = 400) => { throw Object.assign(Error('Notion 网页研究' + message), { status }); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
function inspect(records, input, meta, allowNotion = false) {
  if (!Array.isArray(input?.transactions)) return null;
  const all = input.transactions.flatMap(transaction => Array.isArray(transaction?.operations) ? transaction.operations.map(op => ({ op, transaction })) : []);
  const owner = op => {
    const pointer = op?.pointer;
    const thread = pointer?.table === 'thread' ? records.record(pointer.id) : pointer?.table === 'thread_message'
      ? records.record(records.record(pointer.id, 'thread_message')?.parent_id || op?.args?.parent_id) : undefined;
    return thread?.created_source === 'researcher' ? thread : undefined;
  };
  const local = all.map(({ op }) => owner(op)).filter(Boolean); if (!local.length) return null;
  if (all.length > 1000 || input.transactions.length > 100 || JSON.stringify(input).length > 600000) fail('事务过大。');
  const current = local[0], scope = { userId: meta?.userId, spaceId: current.space_id };
  if (!records.record(current.id, 'thread', scope)) fail('对话不属于当前账号。', 403);
  if (all.some(({ op }) => owner(op)?.id !== current.id)) fail('本地研究消息不能与其他线程或页面修改混合保存。', 409);
  const staged = new InlineRecords();
  staged.threads = new Map([...records.threads].map(([id, value]) => [id, structuredClone(value)]));
  staged.messages = new Map([...records.messages].map(([id, value]) => [id, structuredClone(value)]));
  const thread = staged.record(current.id), added = new Set(), linked = new Set(); let changed = false;
  for (const { op, transaction } of all) {
    const pointer = op.pointer;
    if (transaction.spaceId !== undefined && uuid(transaction.spaceId) !== uuid(thread.space_id) || pointer.spaceId !== undefined && uuid(pointer.spaceId) !== uuid(thread.space_id)) fail('事务工作区不匹配。', 403);
    if (!Array.isArray(op.path)) fail('消息修改格式无效。');
    if (pointer.table === 'thread_message') {
      const old = staged.record(pointer.id, 'thread_message'), id = uuid(pointer.id); let step;
      if (!id) fail('消息标识无效。');
      if (op.command === 'set' && equal(op.path, [])) {
        if (!object(op.args) || uuid(op.args.id) !== id || uuid(op.args.parent_id) !== uuid(thread.id) || op.args.parent_table !== 'thread' ||
            op.args.space_id !== undefined && uuid(op.args.space_id) !== uuid(thread.space_id) || op.args.created_by_id !== undefined && uuid(op.args.created_by_id) !== uuid(meta.userId)) fail('新消息所属范围不匹配。', 403);
        step = op.args.step;
      } else if (old && ['set', 'update'].includes(op.command) && equal(op.path, ['step'])) step = op.args;
      else fail('暂不支持此消息修改。');
      if (!object(step) || uuid(step.id) !== id || old && old.step.type !== step.type) fail('消息类型或标识不匹配。');
      if (old?.step.type === 'agent-inference') { if (!equal(step, old.step)) fail('不能修改本地生成的报告。'); continue; }
      if (!old && step.type === 'agent-inference') fail('不能伪造生成的报告。');
      if (!old) added.add(id);
      staged.messages.set(id, { ...old, id, parent_id: thread.id, parent_table: 'thread', space_id: thread.space_id,
        created_by_id: uuid(meta.userId), step: structuredClone(step) });
      changed ||= !old || !equal(step, old.step);
    } else {
      if (equal(op.path, ['messages'])) {
        if (['listAfter', 'listBefore'].includes(op.command) && uuid(op.args?.id) && staged.record(op.args.id, 'thread_message')?.parent_id === thread.id) {
          const id = uuid(op.args.id), relative = op.command === 'listAfter' ? op.args.after : op.args.before;
          if (relative !== undefined && !thread.messages.includes(uuid(relative))) fail('消息插入位置无效。');
          const prior = thread.messages.indexOf(id); if (prior >= 0) thread.messages.splice(prior, 1);
          const index = relative === undefined ? op.command === 'listAfter' ? 0 : thread.messages.length : thread.messages.indexOf(uuid(relative)) + (op.command === 'listAfter' ? 1 : 0);
          thread.messages.splice(index, 0, id); linked.add(id);
        } else if (op.command === 'set' && Array.isArray(op.args) && op.args.every(id => uuid(id) && staged.record(id, 'thread_message')?.parent_id === thread.id) && new Set(op.args.map(uuid)).size === op.args.length) {
          thread.messages = op.args.map(uuid); thread.messages.forEach(id => linked.add(id));
        } else if (op.command === 'listRemove' && uuid(op.args?.id) && thread.messages.includes(uuid(op.args.id))) thread.messages.splice(thread.messages.indexOf(uuid(op.args.id)), 1);
        else fail('消息列表超出当前线程。');
        changed = true;
      } else if (op.command === 'update' && equal(op.path, ['data']) && object(op.args) && Object.keys(op.args).length === 1 && typeof op.args.title === 'string' && op.args.title.length <= 500) thread.data.title = op.args.title;
      else if (op.command === 'set' && equal(op.path, ['data', 'title']) && typeof op.args === 'string' && op.args.length <= 500) thread.data.title = op.args;
      else if (op.command === 'update' && equal(op.path, []) && object(op.args) && Object.keys(op.args).every(key => ['updated_time', 'latest_user_or_trigger_time', 'has_transcript_content', 'alive', 'current_inference_id', 'current_inference_lease_expiration'].includes(key))) {
        for (const key of ['current_inference_id', 'current_inference_lease_expiration'])
          if (op.args[key] !== undefined && op.args[key] !== null && op.args[key] !== thread[key]) fail('运行标识由本地生成服务维护，不能改成其他任务。');
        if (op.args.alive !== undefined) { if (typeof op.args.alive !== 'boolean') fail('对话状态无效。'); changed ||= thread.alive !== op.args.alive; thread.alive = op.args.alive; }
        // The native stop helper clears these fields. A stale cleanup cannot
        // clear a newer server-owned generation; return the current lease.
      } else fail('线程修改超出本地研究消息范围。');
    }
  }
  if ([...added].some(id => !linked.has(id) || !thread.messages.includes(id))) fail('新消息没有完整关联到线程。');
  const normalized = preparePublicResearch({ threadId: thread.id, spaceId: thread.space_id, traceId: thread.current_inference_id,
    transcript: thread.messages.map(id => staged.record(id, 'thread_message')?.step) }, staged, uuid(meta.userId), { forInference: false, allowNotion });
  if (!normalized) fail('所选来源需要 Notion 正文接入，目前仍等待授权。', 501);
  const alive = thread.alive, frame = staged.snapshot(normalized.input, null, thread.data.notion_switch_research.status, uuid(meta.userId), { source: 'researcher', research: { web_only: !normalized.config.notion, notion_sources: normalized.config.notion } });
  staged.record(thread.id).alive = alive; frame.recordMap.thread[thread.id].value.value.alive = alive;
  if (thread.data.notion_switch_research.status === 'running') {
    const updated = staged.record(thread.id); updated.current_inference_id = thread.current_inference_id; updated.current_inference_lease_expiration = thread.current_inference_lease_expiration;
  }
  return { staged, frame, id: thread.id, changed };
}
function researchTransactions(records, input, meta, onChanged = () => {}, { allowNotion = false } = {}) {
  try {
    let result = inspect(records, input, meta, allowNotion); if (!result) return null;
    if (result.changed) {
      const oldTail = records.record(result.id).messages.at(-1);
      onChanged(result.id);
      const newTail = records.record(result.id).messages.at(-1);
      // A partial report can first become durable while stopping. An appended
      // new question belongs after that report, rather than before its newly
      // saved assistant step. Explicit reorders keep their original meaning.
      if (newTail !== oldTail) {
        input = structuredClone(input);
        for (const transaction of input.transactions) for (const op of transaction.operations || [])
          if (op.pointer?.table === 'thread' && uuid(op.pointer.id) === result.id && op.command === 'listAfter' && equal(op.path, ['messages']) &&
              uuid(op.args?.after) === uuid(oldTail) && !records.record(op.args?.id, 'thread_message')) op.args.after = newTail;
      }
      result = inspect(records, input, meta, allowNotion);
    }
    const previous = { threads: records.threads, messages: records.messages };
    records.threads = result.staged.threads; records.messages = result.staged.messages;
    try { records.save(); } catch (error) { records.threads = previous.threads; records.messages = previous.messages; throw error; }
    return json({ recordMap: result.frame.recordMap });
  } catch (error) { return json({ message: /^Notion /.test(error.message || '') ? error.message : 'Notion 网页研究消息保存失败，请保留本地记录后重试。' }, error.status || 400); }
}
module.exports = { researchTransactions };
