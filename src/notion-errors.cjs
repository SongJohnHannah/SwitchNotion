const definitelyNotWritten = error => ['not_submitted', 'rejected'].includes(error?.writeOutcome);
function notSubmitted(error) { if (error && typeof error === 'object' && !error.writeOutcome) error.writeOutcome = 'not_submitted'; return error; }
function uncertain(error) { if (error && typeof error === 'object') error.writeOutcome = 'uncertain'; return error; }
const failureInfo = error => ({ write_outcome: error?.writeOutcome, api_status: error?.status, api_code: error?.apiCode });
const rejectedCodes = new Set(['invalid_json', 'invalid_request_url', 'invalid_request', 'validation_error', 'missing_version', 'invalid_beta']);
async function apiError(response) {
  // Error bodies can echo private content. Read a bounded body and expose only
  // the documented code and known schema field names, never the server message.
  let detail, reader;
  try {
    reader = response.body?.getReader(); let bytes = 0; const chunks = [];
    if (reader) while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 16384) break; chunks.push(Buffer.from(next.value)); }
    if (bytes <= 16384 && chunks.length) detail = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {} finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
  const code = typeof detail?.code === 'string' && /^[a-z_]{1,50}$/.test(detail.code) ? detail.code : undefined;
  const rejected = response.status === 400 && rejectedCodes.has(code);
  const field = typeof detail?.message === 'string' ? /\bbody\.(position|after|children|properties|parent|rich_text|type)\b/.exec(detail.message)?.[0] : undefined;
  const extra = rejected ? `（${code}，参数未通过校验，本次请求未执行${field ? '；请检查 ' + field : ''}）` : response.status === 429 ? '，请求过于频繁，请稍后重试' : [403, 404].includes(response.status) ? '，请检查页面授权和连接的读写权限' : '';
  const error = Error(`Notion API 返回 HTTP ${response.status}${extra}。`);
  error.status = response.status; error.apiCode = code;
  if (rejected) error.writeOutcome = 'rejected';
  return error;
}
module.exports = { definitelyNotWritten, notSubmitted, uncertain, failureInfo, apiError };
