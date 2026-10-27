const { likelyTarget, knownAsset, scriptAsset } = require('./automatic.cjs');
const limit = 2 * 1024 * 1024;
async function candidateScript(response, asset) {
  if (!scriptAsset.test(asset) || !response.ok) return null;
  if (Number(response.headers.get('content-length')) > limit) {
    if (knownAsset.test(asset)) throw Error('Native script exceeds limit');
    return null;
  }
  const reader = response.clone().body?.getReader(); if (!reader) return null;
  let length = 0; const chunks = [];
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > limit) {
        void reader.cancel().catch(() => {});
        if (knownAsset.test(asset)) throw Error('Native script exceeds limit');
        return null;
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  const source = Buffer.concat(chunks, length).toString('utf8');
  return likelyTarget(source, asset) ? source : null;
}
async function adaptResponse(response, asset, options = {}) {
  const source = await candidateScript(response, asset); if (source === null) return null;
  await options.prepare?.(); const records = [];
  const patched = await require('../client-compat.cjs').adaptClientAsync(source, asset, { ...options, onAdaptation: record => records.push(record) });
  const headers = new Headers(response.headers);
  for (const key of ['content-length', 'content-encoding', 'etag', 'content-md5']) headers.delete(key);
  headers.set('cache-control', 'no-store');
  const legacyKind = { '95271': 'availability', '96975': 'models', '32453': 'provider', '17521': 'audio', '89269': 'recording', '17048': 'connection' }[asset.split('-')[0]];
  const result = { response: new Response(patched, { status: response.status, headers }), changed: patched !== source,
    kinds: records.length ? records.map(record => record.kind) : legacyKind ? [legacyKind] : [], automatic: records };
  void response.body?.cancel().catch(() => {});
  return result;
}
module.exports = { candidateScript, adaptResponse };
