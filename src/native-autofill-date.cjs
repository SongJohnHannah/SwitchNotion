const fail = () => { throw Error('Notion Autofill 日期须为有效的 {start,end?,time_zone?}；时间须包含偏移量和 IANA 时区，范围结束不能早于开始。'); };
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function dateProperty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['start', 'end', 'time_zone'].includes(key))) fail();
  const { start, end, time_zone: zone } = value;
  let native;
  if (validDate(start)) {
    if (zone != null || end != null && (!validDate(end) || end < start)) fail();
    native = { type: end == null ? 'date' : 'daterange', start_date: start, ...(end != null ? { end_date: end } : {}) };
  } else {
    if (typeof zone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(zone) || zone.length > 100) fail();
    let formatter;
    try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); } catch { fail(); }
    const instant = input => {
      if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::00)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(input) || !validDate(input.slice(0, 10))) fail();
      const time = Date.parse(input); if (!Number.isFinite(time)) fail();
      const parts = Object.fromEntries(formatter.formatToParts(time).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
      const date = `${parts.year}-${parts.month}-${parts.day}`, clock = `${parts.hour}:${parts.minute}`;
      // Require the explicit offset to agree with the supplied zone; this also
      // rejects nonexistent local times at a DST transition.
      if (input.slice(0, 10) !== date || input.slice(11, 16) !== clock) fail();
      return { time, date, clock };
    };
    const first = instant(start), last = end == null ? null : instant(end);
    if (last && last.time < first.time) fail();
    // The native date payload has no offset selector for repeated DST hours.
    // Reject ambiguous local wall times rather than silently shifting a date.
    for (const point of [first, last].filter(Boolean)) {
      const wall = formatter.format(point.time);
      const localTime = time => {
        const p = Object.fromEntries(formatter.formatToParts(time).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
        return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      };
      const offset = localTime(point.time) - point.time;
      for (const distance of [-2, -1, 1, 2]) {
        const nearby = point.time + distance * 86400000, other = point.time + offset - (localTime(nearby) - nearby);
        if (other !== point.time && formatter.format(other) === wall) fail();
      }
    }
    native = { type: last ? 'datetimerange' : 'datetime', start_date: first.date, start_time: first.clock, ...(last ? { end_date: last.date, end_time: last.clock } : {}), time_zone: zone };
  }
  return [['‣', [['d', native]]]];
}
function sourceDate(value) {
  const annotations = Array.isArray(value) && value.length === 1 && value[0]?.[1];
  const date = Array.isArray(annotations) && annotations.find(annotation => annotation?.[0] === 'd')?.[1];
  if (!date || typeof date !== 'object' || !['date', 'daterange', 'datetime', 'datetimerange'].includes(date.type)) return null;
  return Object.fromEntries(['type', 'start_date', 'end_date', 'start_time', 'end_time', 'time_zone'].filter(key => typeof date[key] === 'string').map(key => [key, date[key]]));
}
module.exports = { dateProperty, sourceDate };
