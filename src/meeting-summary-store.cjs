const { randomUUID, createHash } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const richText = value => Array.isArray(value) ? value.map(part => typeof part?.[0] === 'string' ? part[0] : '').join('') : '';
const textOf = block => block?.type === 'table_row' ? Object.values(block.properties || {}).map(richText).join(' | ') : richText(block?.properties?.title);
const fingerprint = snapshot => createHash('sha256').update(JSON.stringify([snapshot.notes, snapshot.transcript])).digest('hex');
function entry(value) {
  for (let n = 0; n < 3 && value && !value.value?.id; n++) value = value.value;
  return value?.value?.id ? value : null;
}
class NativeMeetingStore {
  constructor({ api, spaceId, userId }) { this.api = api; this.spaceId = uuid(spaceId); this.userId = uuid(userId); }
  async records(ids, signal) {
    const result = new Map(), unique = [...new Set(ids.map(uuid))];
    if (unique.some(id => !id) || unique.length > 1000) throw Error('会议记录范围无效或过大。');
    for (let at = 0; at < unique.length; at += 64) {
      const batch = unique.slice(at, at + 64);
      const payload = await this.api('getRecordValues', { requests: batch.map(id => ({ id, table: 'block', ...(this.spaceId ? { spaceId: this.spaceId } : {}) })) }, { signal, spaceId: this.spaceId });
      for (let i = 0; i < batch.length; i++) {
        const value = entry(payload.results?.[i] || payload.recordMap?.block?.[batch[i]]);
        if (!value) continue;
        const block = value.value;
        if (uuid(block.id) !== batch[i] || this.spaceId && uuid(block.space_id) !== this.spaceId) throw Error('会议记录不属于当前工作区，已停止。');
        if (block.alive !== false) result.set(batch[i], value);
      }
    }
    return result;
  }
  async root(id, signal) {
    const value = (await this.records([id], signal)).get(uuid(id));
    if (!value) throw Error('无法读取会议或页面，请确认当前 Notion 账号有权访问。');
    this.spaceId ||= uuid(value.value.space_id);
    if (!this.spaceId) throw Error('会议所属工作区无效。');
    return value;
  }
  async tree(id, signal, limit = 800) {
    let pending = [{ id: uuid(id), parent: null }]; const records = new Map();
    while (pending.length) {
      if (records.size + pending.length > limit) throw Error('会议内容过大，未提交不完整的摘要。');
      const batch = pending.splice(0, 64), values = await this.records(batch.map(p => p.id), signal);
      for (const request of batch) {
        const value = values.get(request.id), block = value?.value;
        if (!block || request.parent && uuid(block.parent_id) !== request.parent) throw Error('会议子记录不完整或父级已变化，请刷新后重试。');
        if (records.has(block.id)) throw Error('会议内容出现循环引用，已停止。');
        records.set(block.id, value);
        for (const child of block.content || []) pending.push({ id: uuid(child), parent: block.id });
      }
    }
    const lines = [];
    const visit = key => { const block = records.get(key).value; const text = textOf(block); if (text.trim()) lines.push(text); for (const child of block.content || []) visit(child); };
    visit(uuid(id));
    const text = lines.join('\n');
    if (text.length > 160000) throw Error('会议文字过长，未提交截断摘要。');
    return { text, records };
  }
  async load(meetingId, signal) {
    const meeting = await this.root(meetingId, signal), value = meeting.value;
    if (!['transcription', 'meeting_note_page'].includes(value.type)) throw Error('所选记录不是 Notion 原生会议速记。');
    if (!['editor', 'owner'].includes(meeting.role)) throw Error('当前账号没有编辑此会议的权限。');
    const transcriptId = uuid(value.format?.transcription_transcript_id), notesId = uuid(value.format?.transcription_notes_id);
    if (!transcriptId || transcriptId === notesId || !value.content?.includes(transcriptId) || notesId && !value.content.includes(notesId)) throw Error('会议没有有效的转录或笔记标签。');
    for (const id of [transcriptId, notesId].filter(Boolean)) {
      const tab = await this.root(id, signal);
      if (uuid(tab.value.parent_id) !== value.id) throw Error('会议标签不属于当前会议。');
    }
    const transcript = await this.tree(transcriptId, signal), notes = notesId ? await this.tree(notesId, signal) : { text: '' };
    if (!transcript.text.trim() && !notes.text.trim()) throw Error('会议尚无可总结的转录或笔记内容。');
    const snapshot = { meeting: value, role: meeting.role, notes: notes.text, transcript: transcript.text, spaceId: this.spaceId };
    snapshot.sourceHash = fingerprint(snapshot); return snapshot;
  }
  async template(selection, signal) {
    // Presets can live in another workspace. Read with the same account's
    // normal API access, in an isolated scope; never change the write store.
    const reader = new NativeMeetingStore({ api: this.api, spaceId: selection.space_id, userId: this.userId });
    return reader.tree(selection.page_id, signal);
  }
  async findMeetings(pageId, signal) {
    const page = await this.root(pageId, signal);
    if (['transcription', 'meeting_note_page'].includes(page.value.type)) return [page.value.id];
    const pending = (page.value.content || []).map(id => ({ id, parent: page.value.id })), result = [], seen = new Set(); let scanned = 0;
    while (pending.length) {
      const batch = pending.splice(0, 64);
      if ((scanned += batch.length) > 1000) throw Error('页面内容过多，请提供具体会议块的链接。');
      const values = await this.records(batch.map(r => r.id), signal);
      for (const { id, parent } of batch) {
        const value = values.get(id)?.value; if (!value) throw Error('页面内容尚未完整加载，请刷新后重试。');
        if (seen.has(id) || uuid(value.parent_id) !== parent) throw Error('页面会议范围不完整或出现循环，未执行写入。');
        seen.add(id);
        if (['transcription', 'meeting_note_page'].includes(value.type)) result.push(id);
        else if (!['page', 'collection_view_page', 'link_to_page'].includes(value.type)) pending.push(...(value.content || []).map(child => ({ id: child, parent: id })));
      }
    }
    return result;
  }
  plan(snapshot, tabId, markdown) {
    if (!this.userId || !uuid(tabId) || tabId === snapshot.meeting.id) throw Error('会议写回身份或目标无效。');
    const lines = markdown.trim().split(/\r?\n/).filter(line => line.trim()), children = [];
    for (const line of lines) {
      const heading = line.match(/^(#{1,3})\s+(.+)/), bullet = line.match(/^\s*[-*+]\s+(.+)/), numbered = line.match(/^\s*\d+[.)]\s+(.+)/);
      const type = heading ? ['header', 'sub_header', 'sub_sub_header'][heading[1].length - 1] : bullet ? 'bulleted_list' : numbered ? 'numbered_list' : 'text';
      const text = (heading?.[2] || bullet?.[1] || numbered?.[1] || line).trim();
      for (let at = 0; at < text.length; at += 1500) children.push({ id: randomUUID(), type, text: text.slice(at, at + 1500) });
    }
    if (!children.length || children.length > 100) throw Error('生成的会议笔记为空或过长，未写入页面。');
    const now = Date.now(), make = (id, parent, type) => ({ id, version: 0, type, space_id: this.spaceId,
      alive: true, parent_id: parent, parent_table: 'block', created_time: now, last_edited_time: now,
      created_by_table: 'notion_user', created_by_id: this.userId, last_edited_by_table: 'notion_user', last_edited_by_id: this.userId });
    const blocks = [ { ...make(tabId, snapshot.meeting.id, 'text'), properties: { title: [] }, content: children.map(c => c.id) },
      ...children.map(c => ({ ...make(c.id, tabId, c.type), properties: { title: [[c.text]] } })) ];
    return { tabId, meetingId: snapshot.meeting.id, spaceId: this.spaceId, blocks, transactionId: randomUUID() };
  }
  async verify(plan, signal) {
    const records = await this.records([plan.meetingId, ...plan.blocks.map(b => b.id)], signal);
    const meeting = records.get(plan.meetingId)?.value;
    const ok = meeting?.format?.transcription_summary_id === plan.tabId && meeting.content?.includes(plan.tabId) && plan.blocks.every(expected => {
      const actual = records.get(expected.id)?.value;
      return actual && actual.parent_id === expected.parent_id && actual.type === expected.type &&
        textOf(actual) === textOf(expected) && JSON.stringify(actual.content || []) === JSON.stringify(expected.content || []);
    });
    return { ok, rootReadable: !!meeting, linked: meeting?.format?.transcription_summary_id === plan.tabId,
      existingPlannedRecords: plan.blocks.filter(b => records.has(b.id)).length,
      recordMap: { __version__: 3, block: Object.fromEntries([...records].map(([id, value]) => [id, { spaceId: this.spaceId, value }])) } };
  }
  async submit(snapshot, plan, signal, onSubmit = () => {}) {
    signal?.throwIfAborted();
    if (plan.spaceId !== this.spaceId || plan.meetingId !== snapshot.meeting.id) throw Error('会议写回范围已变化。');
    const collisions = await this.records(plan.blocks.map(b => b.id), signal);
    if (collisions.size) throw Error('会议摘要目标已经存在，未覆盖现有内容。');
    const pointer = id => ({ table: 'block', id, spaceId: this.spaceId });
    const operations = plan.blocks.map(block => ({ pointer: pointer(block.id), path: [], command: 'set', args: block }));
    operations.push({ pointer: pointer(plan.meetingId), path: ['content'], command: 'listAfter', args: { id: plan.tabId, ...(snapshot.meeting.content?.length ? { after: snapshot.meeting.content.at(-1) } : {}) } },
      { pointer: pointer(plan.meetingId), path: ['format'], command: 'update', args: { transcription_summary_id: plan.tabId } });
    const payload = { requestId: randomUUID(), transactions: [{ id: plan.transactionId, spaceId: this.spaceId, operations }] };
    if (Buffer.byteLength(JSON.stringify(payload)) > 400000) throw Error('会议摘要写入请求过大，未提交。');
    signal?.throwIfAborted(); onSubmit();
    await this.api('saveTransactionsFanout', payload, { signal, spaceId: this.spaceId });
  }
}
module.exports = { NativeMeetingStore, textOf, fingerprint };
