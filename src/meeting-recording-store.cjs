const { randomUUID } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const editable = record => ['editor', 'owner'].includes(record?.role);
const s3 = host => /^(?:[a-z0-9.-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(host);
function fileUrl(value) {
  if (typeof value === 'string' && value.startsWith('attachment:')) {
    const parts = value.split(':');
    if (parts.length !== 3 || !uuid(parts[1]) || !/^[a-z\d_. -]{1,240}$/i.test(parts[2])) throw Error('会议录音附件标识无效。');
    return { url: value, fileId: uuid(parts[1]) };
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || !(s3(url.hostname) || /^(?:file|secure)\.notion\.(?:so|com)$/.test(url.hostname) || url.hostname === 'secure.notion-static.com')) throw Error('会议录音上传没有返回可长期引用的文件地址。');
  const fileId = url.pathname.split('/').map(part => { try { return uuid(decodeURIComponent(part)); } catch { return null; } }).filter(Boolean).at(-1);
  if (!fileId) throw Error('会议录音上传缺少可验证的文件标识。');
  return { url: url.href, fileId };
}
async function targetFor(store, meetingId, signal) {
  let record = await store.root(meetingId, signal);
  if (!editable(record) || !['transcription', 'meeting_note_page'].includes(record.value.type)) throw Error('会议录音目标不是可编辑的原生会议。');
  const meeting = record.value, seen = new Set([meetingId]);
  if (meeting.type === 'meeting_note_page') {
    const notesId = uuid(meeting.format?.transcription_notes_id);
    if (notesId && meeting.content?.includes(notesId)) {
      const notes = await store.root(notesId, signal);
      if (editable(notes) && uuid(notes.value.parent_id) === meetingId) return { pageId: notesId, spaceId: store.spaceId, userId: store.userId };
    }
    throw Error('会议页面缺少可编辑的笔记标签，音频保留在本机。');
  }
  for (let depth = 0; depth < 32; depth++) {
    const parent = uuid(record.value.parent_id);
    if (!parent || record.value.parent_table !== 'block') break;
    if (seen.has(parent)) throw Error('会议页面层级出现循环，未上传音频。');
    seen.add(parent); record = await store.root(parent, signal);
    if (!editable(record)) throw Error('当前账号无法修改会议所在页面。');
    if (['page', 'collection_view_page'].includes(record.value.type)) return { pageId: parent, spaceId: store.spaceId, userId: store.userId };
  }
  throw Error('无法确定会议所在页面，录音留在本机待重试。');
}
async function verifyAudio(store, target, plan, signal) {
  const records = await store.records([target.pageId, plan.id], signal), page = records.get(target.pageId), record = records.get(plan.id)?.value;
  if (record && (record.type !== 'audio' || record.parent_id !== target.pageId || record.space_id !== target.spaceId || record.properties?.source?.[0]?.[0] !== plan.url)) throw Error('会议录音目标已被其他内容占用，未覆盖。');
  return !!record && editable(page) && page.value.content?.includes(plan.id);
}
async function uploadAudio(store, target, filename, data, signal) {
  if (!/^meeting-[a-f\d-]+-\d+\.mp3$/.test(filename)) throw Error('会议录音上传文件名无效。');
  if (!Buffer.isBuffer(data) || !data.length || data.length > 4 * 1024 * 1024) throw Error('会议录音片段为空或超过保存大小。');
  const response = await store.api('getUploadSpaceFileUrl', { bucket: 'secure', name: filename, contentType: 'audio/mpeg',
    record: { table: 'block', id: target.pageId, spaceId: target.spaceId }, supportExtraHeaders: true, contentLength: data.length, spaceId: target.spaceId }, { signal, spaceId: target.spaceId });
  const result = response.data && response.type === 'success' ? response.data : response;
  const durable = fileUrl(result.url);
  const uploadUrl = new URL(result.type === 'POST' ? result.signedUploadPostUrl : result.signedPutUrl);
  if (!['POST', 'PUT'].includes(result.type) || uploadUrl.protocol !== 'https:' || uploadUrl.username || uploadUrl.password || !s3(uploadUrl.hostname)) throw Error('会议录音上传地址无效。');
  let body = data; const headers = { 'content-type': 'audio/mpeg' };
  const rawHeaders = (result.type === 'PUT' ? result.putHeaders : result.postHeaders) || {};
  if (!rawHeaders || typeof rawHeaders !== 'object') throw Error('会议录音上传头无效。');
  const uploadHeaders = Array.isArray(rawHeaders) ? rawHeaders : Object.entries(rawHeaders).map(([name, value]) => ({ name, value }));
  if (uploadHeaders.length > 40) throw Error('会议录音上传头无效。');
  for (const field of uploadHeaders) {
    if (typeof field?.name !== 'string' || !/^(?:x-amz-[a-z\d-]+|content-type|content-md5|content-length)$/i.test(field.name) || typeof field.value !== 'string' || /[\r\n]/.test(field.value)) throw Error('会议录音上传头无效。');
    if (field.name.toLowerCase() === 'content-length' && (result.type !== 'PUT' || Number(field.value) !== data.length)) throw Error('会议录音上传长度无效。');
    if (field.name.toLowerCase() !== 'content-length') headers[field.name.toLowerCase()] = field.value;
  }
  if (result.type === 'POST') {
    const fields = result.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > 40) throw Error('会议录音上传表单无效。');
    const boundary = 'NotionSwitch' + randomUUID().replaceAll('-', ''), parts = [];
    for (const [name, value] of Object.entries(fields)) {
      if (!/^[a-z\d_-]{1,100}$/i.test(name) || typeof value !== 'string' || value.length > 20000 || /[\r\n\0]/.test(value)) throw Error('会议录音上传表单无效。');
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`));
    body = Buffer.concat(parts); headers['content-type'] = 'multipart/form-data; boundary=' + boundary;
  }
  const uploaded = await store.uploadFetch(uploadUrl.href, { method: result.type, headers, body, signal });
  await uploaded.body?.cancel().catch(() => {});
  if (!uploaded.ok) throw Error('会议录音文件上传失败，音频保留在本机待重试。');
  return durable;
}
async function attachAudio(store, target, plan, signal, onSubmit) {
  if (await verifyAudio(store, target, plan, signal)) return;
  const page = await store.root(target.pageId, signal);
  if (!editable(page) || store.spaceId !== target.spaceId || store.userId !== target.userId) throw Error('会议录音保存的账号或工作区已变化。');
  const now = Date.now(), block = { id: plan.id, version: 0, type: 'audio', space_id: target.spaceId, alive: true,
    parent_table: 'block', parent_id: target.pageId, created_time: now, last_edited_time: now,
    created_by_table: 'notion_user', created_by_id: target.userId, last_edited_by_table: 'notion_user', last_edited_by_id: target.userId,
    properties: { source: [[plan.url]], title: [[plan.name]], caption: [[plan.caption]] }, file_ids: [plan.fileId] };
  const pointer = id => ({ table: 'block', id, spaceId: target.spaceId });
  const operations = [{ pointer: pointer(plan.id), command: 'set', path: [], args: block },
    { pointer: pointer(target.pageId), command: 'listAfter', path: ['content'], args: { id: plan.id, ...(page.value.content?.length ? { after: page.value.content.at(-1) } : {}) } }];
  onSubmit();
  await store.api('saveTransactionsFanout', { requestId: randomUUID(), transactions: [{ id: plan.transactionId, spaceId: target.spaceId, operations }] }, { signal, spaceId: target.spaceId });
}
module.exports = { targetFor, uploadAudio, verifyAudio, attachAudio, fileUrl };
