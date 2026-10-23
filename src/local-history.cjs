const { randomUUID, createHash } = require('node:crypto');
const PREFIX = 'notion-switch-history:';
const sameId = (left, right) => typeof left === 'string' && typeof right === 'string' && left.replaceAll('-', '').toLowerCase() === right.replaceAll('-', '').toLowerCase();
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
function scopeFor(input, userId) {
  const pointer = input.threadParentPointer;
  if (!userId || pointer?.table !== 'space' || !pointer.id || pointer.spaceId && !sameId(pointer.spaceId, pointer.id)) return null;
  if (input.types !== undefined && (!Array.isArray(input.types) || input.types.some(type => typeof type !== 'string'))) return null;
  if (input.sort !== undefined && !['updated_desc', 'created_desc'].includes(input.sort)) return null;
  return { spaceId: pointer.id, userId, types: input.types, archived: input.archived === true, sort: input.sort || 'updated_desc' };
}
function owned(record, scope) {
  return record && record.alive !== false && sameId(record.space_id, scope.spaceId) &&
    (sameId(record.created_by_id, scope.userId) || record.permissions?.some(p => p.type === 'user_permission' && sameId(p.user_id, scope.userId) && p.role === 'editor')) &&
    !scope.archived && (!scope.types?.length || scope.types.includes(record.type));
}
function mergeRecordMap(map, records) {
  map ||= { __version__: 3 }; map.thread ||= {};
  for (const record of records) {
    const value = { role: 'editor', value: record };
    map.thread[record.id] = map.__version__ === 3 ? { spaceId: record.space_id, value } : value;
  }
  return map;
}
class LocalHistory {
  constructor({ now = () => Date.now(), log = () => {} } = {}) { this.now = now; this.log = log; this.cursors = new Map(); }
  cursor(value) {
    for (const [key, item] of this.cursors) if (item.expires <= this.now()) this.cursors.delete(key);
    while (this.cursors.size >= 128) this.cursors.delete(this.cursors.keys().next().value);
    const key = PREFIX + randomUUID(); this.cursors.set(key, { ...value, expires: this.now() + 3600000 }); return key;
  }
  async list({ input, agent, userId, fetchRemote }) {
    const scope = scopeFor(input, userId), cursor = input.cursor;
    const localCursor = typeof cursor === 'string' && cursor.startsWith(PREFIX);
    // Unrecognized filters and other record parents keep their native behavior.
    if (!scope) {
      this.log({ type: 'local-history-scope-unavailable', userPresent: !!userId, parentTable: ['space', 'block', 'workflow'].includes(input.threadParentPointer?.table) ? input.threadParentPointer.table : 'other' });
      return localCursor ? json({ threadIds: [], nextCursor: null }) : fetchRemote(input);
    }
    const scopeKey = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    if (cursor && !localCursor) return fetchRemote(input);
    const limit = Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 100 ? input.limit : 50;
    let ids, offset = 0;
    if (localCursor) {
      const saved = this.cursors.get(cursor);
      if (!saved || saved.scopeKey !== scopeKey || saved.expires <= this.now()) return json({ threadIds: [], nextCursor: null });
      ids = saved.ids; offset = saved.offset;
    } else {
      ids = [...agent.threads.values()].map(t => t.thread).filter(record => owned(record, scope))
        .sort((a, b) => (scope.sort === 'created_desc' ? b.created_time - a.created_time : b.updated_time - a.updated_time) || a.id.localeCompare(b.id)).map(record => record.id);
    }
    const remaining = ids.slice(offset).map(id => agent.record(id)).filter(record => owned(record, scope));
    const records = remaining.slice(0, limit), localIds = records.map(record => record.id);
    if (remaining.length >= limit) {
      // Finish local pages before requesting the first remote page. This avoids
      // discarding remote overflow or ever forwarding a local cursor upstream.
      const nextCursor = this.cursor({ scopeKey, ids: remaining.map(record => record.id), offset: records.length });
      this.log({ type: 'local-history-served', localCount: records.length, remoteCount: 0 });
      return json({ threadIds: localIds, nextCursor, recordMap: mergeRecordMap(null, records), unreadThreadIds: [] });
    }
    let response, payload;
    try {
      const request = { ...input, limit: limit - records.length }; delete request.cursor;
      response = await fetchRemote(request);
      if (!response.ok) throw Error('Remote history unavailable');
      payload = await response.clone().json();
      if (!Array.isArray(payload.threadIds) && !Array.isArray(payload.transcripts)) throw Error('Unknown history response');
    } catch {
      if (!records.length && !localCursor && response) return response;
      await response?.body?.cancel().catch(() => {});
      this.log({ type: 'local-history-served', localCount: records.length, remoteCount: 0, remoteUnavailable: true });
      return json({ threadIds: localIds, nextCursor: null, recordMap: mergeRecordMap(null, records), unreadThreadIds: [] });
    }
    const remoteIds = payload.threadIds || payload.transcripts.map(record => record.id);
    const data = { ...payload, threadIds: [...new Set([...localIds, ...remoteIds])], recordMap: mergeRecordMap(payload.recordMap, records) };
    if (Array.isArray(payload.transcripts)) data.transcripts = [
      ...records.map(record => ({ id: record.id, title: record.data.title, type: record.type, created_at: new Date(record.created_time).toISOString(), updated_at: new Date(record.updated_time).toISOString() })),
      ...payload.transcripts.filter(record => !localIds.includes(record.id))
    ];
    this.log({ type: 'local-history-served', localCount: records.length, remoteCount: remoteIds.length });
    return json(data);
  }
}
module.exports = { LocalHistory };
