const english = /^[a-z][a-z '’-]+[a-z.!?]?$/i;
const letters = value => value.toUpperCase().replace(/[^A-Z]/g, '');
const numericLike = /(?:^|[^\p{L}\p{N}])(?:[0-9][0-9OIl]*[OIl][0-9OIl]*|[OIl]+[0-9][0-9OIl]*)(?=$|[^\p{L}\p{N}])/u;

function formatTimeline(entries) {
  const stamp = value => value.toFixed(1);
  return entries.map(({ text, spans, uncertain }) => {
    const times = spans.map(({ start, end }) => start === end ? stamp(start) : `${stamp(start)}–${stamp(end)}`).join('、');
    return `视频时间约 ${times} 秒：${text}${uncertain ? ' [待核实]' : ''}`;
  }).join('\n');
}

function addObservation(entry, index, time) {
  const last = entry.spans.at(-1);
  if (last?.index === index) return;
  if (last?.index === index - 1) { last.end = time; last.index = index; }
  else entry.spans.push({ start: time, end: time, index });
}

function organizeOcr(frames, texts, interval) {
  const raw = [], readings = new Map(), numbers = new Map();
  const lines = texts.map(text => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  const nearby = Math.max(1, Math.floor(2 / interval));
  for (const [index, value] of texts.entries()) {
    const text = value.trim(), time = frames[index].time;
    if (!text) continue;
    if (raw.at(-1)?.text !== text || raw.at(-1)?.spans.at(-1)?.index !== index - 1) raw.push({ text, spans: [] });
    addObservation(raw.at(-1), index, time);

    const current = lines[index];
    const neighbors = lines.slice(Math.max(0, index - nearby), index + nearby + 1);
    const complete = new Map();
    const continuations = new Map();
    const anchor = current.filter(line => /\p{Script=Han}{5}/u.test(line));
    const supportedWords = new Map();
    for (const neighbor of neighbors) {
      for (const line of new Set(neighbor)) {
        if (!english.test(line)) continue;
        complete.set(letters(line), line);
        if (/^[a-z]{5,}$/i.test(line) && anchor.some(item => neighbor.includes(item))) {
          const word = line.toUpperCase();
          supportedWords.set(word, (supportedWords.get(word) || 0) + 1);
        }
      }
      for (let start = 0; start < neighbor.length - 1; start++) {
        if (!english.test(neighbor[start])) continue;
        for (const length of [2, 3]) {
          const parts = neighbor.slice(start, start + length);
          if (parts.length !== length || parts.some(part => !english.test(part))) break;
          const key = parts.map(letters).join(''), layout = parts.map(part => letters(part).length).join('/');
          if (!continuations.has(key)) continuations.set(key, { text: parts.join(' '), length, layouts: new Set() });
          const observed = continuations.get(key);
          observed.layouts.add(layout);
          if (length < observed.length) { observed.text = parts.join(' '); observed.length = length; }
        }
      }
    }

    for (let position = 0; position < current.length; position++) {
      let line = current[position], uncertain = numericLike.test(line);
      if (english.test(line)) {
        for (const length of [3, 2]) {
          const parts = current.slice(position, position + length);
          if (parts.length !== length || parts.some(part => !english.test(part))) continue;
          const key = parts.map(letters).join(''), observed = continuations.get(key);
          const whole = complete.get(key) || (observed?.layouts.size > 1 ? observed.text : '');
          if (whole) { line = whole; position += length - 1; break; }
        }
      }
      if (/^[a-z]{5,}$/i.test(line)) {
        const word = line.toUpperCase();
        if ((supportedWords.get(word) || 0) < 2) {
          const matches = [...supportedWords].filter(([candidate, count]) => {
            if (count < 2 || candidate === word) return false;
            if (candidate.length === word.length + 1 && candidate.startsWith(word)) return true;
            if (candidate.length !== word.length) return false;
            const changes = [...word].map((letter, i) => letter === candidate[i] ? '' : letter + candidate[i]).filter(Boolean);
            return changes.length === 1 && /^(?:[OQD]{2}|[IL]{2}|[UV]{2})$/.test(changes[0]);
          });
          if (matches.length === 1) line = complete.get(matches[0][0]) || line;
          if (matches.length > 1) uncertain = true;
        }
      }

      const reading = /\p{Script=Han}/u.test(line) ? line.replace(/。$/u, '') : line;
      if (!readings.has(reading)) readings.set(reading, { text: line, spans: [], uncertain: false });
      const entry = readings.get(reading);
      addObservation(entry, index, time);
      entry.uncertain ||= uncertain;

      // Only compare explicit measurements with the same surrounding label. Keep both readings and their times.
      const key = line.replace(/\d+(?:[.,]\d+)?(?=\s*(?:%|px\b|fps\b|ms\b|秒|赫兹))/giu, '#');
      if (key !== line && key.replace(/[#%\s]/g, '').length >= 3) {
        const previous = numbers.get(key);
        if (previous && previous.entry !== entry && index - previous.index <= nearby) {
          entry.uncertain = previous.entry.uncertain = true;
        }
        numbers.set(key, { entry, index });
      }
    }
  }
  return { raw: formatTimeline(raw), cleaned: formatTimeline([...readings.values()]) };
}

module.exports = { organizeOcr };
