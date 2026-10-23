const { digest, reference, publicReceipt } = require('./agent-context.cjs');

function identityArgs(args, context = {}) {
  const value = structuredClone(args);
  if (!value.workspace_id || value.workspace_id === 'current') value.workspace_id = context.workspace_id;
  for (const key of ['page_id', 'parent_page_id', 'block_id']) {
    if (value[key] === 'current' && context.page_id) value[key] = context.page_id;
  }
  for (const [key, item] of Object.entries(value)) if (/_id$/.test(key) && typeof item === 'string' && /^[a-f\d-]{32,36}$/i.test(item)) value[key] = item.replaceAll('-', '').toLowerCase();
  return value;
}
const operationKey = (name, args, context) => name + ':' + digest(identityArgs(args, context));
const factHash = result => digest(JSON.parse(JSON.stringify(result, (key, value) => key === 'request_id' ? undefined : value)));

function progressPage(checkpoint, args) {
  if (!args || Object.keys(args).some(key => !['offset', 'limit'].includes(key)) || !Number.isInteger(args.offset ?? 0) || (args.offset ?? 0) < 0 || !Number.isInteger(args.limit ?? 30) || (args.limit ?? 30) < 1 || (args.limit ?? 30) > 50) throw Error('Notion 任务进度分页参数无效。');
  const offset = args.offset || 0, limit = args.limit || 30;
  return { total: checkpoint.receipts.length, receipts: checkpoint.receipts.slice(offset, offset + limit).map(publicReceipt), next_offset: Math.min(offset + limit, checkpoint.receipts.length), has_more: offset + limit < checkpoint.receipts.length };
}

// Every read still reaches Notion. Suppress duplicate message payloads only
// while the original, identical result remains visible to this model request.
function readPayload(messages, cache, name, args, result, callId, context) {
  const key = operationKey(name, args, context), hash = factHash(result), previous = cache.get(key);
  if (previous?.hash === hash && messages.some(m => m.role === 'tool' && m.tool_call_id === previous.callId)) {
    return { ...reference(result), unchanged: true, same_result_as_tool_call_id: previous.callId,
      instructions: '本次已重新读取，结果与仍在当前上下文中的该次工具结果一致；直接使用该结果，不必再次读取同一内容。' };
  }
  cache.delete(key); cache.set(key, { hash, callId });
  if (cache.size > 256) cache.delete(cache.keys().next().value);
  return result;
}

module.exports = { operationKey, factHash, progressPage, readPayload };
