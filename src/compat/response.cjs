const { likelyTarget, knownAsset, scriptAsset } = require('./automatic.cjs');
const legacyKinds = { '95271': 'availability', '96975': 'models', '32453': 'provider', '58104': 'provider',
  '17521': 'audio', '89269': 'recording', '17048': 'connection', '57590': 'autofill', '51103': 'attachments' };
const moduleKinds = { '811656': 'availability', '459724': 'models', '60217': 'provider', '328616': 'audio',
  '331787': 'recording', '372201': 'recording', '329948': 'recording', '329462': 'recording',
  '241978': 'connection', '697264': 'connection', '414741': 'autofill', '175529': 'attachments' };
const kindForAsset = asset => legacyKinds[asset.split('-')[0]] ? { notionSwitchKind: legacyKinds[asset.split('-')[0]] } : {};
// Classification only scopes dependencies and failure reporting. It never
// authorizes an adaptation; the full hash/fingerprint checks still run below.
function scriptKinds(source, asset) {
  const result = new Set(), legacy = legacyKinds[asset.split('-')[0]];
  if (legacy) result.add(legacy);
  for (const match of source.matchAll(/[,{]\s*(\d+)\s*\(/g)) if (moduleKinds[match[1]]) result.add(moduleKinds[match[1]]);
  return [...result];
}
const limit = 2 * 1024 * 1024;
async function candidateScript(response, asset) {
  if (!scriptAsset.test(asset) || !response.ok) return null;
  if (Number(response.headers.get('content-length')) > limit) {
    if (knownAsset.test(asset)) throw Object.assign(Error('Native script exceeds limit'), kindForAsset(asset));
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
        if (knownAsset.test(asset)) throw Object.assign(Error('Native script exceeds limit'), kindForAsset(asset));
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
  const kinds = scriptKinds(source, asset), records = [];
  let patched;
  try {
    if (kinds.some(kind => ['audio', 'recording', 'connection'].includes(kind))) await options.prepare?.();
    patched = await require('../client-compat.cjs').adaptClientAsync(source, asset, { ...options, onAdaptation: record => records.push(record) });
  } catch (error) {
    error.notionSwitchKinds = kinds;
    if (!error.notionSwitchKind && kinds.length === 1) error.notionSwitchKind = kinds[0];
    throw error;
  }
  const headers = new Headers(response.headers);
  for (const key of ['content-length', 'content-encoding', 'etag', 'content-md5']) headers.delete(key);
  headers.set('cache-control', 'no-store');
  const legacyKind = legacyKinds[asset.split('-')[0]];
  const result = { response: new Response(patched, { status: response.status, headers }), changed: patched !== source,
    kinds: records.length ? records.map(record => record.kind) : legacyKind ? [legacyKind] : [], automatic: records.filter(record => record.mode === 'automatic') };
  void response.body?.cancel().catch(() => {});
  return result;
}
module.exports = { candidateScript, adaptResponse };
