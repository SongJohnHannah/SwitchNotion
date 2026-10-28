// Supply only records owned by this local adapter; preserve ordinary Notion reads.
async function localRecords(request, input, endpoint, agent, passthrough, log) {
  if (!Array.isArray(input.requests)) return passthrough(request);
  const records = input.requests.map(r => {
    const pointer = r.pointer || r;
    return ['thread', 'thread_message', 'workflow_automation_run', 'task_output', 'block', 'collection', 'collection_view'].includes(pointer.table)
      ? agent.record(pointer.id, pointer.table, { userId: request.headers.get('x-notion-active-user-header'), spaceId: pointer.spaceId ?? input.spaceId ?? request.headers.get('x-notion-space-id') ?? undefined }) : undefined;
  });
  const owned = input.requests.map((r, i) => !!records[i] || !!agent.hasRecord?.((r.pointer || r).id, (r.pointer || r).table));
  if (!owned.some(Boolean)) return passthrough(request);
  const roles = input.requests.map((r, i) => {
    const pointer = r.pointer || r;
    return records[i] && agent.recordRole?.(pointer.id, pointer.table, { userId: request.headers.get('x-notion-active-user-header'), spaceId: pointer.spaceId ?? input.spaceId ?? request.headers.get('x-notion-space-id') ?? undefined }) || 'editor';
  });
  const remoteRequests = input.requests.filter((_, i) => !owned[i]);
  let payload = endpoint === 'getRecordValues' ? { results: [] } : { recordMap: { __version__: 3 } };
  if (remoteRequests.length) {
    const headers = new Headers(request.headers); headers.delete('content-length');
    const remote = await passthrough(new Request(request, { headers, body: JSON.stringify({ ...input, requests: remoteRequests }) }));
    if (!remote.ok) return remote;
    payload = await remote.json();
  }
  if (endpoint === 'getRecordValues') {
    let index = 0;
    payload.results = records.map((record, i) => record ? { role: roles[i], value: record } : owned[i] ? { role: 'none' } : payload.results[index++]);
  } else {
    payload.recordMap ||= {};
    for (let i = 0; i < records.length; i++) {
      const record = records[i]; if (!owned[i]) continue;
      const table = (input.requests[i].pointer || input.requests[i]).table;
      payload.recordMap[table] ||= {};
      const entry = record ? { role: roles[i], value: record } : { role: 'none' };
      const pointer = input.requests[i].pointer || input.requests[i];
      payload.recordMap[table][record?.id || pointer.id] = payload.recordMap.__version__ === 3 ? { ...(record ? { spaceId: record.space_id } : pointer.spaceId ? { spaceId: pointer.spaceId } : {}), value: entry } : entry;
    }
  }
  log({ type: 'local-thread-records-served', endpoint, count: records.filter(Boolean).length });
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
module.exports = { localRecords };
