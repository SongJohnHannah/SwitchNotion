const { reportDetail } = require('./model.cjs');

const detailsHeading = '## 展开细节';
const verificationTitle = '补充核验';
const contentDetails = ['实操复刻步骤与避坑清单', '证据链与底层原理', verificationTitle, '去口水话精简稿'];
const visualDetails = ['画面证据与适用范围', '表达手法', 'AI 参考复现路线', '技术实现与查证', '小样与验收'];
const contentOpening = ['专业结论', '费曼解释', '给 AI 的指令'];
const visualOpening = ['原片效果怎么做', '蒸馏到我的视频', '给 AI 的指令'];
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
  const opening = [], details = [];
  const expectedDetails = visual ? visualDetails : contentDetails;
  let inDetails = false, current, invalid = false;
  for (const line of withoutFences(markdown).split('\n')) {
    const heading = line.match(/^(#+)[ \t]+(.+?)\s*$/);
    if (!inDetails && heading?.[1] === '##' && heading[2] === '展开细节') { inDetails = true; continue; }
    if (!inDetails) { opening.push(line); continue; }
    const explicit = line.trimEnd().match(reportDetail)?.[1];
    const implicit = heading?.[1] === '###' && (!current || expectedDetails.includes(heading[2])) ? heading[2] : '';
    const title = explicit || implicit;
    if (title) { current = { title, lines: [] }; details.push(current); continue; }
    if (!line.trim()) { if (current) current.lines.push(''); continue; }
    if (!current) { invalid = true; continue; }
    current.lines.push(heading ? `- **${heading[2]}**` : !visual && !line.startsWith('- ') ? `- ${line.trim()}` : line);
  }
  let front = opening.join('\n').trim();
  const expected = visual ? visualOpening : contentOpening;
  const headings = [...front.matchAll(/^(#+)[ \t]+(.+?)\s*$/gm)].map(match => match[1] === '##' ? match[2] : '');
  if (!front.startsWith(`## ${expected[0]}\n`) || !inOrder(headings, expected) || front.split(/^##[ \t]+.+$/m).slice(1).some(body => !body.trim())) invalid = true;
  const agentHeading = '\n## 给 AI 的指令\n', agentAt = visual ? -1 : front.indexOf(agentHeading);
  if (agentAt >= 0) {
    const before = front.slice(0, agentAt).trimEnd(), agent = front.slice(agentAt + agentHeading.length);
    const paragraph = agent.split('\n').map(line => line.trim()).filter(Boolean).join(' ').replace(/^(?:[-*+] |\d+[.)] )/, '');
    front = `${before}\n${agentHeading}${paragraph}`;
  }
  const sections = details.flatMap(({ title, lines }) => {
    const body = lines.join('\n').trim();
    if (!body || visual && !hasReadableText && /^(?:表达手法|口播脚本与表达)$/.test(title)) return [];
    if (visual) return [{ title, body }];
    if (title === verificationTitle) {
      if (!sourceIds.size) return [];
      if (lines.some(line => line.trim() && !line.match(/\[S\d+\]/g)?.some(id => sourceIds.has(id)))) invalid = true;
    } else if (/\[S\d+\]/.test(body)) invalid = true;
    return [{ title, body }];
  });
  if (!visual && (!inOrder(sections.map(({ title }) => title), contentDetails) || /\[S\d+\]/.test(front))) invalid = true;
  const detailText = sections.length ? [detailsHeading, ...sections.map(({ title, body }) => `### 详情｜${title}\n${body}`)].join('\n') : '';
  return { valid: !invalid, front, detailText, text: [front, detailText].filter(Boolean).join('\n\n') };
}

module.exports = { prepareReport, verificationTitle };
