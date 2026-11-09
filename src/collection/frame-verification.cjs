const timing = /(?:视频时间(?:约)?\s*|^\s*\*{0,2}关键帧\s*\d+\s*[（(·｜|]\s*)(\d+(?:\.\d+)?)(?:\s*[–—~-]\s*\d+(?:\.\d+)?)?\s*秒/u;
const groupName = /^(?:(?:高|中等?|低)(?:效用|风险|优先级|等级|组|档|类)|(?:[A-Fa-f]|第?[一二三四五六1-6])(?:组|档|类|级))$/u;
const chartContext = /柱状图|柱体|柱底|柱下|柱组|分组图|图表/u;
const groupContext = /分组|组别|归属|各组|三档|高效用|中等效用|低效用/u;
const unreadable = '读不清|看不清|不清晰|(?:难以|无法|不能|不易)辨认|不可辨|难辨|模糊|极暗|较暗|低对比|遮挡|重叠';
const blurred = new RegExp(`(?:文字|字迹|标签|卡片|卡的|卡内|右卡|左卡|字幕|内容区|主体内容|画面细节|对比度).{0,36}(?:${unreadable})`, 'u');
const blurredRight = new RegExp(`右卡.{0,30}(?:${unreadable})`, 'u');
const ordinal = /^第\s*[一二三四五六七八九十\d]+(?:步)?\s*[，、：:]/u;
const canonical = text => text.normalize('NFKC').replace(/[\s\p{P}]/gu, '').toLowerCase();
const textSignature = text => text.normalize('NFKC').replace(/\s/gu, '');
const xOf = line => (line.left + line.right) / 2;
const yOf = line => (line.top + line.bottom) / 2;
const usable = line => line.confidence === null || line.confidence >= .7;

function blocks(text) {
  const parts = [];
  for (const line of (text || '').split(/\r?\n/)) {
    const marker = line.match(timing);
    if (marker) parts.push({ time: Number(marker[1]), lines: [line.slice(marker.index + marker[0].length).replace(/^[：:）)\s*]+/u, '')] });
    else parts.at(-1)?.lines.push(line);
  }
  return parts;
}

function verificationTargets({ ocr, vision, duration }) {
  const targets = [];
  const add = (time, kind, right = false) => {
    if (!(time >= 0 && time < duration) || targets.some(item => item.kind === kind && Math.abs(item.time - time) <= (kind === 'chart' ? 12 : 3))) return;
    targets.push({ time, kind, right });
  };
  for (const { time, lines } of blocks(vision)) {
    const text = lines.join('\n');
    if (chartContext.test(text) && groupContext.test(text)) add(time, 'chart');
    if (lines.some(line => blurred.test(line) && !/缓动|转场|过渡方式|动效|运镜/u.test(line)) && (!chartContext.test(text) || /右卡|左卡|卡片|字幕/u.test(text)))
      add(time, 'text', blurredRight.test(text));
  }
  const seenOrdinals = new Set([...String(ocr || '').matchAll(/第\s*([一二三四五六七八九十\d]+)(?:步)?\s*[，、：:]/gu)].map(match => match[1]));
  for (const { time, lines } of blocks(ocr)) {
    if (new Set(lines.map(canonical).filter(line => groupName.test(line))).size >= 2) add(time, 'chart');
    if (lines.some(line => /\[OCR待核实(?:[：:\]]|$)|字迹不清|文字模糊/u.test(line))) add(time, 'text');
    const total = lines.map(line => line.trim()).find(line => /^(?:共)?[二三四五六七八九十2-9]步$/u.test(line));
    if (total && seenOrdinals.size < ('零一二三四五六七八九十'.indexOf(total.at(-2)) > 0 ? '零一二三四五六七八九十'.indexOf(total.at(-2)) : Number(total.at(-2)))) add(time, 'text');
  }
  return targets.slice(0, 4).sort((a, b) => a.time - b.time).map(target => ({ ...target,
    times: [...new Set([-1, .5, 2, 3, 4, 7, 8].map(delta => Math.round(Math.min(duration - .05, Math.max(0, target.time + delta)) * 100) / 100))] }));
}

function mergeLabelLines(rows) {
  const labels = [];
  for (const row of rows.sort((a, b) => xOf(a) - xOf(b))) {
    const last = labels.at(-1);
    if (last && Math.abs(xOf(row) - last.x) <= .021) last.rows.push(row);
    else labels.push({ x: xOf(row), rows: [row] });
  }
  return labels.map(({ x, rows: lines }) => ({ x, name: lines.sort((a, b) => yOf(a) - yOf(b)).reduce((text, line) =>
    text + (/[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(line.text) ? ' ' : '') + line.text, '') }));
}

function chartLayout(lines) {
  const headers = lines.filter(line => usable(line) && groupName.test(canonical(line.text))).sort((a, b) => xOf(a) - xOf(b));
  if (headers.length < 2 || headers.length > 6 || new Set(headers.map(line => canonical(line.text))).size !== headers.length ||
      headers.some((line, index) => index && xOf(line) - xOf(headers[index - 1]) < .08)) return null;
  const below = Math.max(...headers.map(line => line.bottom));
  const rows = lines.filter(line => usable(line) && line.top > below + .025 && line.right - line.left < .15 && canonical(line.text).length >= 2 && canonical(line.text).length <= 16 && !/^\d+$/u.test(canonical(line.text)));
  const bands = rows.map(row => mergeLabelLines(rows.filter(line => Math.abs(yOf(line) - yOf(row)) <= .06)));
  const labels = bands.sort((a, b) => b.length - a.length)[0] || [];
  if (labels.length < headers.length + 2 || labels.length > 32 || new Set(labels.map(label => canonical(label.name))).size !== labels.length) return null;
  const gaps = labels.slice(1).map((label, index) => ({ index: index + 1, width: label.x - labels[index].x }));
  const ranked = [...gaps].sort((a, b) => b.width - a.width);
  const breaks = ranked.slice(0, headers.length - 1);
  const largestInternal = ranked[headers.length - 1]?.width;
  if (breaks.at(-1).width < Math.max(.04, largestInternal * 1.22)) return null;
  const bounds = [0, ...breaks.map(gap => gap.index).sort((a, b) => a - b), labels.length];
  const groups = headers.map((header, index) => {
    const items = labels.slice(bounds[index], bounds[index + 1]);
    const x = xOf(header);
    if (!items.length || x < items[0].x - .07 || x > items.at(-1).x + .07) return null;
    return { name: header.text.replace(/\s+/gu, ''), items: items.map(label => label.name) };
  });
  return groups.every(Boolean) ? groups : null;
}

const groupSignature = groups => JSON.stringify(groups.map(group => [canonical(group.name), group.items.map(canonical)]));
const seconds = time => time.toFixed(1);
function checkWindow(target, samples) {
  if (target.kind === 'chart') {
    const seen = new Map();
    for (const sample of samples) {
      const groups = chartLayout(sample.lines);
      if (!groups) continue;
      const key = groupSignature(groups);
      if (!seen.has(key)) seen.set(key, { groups, times: [] });
      seen.get(key).times.push(sample.time);
    }
    const verified = [...seen.values()].filter(group => group.times.length >= 2);
    return verified.length === 1 ? { chart: verified[0] } : {};
  }
  const candidates = samples.flatMap(({ lines, time }) => lines.filter(line => usable(line) && canonical(line.text).length >= 4 &&
    canonical(line.text).length <= 120 && (!target.right || xOf(line) >= .57 || ordinal.test(line.text))).map(line => ({ ...line, time })));
  const kept = new Map();
  for (const line of candidates) {
    const name = textSignature(line.text);
    if (kept.has(name) || !candidates.some(other => other.time !== line.time && textSignature(other.text) === name && Math.abs(xOf(line) - xOf(other)) <= .055 && Math.abs(yOf(line) - yOf(other)) <= .075)) continue;
    kept.set(name, line);
  }
  const lines = [...kept.values()];
  return { lines: lines.sort((a, b) => Number(ordinal.test(b.text)) - Number(ordinal.test(a.text)) || a.time - b.time).slice(0, 5),
    unresolved: target.right && !lines.some(line => xOf(line) >= .57) };
}

function verificationResult(targets, frames, ocr) {
  const byTime = new Map(frames.map((frame, index) => [frame.time, { time: frame.time, ...ocr[index] }]));
  const charts = [], unresolved = [], confirmedTextWindows = [], lines = new Map();
  for (const target of targets) {
    const result = checkWindow(target, target.times.map(time => byTime.get(time)).filter(sample => sample?.lines?.length));
    if (result.chart) charts.push(result.chart);
    for (const line of result.lines || []) lines.set(textSignature(line.text), line);
    if (result.unresolved || !result.chart && !result.lines?.length) unresolved.push({ time: target.time, kind: target.kind });
    else if (result.lines?.length) confirmedTextWindows.push({ time: target.time, right: target.right });
  }
  const groups = new Map(charts.map(chart => [groupSignature(chart.groups), chart]));
  const chartText = [...groups.values()].map(chart => `经邻帧位置核对的完整图表分组（${chart.times.slice(0, 2).map(seconds).join('、')} 秒）：${chart.groups.map(group => `${group.name}（${group.items.length}项）：${group.items.join('、')}`).join('；')}。`);
  const recognized = [...lines.values()].sort((a, b) => a.time - b.time).map(line => `视频时间约 ${seconds(line.time)} 秒（邻帧 OCR）：${line.text}`);
  const gaps = unresolved.map(gap => `约 ${seconds(gap.time)} 秒的${gap.kind === 'chart' ? '分组对应关系' : '字卡文字'}经补扫仍无稳定证据 [待核实]。`);
  return { text: [...chartText, ...recognized, ...gaps].join('\n'), chartProof: groups.size === 1 && !unresolved.some(gap => gap.kind === 'chart') ? chartText[0] : '', unresolved, confirmedTextWindows,
    frames: frames.length, resolvedCharts: groups.size, resolvedLines: lines.size };
}

function staleFrameClaims(markdown, evidence) {
  if (!evidence?.chartProof && !evidence?.confirmedTextWindows?.length) return [];
  return markdown.split(/\r?\n/).flatMap(line => {
    const times = [...line.matchAll(/(\d+(?:\.\d+)?)\s*秒/gu)].map(match => Number(match[1]));
    const pendingLine = /^\s*-\s+(?:`|\*\*)?\[待核实\]/u.test(line);
    const stale = line.split(/[。；;]/u).some(clause => {
      if (!pendingLine && !/待核实|仍(?:然)?(?:无法确认|看不清|无法辨认)/u.test(clause)) return false;
      if (evidence.chartProof && /(?:分组|组别|标签).{0,12}(?:归属|对应关系|名单|对不上)|(?:完整|具体).{0,6}分组/u.test(clause)) return true;
      if (!/(?:字卡|字幕|文字|右卡|左卡)/u.test(clause) || /天数|时长|参数|字号|色值|其余小字|其他小字/u.test(clause)) return false;
      return evidence.confirmedTextWindows?.some(window => times.some(time => Math.abs(time - window.time) <= .5) &&
        (!window.right || /右卡|最右.{0,5}卡/u.test(clause)));
    });
    return stale ? [line] : [];
  });
}

module.exports = { verificationTargets, verificationResult, staleFrameClaims };
