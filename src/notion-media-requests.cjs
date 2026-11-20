const { createHash } = require('node:crypto');

const pageHosts = ['app.notion.com', 'www.notion.so', 'notion.so', 'www.notion.com', 'notion.com'];
const fileHosts = ['file.notion.com', 'file.notion.so'];
const objectHosts = ['prod-files-secure.s3.us-west-2.amazonaws.com', 'secure.notion-static.com', 'public.notion-static.com'];
const regionalHosts = ['s3.us-west-2.amazonaws.com', 's3-us-west-2.amazonaws.com'];
const fileBuckets = ['/secure.notion-static.com', '/public.notion-static.com', '/prod-files-secure'];
const imageHosts = ['img.notionusercontent.com', 'images.unsplash.com'];
const mediaHosts = Object.freeze([...fileHosts, ...objectHosts, ...imageHosts, 'api.notion.com', ...pageHosts, ...regionalHosts]);
const allowedHosts = new Set(mediaHosts);
const preparations = new Set(['getUploadSpaceFileUrl', 'getUploadGenericFileUrl', 'getUploadFileUrlForAssistantChatTranscriptUpload']);
const uuid = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const fileSend = new RegExp('^/v1/file_uploads/' + uuid + '/send$', 'i');
const mediaExtension = /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp|m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$/i;
const videoExtension = /\.(?:m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$/i;
const otherAttachment = /\.(?:csv|docx?|m4a|mp3|oga|ogg|pdf|pptx?|txt|wav|xlsx?|zip)$/i;
const preparationLimit = 64 * 1024;
const formPrefixLimit = 64 * 1024;

function httpsUrl(input) {
  if (typeof input !== 'string' || input.length > 32768) return null;
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && !url.hash ? url : null;
  } catch { return null; }
}
function allowedHost(host) { return typeof host === 'string' && allowedHosts.has(host.toLowerCase()); }
function isMediaMime(value) { return typeof value === 'string' && /^(?:image|video)\/[a-z\d.+-]+$/i.test(value.trim()); }
function workspaceRequest(request) {
  // Use the browser's initiator when present. Older Electron builds expose
  // the same first-party context only through Origin or Referer.
  const source = request.initiatorOrigin ?? request.headers.get('origin') ??
    (request.referrer && request.referrer !== 'about:client' ? request.referrer : request.headers.get('referer'));
  const url = httpsUrl(source);
  return !!url && pageHosts.includes(url.hostname);
}
function regionalObject(url) {
  return regionalHosts.includes(url.hostname) && fileBuckets.some(bucket => url.pathname.startsWith(bucket + '/'));
}
function storageObject(url) { return (objectHosts.includes(url.hostname) && url.pathname.length > 1) || regionalObject(url); }
function signedRead(url) {
  const keys = new Set([...url.searchParams.keys()].map(key => key.toLowerCase()));
  return ['signature', 'x-amz-signature', 'x-goog-signature'].some(key => keys.has(key));
}
function mediaName(url) {
  let name = url.pathname.split('/').at(-1);
  try { name = decodeURIComponent(name); } catch {}
  if (mediaExtension.test(name) || otherAttachment.test(name)) return name;
  return url.searchParams.get('downloadName') || url.searchParams.get('filename') || name;
}
function videoRange(request) {
  if (request.method !== 'GET' || !request.headers.has('range')) return false;
  return (request.headers.get('sec-fetch-dest') || request.destination) === 'video' ||
    videoExtension.test(mediaName(new URL(request.url)));
}
function readRoute(request, { knownMedia = false } = {}) {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  const url = httpsUrl(request.url);
  if (!url || !allowedHost(url.hostname)) return null;
  const destination = request.headers.get('sec-fetch-dest') || request.destination || '';
  const hinted = destination === 'image' || destination === 'video';
  if (destination && destination !== 'empty' && !hinted) return null;
  if (!knownMedia && !workspaceRequest(request)) return null;
  const name = mediaName(url);
  if (otherAttachment.test(name)) return null;
  if (!knownMedia && !hinted && !mediaExtension.test(name) &&
      !(url.hostname === 'images.unsplash.com' && /^\/(?:photo|premium_photo)-/.test(url.pathname))) return null;

  if (storageObject(url) || imageHosts.includes(url.hostname) && url.pathname.length > 1) return 'direct';
  if (fileHosts.includes(url.hostname) && /^\/f\/f\/.+/.test(url.pathname)) return signedRead(url) ? 'direct' : 'authorize';
  if (pageHosts.includes(url.hostname) && /^\/(?:image|signed)\/.+/.test(url.pathname)) {
    // Signed and public image requests can be sent directly. Requests
    // requiring a file redirect keep their original authenticated session.
    if (signedRead(url) || url.pathname.startsWith('/image/') && !request.headers.has('cookie') &&
      !request.headers.has('authorization') && !/secure\.notion-static|prod-files-secure|file\.notion/i.test(url.pathname)) return 'direct';
    return 'authorize';
  }
  return null;
}
function uploadObject(url, method) {
  if (objectHosts.includes(url.hostname) || fileHosts.includes(url.hostname)) return url.pathname.length > 1 || method === 'POST';
  return regionalHosts.includes(url.hostname) && fileBuckets.some(bucket =>
    url.pathname.startsWith(bucket + '/') && (url.pathname.length > bucket.length + 1 || method === 'POST') || url.pathname === bucket && method === 'POST');
}
function officialMediaSend(url, init) {
  const target = httpsUrl(typeof url === 'string' ? url : url?.href);
  return target?.hostname === 'api.notion.com' && !target.search && fileSend.test(target.pathname) &&
    init?.method === 'POST' && isMediaMime(init.body?.get?.('file')?.type);
}
function preparationRequest(request) {
  if (request.method !== 'POST' || !workspaceRequest(request)) return false;
  const url = httpsUrl(request.url);
  if (!url || !pageHosts.includes(url.hostname)) return false;
  const match = /^\/api\/v\d+\/([^/]+)$/.exec(url.pathname);
  return !!match && preparations.has(match[1]);
}

// Read only the small metadata prefix. Cancel the cloned branch without
// waiting for the real upload stream to be consumed.
async function readPrefix(message, limit) {
  if (!message.body) return { bytes: Buffer.alloc(0), done: true };
  const reader = message.clone().body.getReader();
  const chunks = [];
  let length = 0, done = false;
  try {
    while (length < limit) {
      const item = await reader.read();
      if (item.done) { done = true; break; }
      const chunk = Buffer.from(item.value.subarray(0, limit - length));
      length += chunk.length;
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks, length), done };
  } finally {
    if (!done) void reader.cancel().catch(() => {});
  }
}
async function smallJson(message) {
  if (!message.headers.get('content-type')?.includes('json')) return null;
  if (Number(message.headers.get('content-length')) > preparationLimit) return null;
  try {
    const { bytes, done } = await readPrefix(message, preparationLimit);
    return done ? JSON.parse(bytes.toString('utf8')) : null;
  } catch { return null; }
}
function formIdentity(fields) {
  if (typeof fields.key !== 'string' || !fields.key || typeof fields.policy !== 'string' || !fields.policy) return '';
  return createHash('sha256').update(JSON.stringify([fields.key, fields.policy])).digest('hex');
}
async function postedFormIdentity(request) {
  const boundary = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^\s;]+))$/i.exec(request.headers.get('content-type') || '');
  const marker = boundary?.[1] || boundary?.[2];
  if (!marker || marker.length > 100) return null;
  try {
    const { bytes } = await readPrefix(request, formPrefixLimit);
    const fields = Object.create(null);
    const delimiter = Buffer.from('--' + marker + '\r\n');
    for (let at = bytes.indexOf(delimiter); at >= 0;) {
      const start = at + delimiter.length;
      const headerEnd = bytes.indexOf('\r\n\r\n', start);
      if (headerEnd < 0) break;
      const header = bytes.toString('utf8', start, headerEnd);
      const field = /^content-disposition:\s*form-data;\s*name="([^"]+)"(?:;|$)/im.exec(header);
      if (!field) break;
      if (field[1] === 'file') {
        const identity = formIdentity(fields);
        const type = /^content-type:\s*([^\r\n;]+)/im.exec(header)?.[1]?.trim().toLowerCase();
        return identity ? { identity, type } : null;
      }
      const key = field[1].toLowerCase();
      const next = bytes.indexOf(delimiter, headerEnd + 4);
      if (next < 2) break;
      if (key === 'key' || key === 'policy') {
        if (fields[key] !== undefined) return null;
        fields[key] = bytes.toString('utf8', headerEnd + 4, next - 2);
      }
      at = next;
    }
    return null;
  } catch { return null; }
}

class UploadGrants {
  constructor() { this.records = new Map(); }

  async observe(input, response) {
    if (!response.ok) return;
    const type = input?.contentType || input?.mediaType;
    if (!isMediaMime(type)) return;
    const result = await smallJson(response);
    const data = result?.data || result;
    if (!data) return;
    this.remember('PUT', data.signedPutUrl, '', type);
    const fields = Object.fromEntries(Object.entries(data.fields || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const identity = formIdentity(fields);
    if (identity) this.remember('POST', data.signedUploadPostUrl, identity, type);
  }

  remember(method, address, identity, type) {
    const url = httpsUrl(address);
    if (!url || !uploadObject(url, method)) return;
    const key = method + ' ' + url.href + ' ' + identity;
    this.records.delete(key);
    this.records.set(key, { type: type.toLowerCase(), expires: Date.now() + 15 * 60 * 1000 });
    while (this.records.size > 128) this.records.delete(this.records.keys().next().value);
  }

  async matches(request) {
    if (!['PUT', 'POST'].includes(request.method) || !request.body || !workspaceRequest(request)) return false;
    const url = httpsUrl(request.url);
    if (!url || !uploadObject(url, request.method)) return false;
    const prefix = request.method + ' ' + url.href + ' ';
    const now = Date.now();
    if (request.method === 'PUT') {
      const type = (request.headers.get('content-type') || '').toLowerCase().split(';', 1)[0].trim();
      const record = this.records.get(prefix);
      return !!(record && record.expires > now && (!type || type === record.type || type === 'application/octet-stream') ||
        isMediaMime(type) && signedRead(url));
    }
    if (![...this.records].some(([key, record]) => key.startsWith(prefix) && record.expires > now)) return false;
    const form = await postedFormIdentity(request);
    const record = form && this.records.get(prefix + form.identity);
    return !!record && record.expires > now && (!form.type || form.type === record.type || form.type === 'application/octet-stream');
  }
}

module.exports = { mediaHosts, allowedHost, httpsUrl, isMediaMime, readRoute, videoRange, officialMediaSend, preparationRequest, smallJson, UploadGrants };
