const { reportDetail } = require('./model.cjs');

const detailsHeading = '## 展开细节';
const verificationTitle = '补充核验';
const evidenceTitle = '查看依据';
const evidenceHeading = `### 详情｜${evidenceTitle}`;
const evidenceFields = new Map([['正文', '正文'], ['逐字稿', '语音逐字稿'], ['关键帧文字', '画面文字'], ['邻帧位置核对', '邻帧画面文字'], ['画面识别', '画面描述']]);
const contentDetails = ['实操复刻步骤与避坑清单', '证据链与底层原理', verificationTitle, '去口水话精简稿', evidenceTitle];
const pyramidDetails = new Set(['实操复刻步骤与避坑清单', '证据链与底层原理', '去口水话精简稿']);
const visualDetails = ['画面证据与适用范围', '逐镜复刻规格', '表达手法', 'AI 参考复现路线', '技术实现与查证', '小样与验收', evidenceTitle];
const contentOpening = ['专业结论', '费曼解释', '给 AI 的指令'];
const videoAdaptationTitle = '用我的内容做新视频';
const visualOpening = ['原片效果怎么做', videoAdaptationTitle, '给 AI 的指令'];
const listMarker = /^(?:[-*+]\s+|\d+(?:[.)]\s+|、\s*))/u;
const leadingTemplateTitle = /^#{1,3}[ \t]+(?:文章精读|全量内容精读|内容理解|视频与音频内容理解|画面与视频制作拆解)(?:[ \t]*｜[^\n]*)?[ \t]*#*[ \t]*(?:\r?\n|$)/;

function withoutFences(markdown) {
  let fence;
  const lines = [];
  let input = markdown.trim().split(/\r?\n/);
  const wrapper = input[0].match(/^(`{3,}|~{3,})(?:md|markdown)?[ \t]*$/i);
  if (wrapper && input.at(-1).trim() === wrapper[1] && input.slice(1).find(line => line.trim())?.startsWith('#')) input = input.slice(1, -1);
  for (const line of input) {
    const marker = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
    if (marker && (!fence || (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()))) {
      fence = fence ? null : marker[1]; continue;
    }
    const heading = fence && line.match(/^#+[ \t]+(.+)$/);
    lines.push(heading ? `- **${heading[1]}**` : line);
  }
  let text = lines.join('\n').trim();
  while (leadingTemplateTitle.test(text)) text = text.replace(leadingTemplateTitle, '').trimStart();
  return text;
}

function inOrder(actual, expected) {
  let previous = -1;
  for (const item of actual) {
    const index = expected.indexOf(item);
    if (index <= previous) return false;
    previous = index;
  }
  return true;
}

function prepareReport(markdown, { visual, hasReadableText, sourceIds }) {
  const opening = [], details = [], problems = [];
  const reject = message => { invalid = true; if (!problems.includes(message)) problems.push(message); };
  const expectedDetails = visual ? visualDetails : contentDetails;
  let inDetails = false, current, invalid = false;
  const input = withoutFences(markdown);
  const normalized = visual ? input.replace(/^## 蒸馏到我的视频[ \t]*$/gm, `## ${videoAdaptationTitle}`) : input;
  for (const line of normalized.split('\n')) {
    const heading = line.match(/^(#+)[ \t]+(.+?)\s*$/);
    if (!inDetails && heading?.[1] === '##' && heading[2] === '展开细节') { inDetails = true; continue; }
    if (!inDetails) { opening.push(line); continue; }
    const explicit = line.trimEnd().match(reportDetail)?.[1];
    const implicit = heading?.[1] === '###' && (!current || expectedDetails.includes(heading[2])) ? heading[2] : '';
    const title = explicit || implicit;
    if (title) { current = { title, lines: [] }; details.push(current); continue; }
    if (!line.trim()) { if (current) current.lines.push(''); continue; }
    if (!current) { reject('展开细节中的正文缺少「### 详情｜标题」归属。'); continue; }
    const content = line.trim();
    const overview = pyramidDetails.has(current.title) && !current.lines.some(Boolean) && !listMarker.test(content);
    current.lines.push(heading ? `- **${heading[2]}**` : visual ? line : overview ? content : `- ${content.replace(listMarker, '')}`);
  }
  let front = opening.join('\n').trim();
  const expected = visual ? visualOpening : contentOpening;
  const headings = [...front.matchAll(/^(#+)[ \t]+(.+?)\s*$/gm)].map(match => match[1] === '##' ? match[2] : '');
  if (!front.startsWith(`## ${expected[0]}\n`) || !inOrder(headings, expected) || front.split(/^##[ \t]+.+$/m).slice(1).some(body => !body.trim())) reject('首屏必须按「' + expected.join(' → ') + '」排列适用的非空栏目，只用二级标题。');
  const agentHeading = '\n## 给 AI 的指令\n', agentAt = visual ? -1 : front.indexOf(agentHeading);
  if (agentAt >= 0) {
    const before = front.slice(0, agentAt).trimEnd(), agent = front.slice(agentAt + agentHeading.length);
    const paragraph = agent.split('\n').map(line => line.trim()).filter(Boolean).join(' ').replace(/^(?:[-*+] |\d+[.)] )/, '');
    front = `${before}\n${agentHeading}${paragraph}`;
  }
  const sections = details.flatMap(({ title, lines }) => {
    const text = lines.join('\n').trim();
    const body = !visual && pyramidDetails.has(title) ? text.replace(/^([^-\n][^\n]*)\n(?=- )/u, '$1\n\n') : text;
    if (!body || visual && !hasReadableText && /^(?:表达手法|口播脚本与表达)$/.test(title)) return [];
    if (visual) return [{ title, body }];
    if (title === verificationTitle) {
      if (!sourceIds.size) return [];
      for (const line of lines) if (line.trim() && !line.match(/\[S\d+\]/g)?.some(id => sourceIds.has(id))) {
        reject('「补充核验」条目「' + line.trim().slice(0, 120) + '」未引用已读来源。没有外部正文支持的待核实事项放回原片证据栏目，不要补造引用。');
      }
    } else if (title !== evidenceTitle && /\[S\d+\]/.test(body)) reject('「' + title + '」含外部来源编号；外部资料只允许放在「补充核验」，原片证据不得混入外部结论。');
    return [{ title, body }];
  });
  if (!visual && !inOrder(sections.map(({ title }) => title), contentDetails)) reject('展开栏目必须按「' + contentDetails.join(' → ') + '」排列适用项，不重复栏目。');
  if (!visual && /\[S\d+\]/.test(front)) reject('首屏含外部来源编号；外部资料只允许放在「补充核验」，首屏仅依据原素材。');
  const detailText = sections.length ? [detailsHeading, ...sections.map(({ title, body }) => `### 详情｜${title}\n${body}`)].join('\n') : '';
  return { valid: !invalid, problems, front, detailText, text: [front, detailText].filter(Boolean).join('\n\n') };
}

const sourceLabels = new Set(['正文', '正文摘录', '口述', '口播', '作者口述', '原作者口述', '原片口述', '语音转写', '逐字稿', 'ASR',
  'OCR', '画面OCR', '字幕OCR', '关键帧文字', '画面文字', '画面可见', '画面描述', '画面识别', '素材可核对']);
const qualifications = new Map([['作者主张', '作者观点'], ['引用材料', '作者引用的资料'], ['原作者说明', '作者说明'],
  ['有依据的推测', '推测'], ['补充建议', '补充建议'], ['待核实', '待核实'], ['OCR待核实', '画面文字待核实'], ['听写待核实', '语音转写待核实']]);

function proseLabels(markdown, inEvidence = false) {
  // Keep literal text inside quotes, Markdown links, and inline code intact.
  return markdown.split(/(`+[^`\r\n]+`+|「[^」\r\n]*」|“[^”\r\n]*”|\[[^\]\r\n]+\]\([^\r\n]*?\))/u).map((part, index) => {
    if (index % 2) return part;
    return part.replace(/(\*\*)?[\[［【]([^\]］】\r\n]+)[\]］】](\*\*)?/gu, (tag, before, label, after) => {
      const parts = label.trim().replace(/^来源\s*[：:]\s*/u, '').match(/^([^：:]+)(?:[：:]\s*(.*))?$/u);
      if (!parts) return tag;
      const [, name, detail] = parts;
      const labels = name.split(/[+/＋／|｜、]/u).map(value => value.replace(/\s+/g, '').replace(/ocr|asr/ig, ascii => ascii.toUpperCase()));
      if (!labels.every(value => sourceLabels.has(value) || qualifications.has(value))) return tag;
      const descriptions = labels.flatMap(value => {
        const qualification = qualifications.get(value);
        if (qualification) return [qualification];
        return inEvidence ? [/OCR/.test(value) ? '画面文字' : value] : [];
      });
      const text = descriptions.length ? `（${descriptions.join('、')}${detail ? '：' + detail : ''}）` : '';
      return before && after && !text ? '' : (before || '') + text + (after || '');
    }).replace(/(?<=[\p{L}\p{N}」）])[ \t]+(?=[（，。！？；、])/gu, '');
  }).join('').split('\n').map(line => line.replace(/^(- )[ \t]+/, '$1').trim()).filter(line => line !== '-').join('\n');
}

function verifiedEvidence(markdown, sources) {
  const rows = new Set();
  for (const line of markdown.split('\n')) {
    const item = line.match(/^- \*\*([^*\n]+)\*\*\s+素材\s+(\d+)\s*·\s*(正文|逐字稿|关键帧文字|邻帧位置核对|画面识别)\s*·\s*「(.+)」\s*$/u);
    if (!item || /\[S\d+\]/u.test(item[1])) continue;
    const [, claim, number, field, rawQuote] = item, quote = rawQuote.trim();
    const source = sources.get(`素材 ${number} · ${field}`);
    const at = quote && source ? source.indexOf(quote) : -1;
    if (at < 0) continue;
    const lineStart = source.lastIndexOf('\n', at - 1) + 1;
    const time = source.slice(lineStart, at).match(/^(视频时间(?:约)?\s*\d[\d.、–—~\- ]*秒)(?:（[^）]*）)?[：:]\s*/u)?.[1];
    const caption = proseLabels(claim);
    if (caption) rows.add(`- **${caption}** 素材 ${number} · ${evidenceFields.get(field)}${time ? ' · ' + time : ''} · 「${quote}」`);
  }
  return [...rows];
}

function pyramidConclusion(markdown) {
  return markdown.replace(/^## 专业结论\n([\s\S]*?)(?=\n+## |$)/u, (section, body) => {
    const [conclusion, ...reasons] = body.split('\n').map(line => line.trim().replace(listMarker, '')).filter(Boolean);
    if (!conclusion) return section;
    return [`## 专业结论\n${conclusion}`, reasons.map(reason => '- ' + reason).join('\n')].filter(Boolean).join('\n\n');
  });
}

function formatReportForReading(markdown, sources) {
  const sections = markdown.split(/(?=^### 详情｜)/m);
  const body = [], basis = [], verified = [];
  for (const section of sections) {
    const [heading, ...lines] = section.split('\n');
    if (heading === evidenceHeading) verified.push(...verifiedEvidence(lines.join('\n'), sources));
    else if (['### 详情｜证据链与底层原理', '### 详情｜画面证据与适用范围', '### 详情｜画面证据'].includes(heading)) {
      basis.push(proseLabels(lines.join('\n'), true).trim());
    } else body.push(proseLabels(section).trim());
  }
  const rows = [...new Set(verified)].join('\n');
  const overview = markdown.startsWith('## 专业结论\n') ? basis[0]?.match(/^[^-\n][^\n]*/u)?.[0] : '';
  if (overview) basis[0] = basis[0].slice(overview.length).trim();
  const evidence = [overview, rows, ...basis].filter(Boolean).join('\n\n');
  const text = pyramidConclusion(body.filter(Boolean).join('\n'));
  if (!evidence) return text.replace(/\n+## 展开细节[ \t]*$/, '').trim();
  return text + (/^## 展开细节$/m.test(text) ? '\n' : `\n\n${detailsHeading}\n`) + evidenceHeading + '\n' + evidence;
}

module.exports = { prepareReport, verificationTitle, evidenceTitle, evidenceHeading, evidenceFields, videoAdaptationTitle, formatReportForReading, verifiedEvidence };
