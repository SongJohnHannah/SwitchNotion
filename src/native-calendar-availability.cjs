const fail = message => { throw Error('Notion 日历 ' + message); };
const minute = 60000, day = 86400000;
const properties = {
  duration_minutes: { type: 'integer', minimum: 5, maximum: 480, description: '每次会议所需分钟数' },
  step_minutes: { type: 'integer', minimum: 5, maximum: 120, description: '候选开始时间的间隔，默认 30 分钟' },
  working_start: { type: 'string', description: '所选时区的每日开始时间 HH:mm，默认 09:00' },
  working_end: { type: 'string', description: '所选时区的每日结束时间 HH:mm，默认 18:00；24:00 表示次日零点' },
  weekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, minItems: 1, maxItems: 7, description: '星期一至星期日为 1 至 7，默认周一至周五' },
  limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回候选时间数，默认 20' }
};
function options(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['time_min', 'time_max', 'time_zone', ...Object.keys(properties)].includes(key))) fail('空闲时间参数无效，不能按关键词筛掉占用时间。');
  const integer = (key, fallback) => {
    const value = input[key] === undefined ? fallback : input[key], schema = properties[key];
    if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) fail('空闲时间的 ' + key + ' 超出范围。');
    return value;
  };
  const clock = (key, fallback, allowMidnight) => {
    const value = input[key] === undefined ? fallback : input[key];
    if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) && !(allowMidnight && value === '24:00')) fail('工作时间须为 HH:mm。');
    return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  };
  const start = clock('working_start', '09:00', false), end = clock('working_end', '18:00', true);
  if (end <= start) fail('每日结束时间须晚于开始时间，跨夜范围请按日期拆分。');
  const weekdays = input.weekdays === undefined ? [1, 2, 3, 4, 5] : input.weekdays;
  if (!Array.isArray(weekdays) || !weekdays.length || weekdays.length > 7 || weekdays.some(value => !Number.isInteger(value) || value < 1 || value > 7) || new Set(weekdays).size !== weekdays.length) fail('星期须为不重复的 1 至 7。');
  return { duration: integer('duration_minutes'), step: integer('step_minutes', 30), limit: integer('limit', 20), start, end, weekdays };
}
function findAvailability(selected, config, busy, now) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: selected.zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const wall = time => {
    const parts = Object.fromEntries(formatter.formatToParts(time).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  };
  const zoned = value => {
    let time = value;
    for (let count = 0; count < 5; count++) time += value - wall(time);
    if (wall(time) !== value) fail('所选工作时间落在夏令时跳转的不存在时刻，请调整工作时间。');
    return time;
  };
  const first = Math.floor(wall(selected.min) / day) * day, last = Math.floor(wall(selected.max - 1) / day) * day;
  const intervals = busy.map(([start, end]) => [Math.max(start, selected.min), Math.min(end, selected.max)]).filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const prior = merged.at(-1);
    if (prior && interval[0] <= prior[1]) prior[1] = Math.max(prior[1], interval[1]);
    else merged.push(interval);
  }
  const slots = []; let matched = 0;
  for (let date = first; date <= last; date += day) {
    if (!config.weekdays.includes(new Date(date).getUTCDay() || 7)) continue;
    const start = zoned(date + config.start * minute), end = zoned(date + config.end * minute);
    for (let time = start; time + config.duration * minute <= Math.min(end, selected.max); time += config.step * minute) {
      if (time < selected.min || time < now) continue;
      const stop = time + config.duration * minute;
      // Check local boundaries again across DST transitions, including repeated hours.
      if (wall(time) < date + config.start * minute || wall(stop) > date + config.end * minute) continue;
      if (merged.some(([busyStart, busyEnd]) => time < busyEnd && stop > busyStart)) continue;
      matched++;
      if (slots.length < config.limit) slots.push({ start: new Date(time).toISOString(), end: new Date(stop).toISOString(), local_start: formatter.format(time), local_end: formatter.format(stop) });
    }
  }
  return { slots, matched, slot_limit_reached: matched > slots.length, duration_minutes: config.duration, step_minutes: config.step, weekdays: config.weekdays, working_start: String(Math.floor(config.start / 60)).padStart(2, '0') + ':' + String(config.start % 60).padStart(2, '0'), working_end: String(Math.floor(config.end / 60)).padStart(2, '0') + ':' + String(config.end % 60).padStart(2, '0'), busy_intervals: merged.length };
}
module.exports = { availabilityProperties: properties, availabilityOptions: options, findAvailability };
