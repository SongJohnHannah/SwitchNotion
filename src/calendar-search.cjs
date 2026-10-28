const { createHash } = require('node:crypto');
const { eventTime, range } = require('./native-calendar.cjs');
const fail = message => { throw Error('Notion 日历 ' + message); };
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
async function searchCalendar({ connection, scope, source, input }) {
  const selected = range({ time_min: input.time_min, time_max: input.time_max, time_zone: source.timeZone, ...(input.query !== undefined ? { query: input.query } : {}) });
  let cursor, count = 0, matched = 0, truncated = false, characters = 0; const cursors = new Set(), events = [], ids = new Map();
  for (let page = 0; page < 20; page++) {
    scope.signal?.throwIfAborted();
    const response = await connection.request(scope, 'getEvents', { queries: [{ provider: source.provider, accountId: source.accountId, calendarId: source.calendarId, timeMin: selected.min, timeMax: selected.max, singleEvents: true, showDeleted: false, userTimeZone: selected.zone, limit: 500, orderBy: 'startTime', ...(cursor ? { pageToken: cursor } : {}) }] });
    if (!Array.isArray(response) || response.length !== 1) fail('事件查询回包无效。');
    const group = response[0];
    if (!group || group.errorMessage || group.accountId !== source.accountId || group.calendarId !== source.calendarId || !Array.isArray(group.events)) fail('事件列表归属或读取权限无效。');
    for (const event of group.events) {
      if (++count > 10000 || !event || typeof event.id !== 'string' || !event.id || event.id.length > 1000) fail('事件列表无效或超过 10,000 条。');
      if (event.accountId !== undefined && event.accountId !== source.accountId || event.calendarId !== undefined && event.calendarId !== source.calendarId) fail('事件不属于所选日历，已停止读取。');
      const serialized = JSON.stringify(event); if (serialized.length > 128000) fail('单个事件资料过大，请缩小范围。');
      const revision = createHash('sha256').update(serialized).digest('hex');
      if (ids.has(event.id)) { if (ids.get(event.id) !== revision) fail('事件分页中同一记录发生变化。'); continue; } ids.set(event.id, revision);
      if (event.status === 'cancelled') continue;
      const a = eventTime(event.start?.date || event.start?.dateTime, selected.zone), b = eventTime(event.end?.date || event.end?.dateTime, selected.zone);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) fail('事件时间无法解析，未把列表当作完整结果。');
      if (a >= selected.max || b <= selected.min || selected.query && ![event.summary, event.location, event.description].some(value => typeof value === 'string' && value.toLowerCase().includes(selected.query))) continue;
      matched++; if (events.length >= 200) { truncated = true; continue; }
      const title = text(event.summary, 1000), location = text(event.location, 2000), description = text(event.description, 4000);
      if (title.length < (event.summary?.length || 0) || location.length < (event.location?.length || 0) || description.length < (event.description?.length || 0)) truncated = true;
      const value = { event_id: event.id, title, start: event.start, end: event.end, location, description, repeating: !!(event.recurrence?.length || event.recurringEventId), ...(event.htmlLink && /^https:\/\//.test(event.htmlLink) && event.htmlLink.length < 4000 ? { url: event.htmlLink } : {}) };
      characters += JSON.stringify(value).length; if (characters > 60000) { truncated = true; continue; } events.push(value);
    }
    if (group.hasMore === true && !group.pageToken) fail('事件分页未完整返回，未使用部分结果。');
    if (!group.pageToken) return { source: 'notion-calendar-connected', calendar: source.name, time_zone: selected.zone, time_min: input.time_min, time_max: input.time_max, events, matched, scanned: count, complete: !truncated, truncated, read_only: true, scope: '仅本次明确选择的当前账号已连接日历，含可读但不可写的日历；不查询其他人员账号或附件正文。' };
    if (typeof group.pageToken !== 'string' || group.pageToken.length > 4096 || cursors.has(group.pageToken)) fail('事件分页游标无效，未返回部分结果。');
    cursor = group.pageToken; cursors.add(cursor);
  }
  fail('事件超过 20 页，请缩小日期范围；未返回部分结果。');
}
module.exports = { searchCalendar };
