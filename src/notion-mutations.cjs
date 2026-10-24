const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { definitelyNotWritten, notSubmitted, uncertain, failureInfo } = require('./notion-errors.cjs');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

// One journal and one uncertainty guard cover every content-writing capability.
function createMutator({ root, workspaceId, operationScope, readOnly, request, signal, isBlocked = () => false, onUncertain = () => {}, onVerified = () => {}, onSubmitted = () => {}, log = () => {} }) {
  return async ({ name, target, args, method, endpoint, body, verify }) => {
    signal?.throwIfAborted();
    if (readOnly) throw Error('Notion 连接当前为只读模式。');
    if (isBlocked()) throw Error('此前写入的结果未确定，本轮已停止后续写入。请先读取页面检查。');
    if (!name || !target || !['POST', 'PATCH', 'DELETE'].includes(method) || typeof verify !== 'function') throw Error('Notion 写入请求格式无效。');
    const operation = createHash('sha256').update(JSON.stringify(canonical({ workspaceId, operationScope, name, target, args, method, endpoint, body }))).digest('hex');
    const directory = path.join(root, 'write-journal'); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'content-' + operation + '.json');
    if (fs.existsSync(file)) {
      const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (prior.status === 'verified') return { ...prior.result, duplicate: true };
      if (prior.status === 'rejected') throw notSubmitted(Error('Notion 此前同一请求已被拒绝，请修正参数后再提交，不能重复发送同一无效请求。'));
      onUncertain();
      throw Error('此前同一写入的结果未确定，请先检查页面及本地写入记录，不能重复提交。');
    }
    const record = { status: 'pending', workspace_id: workspaceId, operation_scope: operationScope, operation_id: operation, name, target, intended: args, request: { method, endpoint, body }, startedAt: new Date().toISOString() };
    const save = () => fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600, flush: true });
    save(); log({ type: 'notion-write-started', operation: name });
    let submitted = false;
    try {
      const response = await request(method, endpoint, body);
      submitted = true;
      // Save server-assigned IDs before any subsequent read can fail or be stopped.
      record.status = 'submitted'; record.response = response; save();
      onSubmitted(response);
      signal?.throwIfAborted();
      const result = { ...(await verify(response)), operation_id: operation };
      record.status = result.verified === true ? 'verified' : 'uncertain';
      record.result = result; record.finishedAt = new Date().toISOString(); save();
      if (result.verified === true) onVerified(); else onUncertain();
      log({ type: 'notion-write-ended', operation: name, verified: result.verified === true });
      return result;
    } catch (error) {
      const rejected = !submitted && definitelyNotWritten(error);
      if (!rejected) { onUncertain(); uncertain(error); }
      record.status = rejected ? 'rejected' : 'uncertain'; record.error = failureInfo(error); record.finishedAt = new Date().toISOString(); save();
      log({ type: rejected ? 'notion-write-rejected' : 'notion-write-uncertain', operation: name });
      throw error;
    }
  };
}
module.exports = { createMutator, canonical };
