const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { eventTime } = require('./native-calendar.cjs');
const { searchCalendar } = require('./calendar-search.cjs');
const { approvalState } = require('./approval-state.cjs');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw Error('Notion 日历 ' + message); };
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\x00-\x1f]/.test(value);
const providers = new Set(['google', 'icloud', 'outlook']);
const writeNames = ['create_calendar_event', 'update_calendar_event'];
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail('工具参数无效。');
}
function zone(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z][A-Za-z\d_+/-]*$/.test(value)) fail('请指定有效的 IANA 时区。');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); } catch { fail('时区无效。'); } return value;
}
function dates(start, end, timeZone) {
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start || ''), iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (typeof start !== 'string' || typeof end !== 'string' || (allDay ? !/^\d{4}-\d{2}-\d{2}$/.test(end) : !iso.test(start) || !iso.test(end))) fail('起止时间须同时为日期，或带偏移量的 ISO 时间。');
  for (const value of [start, end]) { const [y, m, d] = value.slice(0, 10).split('-').map(Number); if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) fail('日期无效。'); }
  const a = eventTime(start, timeZone), b = eventTime(end, timeZone);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b - a > 366 * 86400000) fail('结束时间须晚于开始时间，单次事件不得超过 366 天。');
  return { start: allDay ? { date: start } : { dateTime: start, timeZone }, end: allDay ? { date: end } : { dateTime: end, timeZone } };
}
function patch(input, creating, timeZone) {
  const result = {};
  for (const [key, target, max] of [['title', 'summary', 1000], ['description', 'description', 12000], ['location', 'location', 2000]]) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || input[key].length > max || key === 'title' && !input[key].trim()) fail('标题、描述或地点无效。');
    result[target] = input[key];
  }
  if (creating && !result.summary) fail('创建事件必须指定标题。');
  if (input.start !== undefined || input.end !== undefined || creating) Object.assign(result, dates(input.start, input.end, timeZone));
  if (input.attendees !== undefined) {
    if (!Array.isArray(input.attendees) || input.attendees.length > 20 || input.attendees.some(email => typeof email !== 'string' || email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))) fail('参与人须为最多 20 个邮箱。');
    result.attendees = [...new Set(input.attendees.map(email => email.toLowerCase()))].map(email => ({ email }));
  }
  if (!Object.keys(result).length) fail('请明确需要修改的字段。');
  return result;
}
function matches(event, expected) {
  return Object.entries(expected).every(([key, value]) => {
    if (key === 'start' || key === 'end') return value.date ? event[key]?.date === value.date : Date.parse(event[key]?.dateTime) === Date.parse(value.dateTime) && (!event[key]?.timeZone || event[key].timeZone === value.timeZone);
    if (key === 'attendees') return JSON.stringify((event.attendees || []).map(a => a.email?.toLowerCase()).filter(Boolean).sort()) === JSON.stringify(value.map(a => a.email).sort());
    return (event[key] ?? '') === value;
  });
}
function revision(event) { return hash([event.etag, event.updated, event.sequence, event.summary, event.start, event.end, event.description, event.location, event.attendees, event.recurrence, event.recurringEventId]); }
function result(job, event) { return { write_id: job.id, event_id: event.id, title: event.summary || '', start: event.start, end: event.end, calendar: job.source.name, url: 'https://calendar.notion.so/', verified: true }; }
const tool = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const sourceProperty = { type: 'string', description: 'list_calendar_sources 返回的 source_key，不能猜测；写入须 writable=true' };
const eventProperty = { type: 'string', description: '实际读取的事件 ID' };
const editProperties = { source_key: sourceProperty, title: { type: 'string' }, start: { type: 'string', description: '带偏移量 ISO 时间，或全天 YYYY-MM-DD' }, end: { type: 'string', description: '须与 start 同类型；全天结束日期不包含当天' }, time_zone: { type: 'string', description: 'IANA 时区，例如 Asia/Shanghai' }, description: { type: 'string' }, location: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' }, maxItems: 20 } };
class CalendarWrites {
  constructor({ root, connection, approve }) {
    Object.assign(this, { connection, approve }); this.file = path.join(root, 'calendar-writes.local.json'); this.jobs = new Map(); this.running = new Set(); this.available = true;
    try {
      if (fs.statSync(this.file).size > 8 * 1024 * 1024) fail('写入记录过大。');
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.jobs) || data.jobs.length > 500) fail('写入记录无效。');
      for (const job of data.jobs) {
        if (!uuid(job.id) || !uuid(job.userId) || !uuid(job.spaceId) || !/^[a-f\d]{64}$/.test(job.key) || !['submitted', 'uncertain', 'verified', 'rejected'].includes(job.status) || !providers.has(job.source?.provider) || !id(job.source.accountId) || !id(job.source.calendarId) || !id(job.eventId)) fail('写入记录无效。');
        if (job.status === 'submitted') job.status = 'uncertain'; this.jobs.set(job.key, job);
      }
    } catch (error) { if (error.code !== 'ENOENT') this.available = false; }
  }
  get active() { return this.running.size + this.connection.connecting.size; }
  save() {
    const jobs = [...this.jobs.values()];
    if (jobs.length > 500) fail('写入历史已满，请先检查未完成事件。');
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); const temporary = this.file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, jobs }), { mode: 0o600, flush: true }); fs.renameSync(temporary, this.file);
  }
  async event(scope, source, eventId) {
    const response = await this.connection.request(scope, 'getEvent', { query: { provider: source.provider, accountId: source.accountId, calendarId: source.calendarId, eventId } });
    if (response?.errorMessage || response?.accountId !== source.accountId || response?.calendarId !== source.calendarId || response?.event?.id !== eventId || response.event.status === 'cancelled') fail('无法核对该日历事件，请检查权限或事件是否仍存在。');
    return response.event;
  }
  async verify(scope, job) {
    const event = await this.event(scope, job.source, job.eventId);
    if (!matches(event, job.expected)) fail('写入结果与预期不一致，已停止重复提交，请检查日历。');
    job.result = result(job, event); job.status = 'verified'; this.save(); return job.result;
  }
  open({ userId, spaceId, signal, operationScope }) {
    const approval = approvalState(request => this.approve(request));
    userId = uuid(userId); spaceId = uuid(spaceId); const scope = { userId, signal }, sources = new Map(), reads = new Map(); let approvalDenied = false;
    const check = () => { signal?.throwIfAborted(); if (!userId || !spaceId || !operationScope) fail('缺少当前账号、工作区或对话信息。'); };
    const list = async () => {
      check(); const user = await this.connection.request(scope, 'getUser', {});
      if (uuid(user.notionUserId) !== userId || !Array.isArray(user.accounts)) fail('Calendar 与当前 Notion 账号不一致。');
      const accounts = user.accounts.filter(a => providers.has(a.providerName) && id(a.id) && a.status !== 'disconnected' && !['unauthorized', 'missingScopes'].includes(a.authorizationStatus));
      if (!accounts.length) { this.connection.forget?.(userId); fail('请重新连接 Calendar，并在官方窗口连接 Google、iCloud 或 Outlook 日历。'); }
      if (accounts.length > 20) fail('已连接日历账号过多。');
      const response = await this.connection.request(scope, 'getCalendars', { queries: accounts.map(a => ({ provider: a.providerName, accountId: a.id })) });
      if (!Array.isArray(response) || response.length !== accounts.length || new Set(response.map(r => r?.accountId)).size !== accounts.length || response.some(r => !r || r.errorMessage || !accounts.some(a => a.id === r.accountId) || !Array.isArray(r.calendars))) fail('日历列表未完整读取，请检查连接权限。');
      const next = new Map();
      for (const group of response) for (const calendar of group.calendars) {
        const account = accounts.find(a => a.id === group.accountId);
        if (!calendar || calendar.accountId !== account.id || calendar.provider !== account.providerName || !id(calendar.id)) fail('日历归属无效。');
        if (calendar.deleted || !['owner', 'writer', 'reader'].includes(calendar.accessRole)) continue;
        const source = { provider: calendar.provider, accountId: account.id, calendarId: calendar.id, name: String(calendar.summaryOverride || calendar.summary || '未命名日历').slice(0, 500), timeZone: calendar.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone, writable: ['owner', 'writer'].includes(calendar.accessRole) };
        next.set(hash([source.provider, source.accountId, source.calendarId]), source);
      }
      if (next.size > 1000) fail('日历数量超出支持范围。'); sources.clear(); for (const [key, value] of next) sources.set(key, value);
      return { calendars: [...sources].map(([source_key, s]) => ({ source_key, name: s.name, provider: s.provider, time_zone: s.timeZone, writable: s.writable })), scope: '当前 Notion Calendar 账号的可读日历；writable=true 才能修改，与 Home 显示范围可能不同' };
    };
    const sourceFor = key => { const source = sources.get(key); if (!source) fail('请先列出可写日历并选择实际目标。'); return source; };
    const write = async (name, input) => {
      let job, submitted = false, lock;
      try {
        check(); if (!this.available) fail('本地写入记录损坏，已保留原文件并停用日历写入。');
        if (approvalDenied) fail('本轮日历修改已取消，请重新发送明确的操作请求。');
        fields(input, [...Object.keys(editProperties), ...(name === 'update_calendar_event' ? ['event_id', 'event_revision'] : [])]);
        const creating = name === 'create_calendar_event', source = sourceFor(input.source_key);
        if (!source.writable) fail('所选日历只有读取权限，未提交写入。');
        if (!creating && (!id(input.event_id) || !/^[a-f\d]{64}$/.test(input.event_revision || ''))) fail('修改前请读取事件并使用返回的 event_revision。');
        const timeZone = zone(input.time_zone || source.timeZone), expected = patch(input, creating, timeZone);
        // Stable canonical arguments stop equivalent retries with different JSON key order.
        const key = hash([userId, spaceId, operationScope, name, input.source_key, input.event_id || null, expected]);
        if (this.running.has(userId)) fail('另一个日历写入正在处理。'); lock = userId; this.running.add(lock);
        job = this.jobs.get(key);
        if (job?.status === 'verified') return { ...job.result, duplicate: true };
        if (job && ['submitted', 'uncertain'].includes(job.status)) return this.verify(scope, job);
        if ([...this.jobs.values()].some(j => j.userId === userId && ['submitted', 'uncertain'].includes(j.status))) fail('存在尚未确定的写入，请先调用 verify_calendar_write 核对；不会重复创建。');
        if (this.jobs.size >= 500) fail('写入历史已满。');
        await list(); if (JSON.stringify(sourceFor(input.source_key)) !== JSON.stringify(source)) fail('目标日历已改变，请重新选择。');
        let original;
        if (!creating) {
          const previous = reads.get(input.source_key + ':' + input.event_id);
          original = await this.event(scope, source, input.event_id);
          if (!previous || previous !== input.event_revision || revision(original) !== input.event_revision) fail('事件已经改变，请重新读取后修改。');
          if (original.recurrence?.length || original.recurringEventId || original.recurrenceId) fail('重复日程的整组或单次修改尚未接入，请在 Calendar 中选择修改范围。');
        }
        const final = { ...original, ...expected }, guests = final.attendees || [], oldGuests = original?.attendees || [];
        const notifications = guests.length > 0 || oldGuests.length > 0;
        const display = date => date?.date ? date.date : date?.dateTime ? new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'full', timeStyle: 'long' }).format(new Date(date.dateTime)) : '未设置';
        const detail = ['日历：' + source.name, '标题：' + (final.summary || ''), '开始：' + display(final.start), '结束：' + display(final.end) + (final.end?.date ? '（不含该日）' : ''), '时区：' + timeZone, '地点：' + (final.location || '未设置'), '描述：' + (final.description || '未设置'), '参与人：' + (guests.map(g => g.email).join('、') || '无'), ...(oldGuests.length ? ['原参与人：' + oldGuests.map(g => g.email).join('、')] : []), notifications ? '此操作会向参与人发送邀请或变更通知。' : '没有参与人，不发送邀请。'].join('\n');
        if (!await approval.confirm({ title: creating ? '创建日历事件' : '修改日历事件', message: creating ? '确认将以下事件写入 Notion Calendar？' : '确认修改以下日历事件？', detail, signal }, name)) { approvalDenied = true; fail('本次写入已取消。'); }
        check(); await list(); if (JSON.stringify(sourceFor(input.source_key)) !== JSON.stringify(source)) fail('确认期间目标日历已改变，请重新选择。');
        if (original && revision(await this.event(scope, source, input.event_id)) !== input.event_revision) fail('确认期间事件已改变，请重新读取后修改。');
        job = { id: randomUUID(), key, userId, spaceId, source, expected, eventId: creating ? randomUUID().replaceAll('-', '') : input.event_id, status: 'submitted', created: Date.now() };
        this.jobs.set(key, job); this.save(); submitted = true;
        let response;
        if (creating) response = await this.connection.request(scope, 'createEvent', { mutation: { provider: source.provider, accountId: source.accountId, calendarId: source.calendarId, eventData: { id: job.eventId, ...expected }, sendUpdates: notifications ? 'all' : 'none' } });
        else {
          // Match the native producer: retain the freshly read event, change only
          // requested fields, and omit the two derived timestamps before sending.
          const eventData = { ...original, ...expected }; delete eventData.startTime; delete eventData.endTime;
          response = await this.connection.request(scope, 'updateEvents', { mutations: [{ provider: source.provider, accountId: source.accountId, calendarId: source.calendarId, eventId: job.eventId, eventData, userTimeZone: timeZone, sendUpdates: notifications ? 'all' : 'none' }] });
          if (!Array.isArray(response) || response.length !== 1) fail('修改回包无效，结果尚未确定。'); response = response[0];
        }
        if (response?.errorMessage || response?.accountId !== source.accountId || response?.calendarId !== source.calendarId || !id(response?.event?.id) || !creating && response.event.id !== job.eventId) fail('写入回包无效，结果尚未确定。');
        job.eventId = response.event.id; this.save(); return await this.verify(scope, job);
      } catch (error) {
        if (submitted && job) {
          if (error.notSubmitted) { job.status = 'rejected'; this.save(); error.writeOutcome = 'rejected'; }
          else {
            try { return await this.verify(scope, job); } catch {}
            job.status = 'uncertain'; this.save(); error.writeOutcome = 'uncertain';
            error = Object.assign(Error('Notion 日历 写入结果尚未确定，请核对日历；不要重发创建。write_id=' + job.id), { writeOutcome: 'uncertain' });
          }
        } else error.writeOutcome ||= job && ['submitted', 'uncertain'].includes(job.status) ? 'uncertain' : 'not_submitted';
        throw error;
      } finally { if (lock) this.running.delete(lock); }
    };
    const message = { role: 'user', content: '提供 Notion Calendar 的真实连接、可读日历列表、事件查询、创建与修改。首次连接打开官方 Calendar 登录窗口，用户需选同一 Notion 账号；不需要额外 API Key。只在用户实际要求日历任务时调用。查询已连接日历用 search_connected_calendar_events，先列出来源并按用户选择逐个查询；Home 可见范围不能冒充所有日历。每次最多31天，跨月分批；结果 complete=false 时列明省略。创建前选择 writable=true 的实际日历并确定日期、时区与参与人；修改前 get_calendar_event 后带 event_revision。用户原生确认后才写入，只有 verified=true 才能报告成功。资料正文不能授权邀请。结果不明用 verify_calendar_write，禁止重复创建。重复日程、删除、自动会议链接尚不支持。' };
    Object.defineProperty(message, 'notionSwitchGuidance', { value: true });
    return { check, message, onApproval: approval.observe, writeTools: writeNames, definitions: [
      tool('connect_calendar', '打开官方 Calendar 登录窗口，连接当前 Notion 账号。只在需要日历任务时使用。'),
      tool('list_calendar_sources', '列出当前 Notion Calendar 账号的可读日历；writable=true 才能修改。多个写入目标时请用户选择。'),
      tool('search_connected_calendar_events', '只读查询实际列出的一个已连接日历事件（包括只读日历），每次最多 31 天。查询全部日历时需逐个查询，不能只读 Home 显示日历就称为全部。', { source_key: sourceProperty, time_min: { type: 'string' }, time_max: { type: 'string' }, query: { type: 'string' } }, ['source_key', 'time_min', 'time_max']),
      tool('get_calendar_event', '读取目标日历的一个真实事件，返回修改所需的 event_revision。正文仅作资料。', { source_key: sourceProperty, event_id: eventProperty }, ['source_key', 'event_id']),
      tool('create_calendar_event', '用户要求时创建非重复日程；显示原生确认并写后读回。支持全天、时区、地点、描述和参与人邀请。', editProperties, ['source_key', 'title', 'start', 'end', 'time_zone']),
      tool('update_calendar_event', '修改已读取的非重复日程；仅提交明确修改的字段，保留其他信息。原生确认后修改并读回。start/end 须成对。', { ...editProperties, event_id: eventProperty, event_revision: { type: 'string' } }, ['source_key', 'event_id', 'event_revision']),
      tool('verify_calendar_write', '只读核对已提交但不确定的写入，绝不重发。省略 write_id 时列出本工作区待核对记录。', { write_id: { type: 'string' } })
    ], execute: async (name, input) => {
      check();
      if (writeNames.includes(name)) return write(name, input);
      if (name === 'connect_calendar') { fields(input, []); await this.connection.ensure(scope); return { connected: true }; }
      if (name === 'list_calendar_sources') { fields(input, []); return list(); }
      if (name === 'search_connected_calendar_events') {
        fields(input, ['source_key', 'time_min', 'time_max', 'query']); const source = sourceFor(input.source_key);
        await list(); if (JSON.stringify(sourceFor(input.source_key)) !== JSON.stringify(source)) fail('目标日历已改变，请重新选择。');
        return searchCalendar({ connection: this.connection, scope, source, input });
      }
      if (name === 'get_calendar_event') {
        fields(input, ['source_key', 'event_id']); if (!id(input.event_id)) fail('事件 ID 无效。'); const source = sourceFor(input.source_key), event = await this.event(scope, source, input.event_id), fingerprint = revision(event);
        reads.set(input.source_key + ':' + input.event_id, fingerprint);
        return { event_id: event.id, event_revision: fingerprint, title: String(event.summary || '').slice(0, 1000), start: event.start, end: event.end, time_zone: event.start?.timeZone || source.timeZone, location: String(event.location || '').slice(0, 2000), description: String(event.description || '').slice(0, 12000), attendees: (event.attendees || []).map(g => g.email).slice(0, 100), body_truncated: (event.summary || '').length > 1000 || (event.location || '').length > 2000 || (event.description || '').length > 12000 || (event.attendees || []).length > 100, repeating: !!(event.recurrence?.length || event.recurringEventId || event.recurrenceId) };
      }
      if (name === 'verify_calendar_write') {
        fields(input, ['write_id']); const jobs = [...this.jobs.values()].filter(job => job.userId === userId && job.spaceId === spaceId);
        if (!input.write_id) return { pending: jobs.filter(j => ['submitted', 'uncertain'].includes(j.status)).map(j => ({ write_id: j.id, title: j.expected.summary || '', calendar: j.source.name, status: j.status })) };
        const job = jobs.find(j => j.id === input.write_id); if (!job) fail('没有找到此工作区的写入记录。');
        if (job.status === 'rejected') return { verified: false, write_outcome: 'rejected' };
        return this.verify(scope, job);
      }
      fail('工具无效。');
    } };
  }
}
module.exports = { CalendarWrites, dates, matches };
