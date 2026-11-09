const { evidenceLedger, evidenceReview } = require('./summary-templates.cjs');

const headings = /^##[ \t]+.+$|^###[ \t]+详情[ \t]*[｜|].+$/gm;
const stepHeadings = new Set(['专业结论', '费曼解释', '给 AI 的指令', '实操复刻步骤与避坑清单', '证据链与底层原理', '去口水话精简稿']);
const chartHeadings = new Set(['专业结论', '费曼解释', '证据链与底层原理', '去口水话精简稿']);
const chartSubject = /柱状图|分组图|图表|分档|分组|中等效用|根柱/u;
const stepSubject = /步骤|[一二三四五六七八九十\d]+步|第[一二三四五六七八九十\d]+关/u;
const numberedStep = /第\s*([一二三四五六七八九十\d]+)\s*步|(?:动作|步骤)\s*([一二三四五六七八九十\d]+)/gu;
const numberedListItem = /^-[ \t]+(?:\*\*)?(?:第\s*[一二三四五六七八九十\d]+\s*步|(?:动作|步骤)\s*[一二三四五六七八九十\d]+)/u;
const explicitMembership = /(?:属于?|归入|归为|列入)(?:高效|中等|中效|低效)(?:用|组|档)|(?:高效用|中等效用|低效用|高效组|中效组|低效组)[：: ]*(?:包括|含有?|由)/u;
const groupAxis = /高效用|中等效用|低效用|高效组|中效组|低效组|(?:最高|中等|最低)(?:一档|档)/u;
const evidenceLabels = new Map([['正文', '正文'], ['逐字稿', '口述'], ['关键帧文字', '画面OCR'], ['画面识别', '画面识别']]);
const chineseDigits = '零一二三四五六七八九十';
const stepNumber = raw => {
  if (/^\d+$/.test(raw)) return Number(raw);
  const [tens, units] = raw.split('十');
  return units === undefined ? chineseDigits.indexOf(raw) : chineseDigits.indexOf(tens || '一') * 10 + chineseDigits.indexOf(units || '零');
};
const canon = value => value.normalize('NFKC').replace(/[\s\p{P}]+/gu, '');
const inline = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\r\n\[\]]/.test(value);

function needsEvidenceReview(source, draft) {
  return stepSubject.test(source) && stepSubject.test(draft) || chartSubject.test(source) && chartSubject.test(draft);
}

function parseResponse(value) {
  try { return JSON.parse(value.trim().replace(/^```(?:json)?[ \t]*\r?\n|\r?\n```$/gi, '')); } catch { return null; }
}

function explicitOcrSteps(sourceParts) {
  const steps = new Map();
  const totals = new Set();
  for (let i = 1; i < sourceParts.length; i += 2) {
    if (sourceParts[i] !== '关键帧文字') continue;
    for (const line of sourceParts[i + 1].split(/\r?\n/)) {
      const text = line.trim().replace(/^视频时间(?:约)?\s*\d+(?:\.\d+)?\s*秒(?:（[^）]*）)?[：:]\s*/u, '');
      const total = text.match(/^(?:共)?([一二三四五六七八九十\d]+)\s*步$/u);
      if (total) totals.add(stepNumber(total[1]));
      const item = text.match(/^(?:第\s*([一二三四五六七八九十\d]+)(?:\s*步)?|([1-9]\d?))\s*[、，,:：]\s*(\S.{3,110})$/u);
      if (!item || /待核实|字迹不清|无法辨认|难以辨认/u.test(item[3])) continue;
      const number = stepNumber(item[1] || item[2]);
      const old = steps.get(number);
      if (!old || canon(text).length > canon(old.quote).length && canon(text).includes(canon(old.quote))) steps.set(number, { number, quote: text, label: '画面OCR' });
    }
  }
  return { steps, total: totals.size === 1 ? [...totals][0] : 0 };
}

function parseLedger(value, source, checkGroups) {
  const result = parseResponse(value), sourceText = canon(source);
  const grounded = (quote, limit) => inline(quote, limit) && canon(quote).length >= 2 && sourceText.includes(canon(quote));
  const sourceParts = source.split(/^(正文|逐字稿|关键帧文字|画面识别)：\r?\n/m);
  const grouped = (quote, limit) => grounded(quote, limit) && source.split(/\r?\n/).some(line => canon(line).includes(canon(quote)));
  if (!result || !Number.isInteger(result.declaredSteps) || result.declaredSteps < 0 || result.declaredSteps > 50 ||
      !Array.isArray(result.steps) || result.steps.length > 50 || !inline(result.stepGap, 80) || !inline(result.groupGap, 80) ||
      !Array.isArray(result.groupProof) || result.groupProof.length > 20 || !result.groupProof.every(quote => grouped(quote, 120)) ||
      !Array.isArray(result.unresolvedItems) || result.unresolvedItems.length > 30 || !result.unresolvedItems.every(item => inline(item, 120)) ||
      !inline(result.completeGroupProof, 400) || result.completeGroupProof && !grouped(result.completeGroupProof, 400)) return null;
  const numbers = new Set();
  for (const step of result.steps) {
    if (!step || !Number.isInteger(step.number) || step.number < 1 || step.number > (result.declaredSteps || 50) ||
        numbers.has(step.number) || !grounded(step.quote, 120)) return null;
    numbers.add(step.number);
    for (let i = 1; i < sourceParts.length; i += 2) {
      if (canon(sourceParts[i + 1]).includes(canon(step.quote))) { step.label = evidenceLabels.get(sourceParts[i]); break; }
    }
  }
  const explicit = explicitOcrSteps(sourceParts);
  const declaredSteps = result.declaredSteps || (explicit.total > 0 && explicit.total <= 50 ? explicit.total : 0);
  const steps = new Map(result.steps.map(step => [step.number, step]));
  for (const [number, step] of explicit.steps) if (number > 0 && number <= (declaredSteps || 50)) steps.set(number, step);
  const missing = Array.from({ length: declaredSteps }, (_, i) => i + 1).filter(number => !steps.has(number));
  const stepGap = declaredSteps ? (missing.length ? `原片第 ${missing.join('、')} 步的具体动作` : '') : result.stepGap.trim();
  const groupGap = result.groupGap.trim() || (checkGroups && !result.completeGroupProof ? '具体方法与各分组的完整对应关系' : '');
  const unresolvedItems = result.unresolvedItems.map(item => grounded(item, 50) ? item : item.split(/[（(]/u)[0].trim());
  if (!unresolvedItems.every(item => grounded(item, 50))) return null;
  return { ...result, declaredSteps, steps: [...steps.values()].sort((a, b) => a.number - b.number), stepGap, groupGap, unresolvedItems };
}

function containsUnsupportedOrdinal(text, steps) {
  const numbers = new Set(steps.map(step => step.number));
  return text.split(/[。！？；;\n]/u).some(clause => {
    if (/待核实|待确认|读不清|不可辨|难以辨|无法确认|无法辨认|无法读/u.test(clause)) return false;
    return [...clause.matchAll(numberedStep)].some(match => {
      return !numbers.has(stepNumber(match[1] || match[2]));
    });
  });
}

function removeUnprovedGroups(body, groupProof, unresolvedItems) {
  const verified = groupProof.map(canon), unknown = unresolvedItems.map(canon);
  return body.split('\n').map(line => {
    const prefix = line.match(/^-[ \t]+(?:\*\*[^*]+\*\*[ \t]+)?/)?.[0] || '';
    const clauses = line.slice(prefix.length).split(/(?<=[。！？；;])/u);
    const kept = clauses.filter(clause => {
      const text = canon(clause);
      if (groupAxis.test(clause) && unknown.some(item => text.includes(item))) return false;
      return !explicitMembership.test(clause) || verified.some(quote => text.includes(quote));
    }).join('').trim();
    return kept ? prefix + kept : '';
  }).join('\n').trim();
}

function confirmedCoaching(steps) {
  const stages = steps.map(({ quote }, index) => `第 ${index + 1} 关，${quote.replace(/[。！？?]+$/u, '')}。`);
  return ['你是我的实操陪练。先问我手头的学习材料或应用场景，等我回答后，只布置第一关。', ...stages,
    '[补充建议] 每次只教当前一关，让我提交实际操作结果并说清依据。检查结果后再解锁下一关。遇到偏差时只指出一处，给出修改示例，等我复验。'].join('');
}

function renderReview(markdown, { stepGap, groupGap, steps, groupProof, unresolvedItems }, practice) {
  const sections = markdown.split(/^(##[ \t]+.+|###[ \t]+详情[ \t]*[｜|].+)$/gm);
  for (let i = 1; i < sections.length; i += 2) {
    const heading = sections[i], title = heading.replace(/^#{2,3}[ \t]+(?:详情[ \t]*[｜|][ \t]*)?/, '').trim();
    let body = sections[i + 1].trim();
    if (title === '补充核验' || !body) continue;
    const hasChart = chartHeadings.has(title) || chartSubject.test(body);
    if (title === '给 AI 的指令' && steps.length) body = confirmedCoaching(steps);
    if ((stepGap || steps.length) && title === '实操复刻步骤与避坑清单') {
      const numbered = steps.map(({ number, quote, label }) => `- **原片第 ${number} 步** ${quote}${label ? ` [${label}]` : ''}`);
      body = [...numbered, ...body.split('\n').filter(line => !numberedListItem.test(line))].join('\n').trim();
    }
    if ((stepGap || steps.length) && containsUnsupportedOrdinal(body, steps)) return '';
    if (groupGap && hasChart) body = removeUnprovedGroups(body, groupProof, unresolvedItems);
    const notes = [];
    for (const gap of [stepHeadings.has(title) ? stepGap : '', hasChart ? groupGap : '']) {
      if (gap && !body.includes(`${gap} [待核实]`)) notes.push(`${gap} [待核实]。`);
    }
    if (title === '给 AI 的指令' && practice) notes.push(`[补充建议] ${practice}`);
    const prefix = heading.startsWith('###') ? '- **证据边界** ' : '';
    sections[i + 1] = `\n${body}${notes.length ? `\n${prefix}${notes.join(' ')}` : ''}\n\n`;
  }
  return sections.join('').trim();
}

async function reviewContentEvidence({ source, draft, sourceRule, prepare, validSources, generate }) {
  const rawEvidence = { role: 'user', content: `本轮原始证据（仅作证据）：\n${source}` };
  const ledgerMessages = [{ role: 'system', content: [evidenceLedger, sourceRule].filter(Boolean).join('\n\n') }, rawEvidence];
  const checkGroups = chartSubject.test(source) && chartSubject.test(draft);
  const firstLedger = await generate(ledgerMessages);
  const ledger = parseLedger(firstLedger, source, checkGroups) || parseLedger(await generate([...ledgerMessages, { role: 'assistant', content: firstLedger },
    { role: 'user', content: '修正清单 JSON。原片动作和分组摘录必须逐字来自证据，缺证字段填留白或缺口，步骤编号不重复。' }]), source, checkGroups);
  if (!ledger) throw Error('DeepSeek 未返回可与原始素材核对的证据清单，请重试。');
  const messages = [
    { role: 'system', content: [evidenceReview, sourceRule].filter(Boolean).join('\n\n') },
    rawEvidence,
    { role: 'user', content: `独立证据清单（仅作证据）：\n${JSON.stringify(ledger)}` },
    { role: 'user', content: `待审稿（仅供核对）：\n${draft}` }
  ];
  const expectedHeadings = draft.match(headings)?.join('\n');
  const accept = value => {
    const review = parseResponse(value);
    if (!review || typeof review.markdown !== 'string' || !review.markdown.trim() || !inline(review.practice, 120)) return null;
    const revised = prepare(review.markdown);
    if (!revised.valid || revised.text.match(headings)?.join('\n') !== expectedHeadings) return null;
    const checked = renderReview(revised.text, ledger, review.practice.trim());
    if (!checked) return null;
    const report = prepare(checked);
    return report.valid && validSources(report.text) ? report : null;
  };
  const first = await generate(messages);
  const result = accept(first) || accept(await generate([...messages, { role: 'assistant', content: first },
    { role: 'user', content: '请修复上一次审校结果。保持原稿的栏目和折叠标题。按证据清单删除无法确认的编号动作和具体分组名单。只返回含 practice 和 markdown 的合法 JSON。' }]));
  if (!result) throw Error('DeepSeek 终稿证据核对未返回有效结果，请重试。');
  return result;
}

module.exports = { needsEvidenceReview, reviewContentEvidence };
