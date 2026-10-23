// Supply only records owned by this local adapter; preserve ordinary Notion reads.
async function localRecords(request, input, endpoint, agent, passthrough, log) {
  if (!Array.isArray(input.requests)) return passthrough(request);
  const records = input.requests.map(r => {
    const pointer = r.pointer || r;
    return ['thread', 'thread_message'].includes(pointer.table) ? agent.record(pointer.id, pointer.table) : undefined;
  });
  if (!records.some(Boolean)) return passthrough(request);
  const remoteRequests = input.requests.filter((_, i) => !records[i]);
  let payload = endpoint === 'getRecordValues' ? { results: [] } : { recordMap: { __version__: 3 } };
  if (remoteRequests.length) {
    const headers = new Headers(request.headers); headers.delete('content-length');
    const remote = await passthrough(new Request(request, { headers, body: JSON.stringify({ ...input, requests: remoteRequests }) }));
    if (!remote.ok) return remote;
    payload = await remote.json();
  }
  if (endpoint === 'getRecordValues') {
    let index = 0;
    payload.results = records.map(record => record ? { role: 'editor', value: record } : payload.results[index++]);
  } else {
    payload.recordMap ||= {};
    for (let i = 0; i < records.length; i++) {
      const record = records[i]; if (!record) continue;
      const table = (input.requests[i].pointer || input.requests[i]).table;
      payload.recordMap[table] ||= {};
      const entry = { role: 'editor', value: record };
      payload.recordMap[table][record.id] = payload.recordMap.__version__ === 3 ? { spaceId: record.space_id, value: entry } : entry;
    }
  }
  log({ type: 'local-thread-records-served', endpoint, count: records.filter(Boolean).length });
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
module.exports = { localRecords };
