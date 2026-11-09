import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseInputs, describeLocal, checkLocal } = require('../src/collection/local-media.cjs');
const { preferences, normalizeDocument, layoutNodes } = require('../src/collection/model.cjs');
const { CollectionExtraction } = require('../src/collection/extraction.cjs');
const { renderDocument } = require('../src/collection/notion.cjs');

test('video metadata and expand controls cannot reach classification or summary before media evidence exists', async () => {
  const engine = new CollectionExtraction({ provider: { config: () => assert.fail('incomplete sources must not reach the provider') } });
  const doc = normalizeDocument({ url: 'https://www.youtube.com/watch?v=fixture', nodes: [
    { kind: 'paragraph', text: '…更多' }, { kind: 'video', url: 'https://www.youtube.com/watch?v=fixture' }] });
  const node = doc.nodes[1], job = { options: preferences(), document: doc, resources: {}, analyses: {} };
  assert.equal((await engine.run(job, doc.nodes)).stage, 'download');
  job.resources[node.id] = { asset: { path: '/video.mp4', audio: true } };
  job.analyses[node.id] = { vision: { text: '只有采样画面' } };
  assert.equal((await engine.run(job, doc.nodes)).stage, 'transcript');
  job.analyses[node.id] = { transcript: { text: '', note: '未识别到清晰语音。' } };
  assert.equal((await engine.run(job, doc.nodes)).stage, 'evidence');
});

test('a stored transcript with a valid prefix and degenerate punctuation cannot be summarized', async () => {
  const engine = new CollectionExtraction({ provider: { config: () => assert.fail('corrupt transcripts must not reach summary') } });
  const doc = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video' }] });
  const id = doc.nodes[0].id;
  const job = { options: preferences(), document: doc, resources: { [id]: { asset: { path: '/video.mp4', audio: true } } },
    analyses: { [id]: { transcript: { text: 'First part was recognizable.\n' + '!'.repeat(224) } } } };
  const result = await engine.run(job, doc.nodes);
  assert.equal(result.deferred, true); assert.equal(result.stage, 'transcript-quality');
});
test('one input accepts Windows, Mac and file URLs with spaces, alongside web links', () => {
  assert.deepEqual(parseInputs('"D:\\媒体 资料\\片段.mp4"\nhttps://example.com/article\nfile:///C:/Users/me/My%20Audio.m4a', { platform: 'win32', home: 'C:\\Users\\me' }), [
    { kind: 'local', path: 'D:\\媒体 资料\\片段.mp4' }, { kind: 'web', url: 'https://example.com/article' }, { kind: 'local', path: 'C:\\Users\\me\\My Audio.m4a' }]);
  assert.deepEqual(parseInputs('/Users/me/电影 片段.mov\n~/Downloads/声音.wav\nfile:///Users/me/Audio%20Test.mp3', { platform: 'darwin', home: '/Users/me' }), [
    { kind: 'local', path: '/Users/me/电影 片段.mov' }, { kind: 'local', path: '/Users/me/Downloads/声音.wav' }, { kind: 'local', path: '/Users/me/Audio Test.mp3' }]);
  for (const input of ['file://server/share/audio.mp3', '\\\\server\\share\\audio.mp3', './relative.mp4', '/Users/me/secrets.txt']) assert.throws(() => parseInputs(input, { platform: 'darwin' }));
});
test('local retries reject a replaced source instead of silently processing different media', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-local-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const file = path.join(root, '音频.mp3'); fs.writeFileSync(file, 'original'); const source = describeLocal(file);
  assert.equal(checkLocal(source).kind, 'audio'); fs.writeFileSync(file, 'changed content'); assert.throws(() => checkLocal(source), /改变/);
});
test('extraction settings accept legacy templates, keep one preference and bound input', () => {
  const defaults = preferences();
  assert.deepEqual(defaults.extraction, { mode: 'auto', preference: '' });
  const migrated = preferences({ extraction: { mode: 'video', article: '旧模板', video: '旧模板' } });
  assert.deepEqual(migrated.extraction, { mode: 'auto', preference: '' });
  const edited = preferences({ extraction: { mode: 'off', preference: '重点总结口播风格' } });
  assert.deepEqual(edited.extraction, { mode: 'off', preference: '重点总结口播风格' });
  assert.throws(() => preferences({ extraction: { preference: 'x'.repeat(4001) } }));
  assert.throws(() => preferences({ extraction: { apiKey: 'forbidden' } }));
});
test('article text and images keep their order, original audio/video precedes the separate AI section', () => {
  const doc = normalizeDocument({ url: 'https://example.com/article', nodes: [{ kind: 'paragraph', text: '第一段' }, { kind: 'video', url: 'https://example.com/a.mp4' }, { kind: 'image', url: 'https://example.com/a.jpg' }, { kind: 'paragraph', text: '末段' }, { kind: 'audio', url: 'https://example.com/a.mp3' }] });
  const ordered = layoutNodes(doc.nodes, 'media-at-end'); assert.deepEqual(ordered.map(node => node.kind), ['paragraph', 'image', 'paragraph', 'video', 'audio']);
  const resources = Object.fromEntries(ordered.filter(node => ['video', 'audio', 'image'].includes(node.kind)).map(node => [node.id, { uploads: [{ id: 'fixture', uploaded: true }] }]));
  const plan = renderDocument(doc, ordered, resources, {}, [], { name: '文章精读', text: '## 核心结论\n独立输出' });
  const ai = plan.blocks.findIndex(block => block.heading_1?.rich_text[0]?.text.content.startsWith('AI 提取结果'));
  assert.ok(plan.slots[doc.nodes[3].id].start < plan.slots[doc.nodes[1].id].start); assert.ok(plan.slots[doc.nodes[4].id].start < ai);
});
test('pure articles use the same writing template and checkpoint every selected chunk', async () => {
  const calls = [], provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate(input) {
    calls.push(input);
    yield input.messages[0].content.includes('只输出证据笔记') ? '- [正文] 有证据的论点' : '## 专业结论\n- 有证据的结论';
  } };
  const doc = normalizeDocument({ title: '原文', url: 'https://example.com/a', nodes: [
    { kind: 'paragraph', text: '完整原文'.repeat(9000) }, { kind: 'paragraph', text: '未选择的私人段落' }, { kind: 'image', url: 'https://example.com/illustration.jpg' }
  ] });
  const options = preferences({ extraction: { mode: 'auto', preference: '保留数字和步骤' } });
  const job = { options, document: doc, analyses: {} };
  const engine = new CollectionExtraction({ provider });
  const result = await engine.run(job, [doc.nodes[0], doc.nodes[2]], { signal: new AbortController().signal });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.messages[1].content.includes('保留数字和步骤') && call.messages[1].content.includes('记忆点')));
  assert.ok(calls.every(call => !JSON.stringify(call.messages).includes('未选择的私人段落')));
  assert.ok(calls.slice(0, 2).every(call => call.messages[1].content.includes('只输出当前范围的紧凑证据笔记') && !call.messages[1].content.includes('## 费曼解释')));
  assert.match(calls[2].messages[1].content, /本次正文只覆盖节选/);
  assert.doesNotMatch(calls[2].messages[1].content, /只输出当前范围的紧凑证据笔记/);
  assert.match(calls[2].messages[1].content, /这是最终汇总[\s\S]*按原顺序给精简稿/);
  assert.equal(result.type, '文章精读');
  const plan = renderDocument(doc, [doc.nodes[0]], {}, {}, [], result, 'result-first');
  assert.ok(plan.blocks.findIndex(block => block.heading_1?.rich_text[0].text.content.includes('文章精读')) < plan.slots[doc.nodes[0].id].start);
  job.extraction = result;
  await engine.run(job, [doc.nodes[0], doc.nodes[2]], { signal: new AbortController().signal });
  assert.equal(calls.length, 3);
});

test('long article batches produce intermediate notes before the single final rewrite', async () => {
  const phases = [], provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    const prompt = messages[1].content;
    if (prompt.includes('个素材片段。')) {
      assert.match(messages[0].content, /只输出证据笔记/);
      assert.doesNotMatch(messages[0].content, /从二级标题开始/);
      phases.push('fragment'); yield '- ' + '证据'.repeat(9000);
    } else if (prompt.includes('这是中间合并')) {
      assert.match(messages[0].content, /只输出证据笔记/);
      phases.push('intermediate'); yield '- 待汇总的证据';
    } else {
      assert.match(messages[0].content, /当前阶段为最终成稿/);
      assert.match(prompt, /这是最终汇总，本轮根据各片段的证据笔记整理[\s\S]*按原顺序给精简稿/);
      phases.push('final'); yield '## 专业结论\n核心结论\n## 展开细节\n### 详情｜去口水话精简稿\n- 按原顺序的精简稿';
    }
  } };
  const document = normalizeDocument({ url: 'https://example.com/article', nodes: [{ kind: 'paragraph', text: '完整原文'.repeat(14000) }] });
  const job = { options: preferences(), document, analyses: {} };
  const result = await new CollectionExtraction({ provider }).run(job, document.nodes);
  assert.deepEqual(phases, ['fragment', 'fragment', 'fragment', 'intermediate', 'final']);
  assert.match(result.text, /按原顺序的精简稿/);
});

test('media continuations carry the original asset and field when their source markers are in an earlier chunk', async () => {
  const calls = [], provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    calls.push(messages);
    yield messages[1].content.includes('个素材片段。') ? '- 证据笔记' : '## 专业结论\n内容总结';
  } };
  const document = normalizeDocument({ url: 'https://example.com/lesson', nodes: [
    { kind: 'audio', url: 'https://example.com/intro.mp3' }, { kind: 'video', url: 'https://example.com/lesson.mp4' }
  ] });
  const [intro, video] = document.nodes;
  const job = { options: preferences(), document,
    resources: { [intro.id]: { asset: { path: '/intro.mp3', audio: true } }, [video.id]: { asset: { path: '/lesson.mp4', audio: true } } },
    analyses: { [intro.id]: { transcript: { text: '课程导语' } }, [video.id]: {
      transcript: { text: '第二段内容'.repeat(4800) }, ocr: { text: '确认画面文字'.repeat(4000) }
    } }
  };
  await new CollectionExtraction({ provider }).run(job, document.nodes);
  assert.equal(calls.length, 4);
  assert.match(calls[1][1].content, /片段开头来源为「素材 2 · 逐字稿」/);
  assert.match(calls[2][1].content, /片段开头来源为「素材 2 · 关键帧文字」/);
  assert.doesNotMatch(calls[3][1].content, /片段开头来源为/);
});

test('both video directions extract the script, and only the visual route searches and links read sources', async () => {
  const calls = [], searches = [], reads = [];
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate(input) {
    calls.push(input.messages);
    if (input.messages[0].content.includes('公开搜索词')) yield JSON.stringify(['https://should-not-search.example', '/local/path', '字幕遮罩 A / B 16:9 教程'].map(query => ({ feature: '字幕遮罩', query, must_have_terms: ['遮罩'] })));
    else if (input.messages[1].content.includes('## 蒸馏到我的视频')) yield '## 原片效果怎么做\n字幕遮罩\n## 展开细节\n### 详情｜技术实现与查证\n参考 [S1] [S2] [S9]';
    else yield '## 专业结论\n跟着做字幕\n## 展开细节\n### 详情｜证据链与底层原理\n- 原始逐字稿';
  } };
  const url = 'https://example.com/guide', unavailable = 'https://example.com/unavailable';
  let closed = 0;
  const webSources = { openCollection(signal) { return { signal, close() { closed++; }, async execute(name, args) {
    if (name === 'search_web') { searches.push(args.query); return { results: [{ url }, { url: unavailable, snippet: '未读摘要' }] }; }
    reads.push(args.url);
    if (args.url === unavailable) return { url: unavailable, title: '', text: '加载中' };
    return { url: args.url, title: '官方操作文档', text: '使用遮罩裁切字幕。'.repeat(30), fetched_at: '2026-11-07T00:00:00Z' };
  } }; } };
  const doc = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = doc.nodes;
  const engine = new CollectionExtraction({ provider, webSources });
  const run = mode => engine.run({ options: preferences({ extraction: { mode } }), document: doc,
    analyses: { [video.id]: { transcript: { text: '跟我做：先准备字幕。' }, vision: { text: '字幕从画面下方出现' } } },
    resources: { [video.id]: { asset: { path: '/video.mp4', audio: true } } }
  }, doc.nodes, { signal: new AbortController().signal });

  assert.equal((await run('auto')).type, '内容理解');
  assert.deepEqual(searches, []);
  assert.match(calls[0][1].content, /## 专业结论.*## 费曼解释/s);
  const style = await run('style');
  assert.equal(style.type, '画面与视频制作拆解');
  assert.deepEqual(searches, ['字幕遮罩 A/B 16:9 教程']);
  assert.deepEqual(reads, [url]);
  assert.equal(closed, 1);
  assert.match(calls[1][0].content, /怎样用代码实现/);
  assert.match(calls[1][1].content, /字幕从画面下方出现/);
  const [visuals, otherEvidence] = calls[1][1].content.split('其他素材证据节选');
  assert.match(visuals, /素材 1 · 画面识别\n字幕从画面下方出现/);
  assert.match(otherEvidence, /素材 1 · 逐字稿/);
  assert.doesNotMatch(otherEvidence, /字幕从画面下方出现/);
  assert.match(calls[2][1].content, /## 蒸馏到我的视频.*## 给 AI 的指令/s);
  assert.match(calls[2][1].content, /AI 参考复现路线.*技术实现与查证/s);
  assert.match(calls[2][2].content, /使用遮罩裁切字幕/);
  assert.doesNotMatch(calls[2][2].content, /加载中/);
  assert.doesNotMatch(JSON.stringify(calls[2]), /未读摘要/);
  assert.match(style.text, /\[S1\]/);
  assert.doesNotMatch(style.text, /\[S9\]/);
  const notion = renderDocument(doc, doc.nodes, {}, {}, [], style, 'result-first');
  assert.ok(notion.blocks.some(block => block.bulleted_list_item?.rich_text[0].text.link?.url === url));

  const combined = await run('both');
  assert.deepEqual(searches, ['字幕遮罩 A/B 16:9 教程', '字幕遮罩 A/B 16:9 教程']);
  assert.match(calls[3][1].content, /费曼解释/);
  assert.equal(calls[3].length, 3);
  assert.doesNotMatch(calls[3][2].content, /使用遮罩裁切字幕/);
  assert.match(calls[5][2].content, /使用遮罩裁切字幕/);
  assert.match(combined.text, /^# 内容理解\n[\s\S]+\n# 画面与视频制作拆解\n/);
  assert.deepEqual(combined.sources.map(source => source.url), [url]);
  assert.deepEqual(combined.reports.map(report => report.key), ['content', 'style']);
  assert.equal(combined.reports[0].sources, undefined);
  assert.deepEqual(combined.reports[1].sources.map(source => source.url), [url]);
  const pages = combined.reports.map(report => renderDocument(doc, doc.nodes, { [video.id]: { uploads: [{ id: 'fixture', uploaded: true }] } },
    { [video.id]: { transcript: { text: '原始逐字稿' } } }, [], report, 'result-first').blocks);
  assert.ok(pages.every(blocks => blocks[0].type === 'video' && blocks.at(-1).paragraph.rich_text[0].text.content === '原始逐字稿'));
  assert.deepEqual(pages.map(blocks => blocks.find(block => block.toggle).toggle.rich_text[0].text.content), ['证据链与底层原理', '技术实现与查证']);
});

test('OCR-only fallback is supplied as text evidence and an empty search plan makes no public query', async () => {
  const document = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = document.nodes;
  const ocrText = '视频时间 4.0 秒：随片字幕';
  const job = { options: preferences({ extraction: { mode: 'style' } }), document,
    analyses: { [video.id]: { vision: { text: ocrText, ocrText } } }, resources: { [video.id]: { asset: { path: '/video.mp4', audio: false } } } };
  const calls = [], provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    calls.push(messages);
    yield messages[0].content.includes('公开搜索词') ? '[]' : '## 原片效果怎么做\n可核对画面文字';
  } };
  const webSources = { openCollection(signal) { return { signal, close() {}, execute() { assert.fail('an empty plan cannot search'); } }; } };
  const extraction = await new CollectionExtraction({ provider, webSources }).run(job, document.nodes);
  assert.match(calls[0][1].content, /画面观察节选\n（未提供）/);
  assert.match(calls[0][1].content, /素材 1 · 关键帧文字\n视频时间 4\.0 秒：随片字幕/);
  assert.equal(calls[1].length, 3);
  assert.equal(extraction.note, undefined);
  assert.match(calls[1].at(-1).content, /关键帧文字：\n视频时间 4\.0 秒：随片字幕/);
  assert.doesNotMatch(calls[1].at(-1).content, /画面识别：/);
});

test('the visual route accepts frames without OCR or speech and omits an unsupported script analysis', async () => {
  const document = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = document.nodes;
  const job = { options: preferences({ extraction: { mode: 'style' } }), document,
    analyses: { [video.id]: { vision: { text: '两张采样帧可见暗底与曲线。' } } },
    resources: { [video.id]: { asset: { path: '/video.mp4', audio: true } } } };
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    assert.match(messages[0].content, /进入纯视觉分支/);
    yield '## 原片效果怎么做\n暗底与发光曲线。\n## 展开细节\n### 详情｜画面证据与适用范围\n画面有发光曲线。\n### 表达手法\n这里不应出现。\n### AI 参考复现路线\n按参考帧绘制曲线。';
  } };
  const result = await new CollectionExtraction({ provider }).run(job, document.nodes);
  assert.doesNotMatch(result.text, /表达手法|不应出现/);
  assert.match(result.text, /详情｜AI 参考复现路线\n按参考帧绘制曲线/);
});

test('final notes are rewritten as a report and an overlong opening is shortened without discarding folded evidence', async () => {
  const document = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = document.nodes;
  const job = { options: preferences({ extraction: { mode: 'style' } }), document,
    analyses: { [video.id]: { vision: { text: '单一版式的双栏字卡' } } },
    resources: { [video.id]: { asset: { path: '/video.mp4', audio: false, duration: 26, width: 960, height: 540 } } } };
  const calls = [], compact = '## 原片效果怎么做\n左右字卡对称。\n## 给 AI 的指令\n用参考截图制作双栏字卡小样。';
  const details = '## 展开细节\n### 详情｜技术实现与查证\n保留可对照的字幕组件和完整的实现步骤。';
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    calls.push(messages);
    if (calls.length === 1) yield '- 尚未汇总的证据';
    else if (calls.length === 2) yield compact.replace('左右字卡对称。', '左右字卡对称。'.repeat(150)) + '\n\n' + details;
    else yield compact;
  } };
  const result = await new CollectionExtraction({ provider }).run(job, document.nodes);
  assert.match(calls[0].at(-1).content, /已读取的视频规格：\n26 秒，960 × 540 像素/);
  assert.match(calls[1].at(-1).content, /上一稿未按最终成稿格式输出/);
  assert.match(calls[2].at(-1).content, /只精简下列首屏/);
  assert.doesNotMatch(calls[2].at(-1).content, /完整的实现步骤/);
  assert.equal(result.text, compact + '\n\n' + details);
});

test('a concept summary keeps its learning framework when no runnable steps are present', async () => {
  const document = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = document.nodes;
  const job = { options: preferences(), document, analyses: { [video.id]: { transcript: { text: '只改一个变量。' } } },
    resources: { [video.id]: { asset: { path: '/video.mp4', audio: true } } } };
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate() {
    yield '## 专业结论\n只改一个变量。\n\n## 费曼解释\n其他条件保持一致，才看得出是哪个变量起作用。';
  } };
  const result = await new CollectionExtraction({ provider }).run(job, document.nodes);
  assert.equal(result.text, '## 专业结论\n只改一个变量。\n\n## 费曼解释\n其他条件保持一致，才看得出是哪个变量起作用。');
});

test('detailed learning summaries retain their evidence, expression analysis and Feynman explanation', async () => {
  const document = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = document.nodes;
  const job = { options: preferences(), document, analyses: { [video.id]: { ocr: { text: '视频时间约 10 秒：每天只重复会的题。' } } },
    resources: { [video.id]: { asset: { path: '/video.mp4', audio: false } } } };
  const report = '## 专业结论\n只做熟题容易停在原地。\n\n## 费曼解释\n像一直走熟路，你会走得更熟，学不到新的路线。' +
    '\n\n## 展开细节\n### 详情｜证据链与底层原理\n- ' + '视频时间约 10 秒，画面字幕提到每天只重复会的题。'.repeat(40) +
    '\n- **口播脚本与表达** 用重复出现的做题动作表现原地打转。';
  let calls = 0;
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    calls++;
    assert.match(messages[0].content, /专业结论 → 费曼解释/);
    assert.match(messages[1].content, /## 费曼解释/);
    assert.doesNotMatch(messages.map(({ content }) => content).join('\n'), /短版|350–650/);
    yield report;
  } };
  const result = await new CollectionExtraction({ provider }).run(job, document.nodes);
  assert.equal(calls, 1);
  assert.ok(report.length > 850);
  assert.equal(result.text, report);
});

test('sampled frame changes cannot become hard-cut facts in either report', async () => {
  const document = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = document.nodes;
  const job = { options: preferences({ extraction: { mode: 'both' } }), document,
    analyses: { [video.id]: { vision: { text: '234.3 秒室内，242.2 秒室外' } } }, resources: { [video.id]: { asset: { path: '/video.mp4', audio: false } } } };
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    const title = messages[1].content.includes('## 蒸馏到我的视频') ? '原片效果怎么做' : '专业结论';
    yield `## ${title}\n- 如 234.3→242.2→250.2 秒为硬切状态。\n- 仅依据字幕位置与关键帧硬切事实。\n- 片段间为硬切（关键帧 29→32 可对照）\`[素材可核对]\`。\n- 采样帧只见跳切换页，缓动待核实。\n- [补充建议] 复现时场景可直接硬切。`;
  } };
  const result = await new CollectionExtraction({ provider }).run(job, document.nodes);
  assert.match(result.text, /234\.3→242\.2→250\.2 秒的采样画面不同/);
  assert.match(result.text, /关键帧之间的画面差异/);
  assert.doesNotMatch(result.text, /硬切(?:状态|事实)/);
  assert.doesNotMatch(result.text, /片段间为硬切/);
  assert.doesNotMatch(result.text, /跳切/);
  assert.equal(result.text.match(/复现时场景可直接硬切/g).length, 2);
});

test('search planning retains late visual evidence and reports partial search failure', async () => {
  const { researchStyle } = require('../src/collection/style-research.cjs');
  const signal = new AbortController().signal;
  const webSources = { openCollection() { return { signal, close() {}, async execute(name, args) {
    assert.equal(name, 'search_web');
    if (args.query === '候选软件 遮罩 官方文档') throw Error('fixture search failure');
    return { results: [] };
  } }; } };
  const provider = { async *generate({ messages }) {
    assert.match(messages[1].content, /素材 1 · 画面识别/);
    assert.match(messages[1].content, /后段遮罩展开/);
    yield JSON.stringify(['遮罩展开 动效', '候选软件 遮罩 官方文档'].map(query => ({ feature: '遮罩展开', query, must_have_terms: ['遮罩'] })));
  } };
  const { visual: result } = await researchStyle({ webSources, provider, config: {}, signal, progress() {},
    visualEvidence: [{ label: '素材 1 · 画面识别', text: '前段画面'.repeat(3500) + '\n后段遮罩展开' }], referenceEvidence: [] });
  assert.deepEqual(result.sources, []);
  assert.match(result.note, /搜索已返回.*部分搜索请求未完成/);
});

test('pure text uses article analysis once, even when visual or both directions were selected', async () => {
  let calls = 0;
  const engine = new CollectionExtraction({ webSources: { openCollection: () => assert.fail('articles do not search') },
    provider: { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate() { calls++; yield '## 专业结论\n原文'; } } });
  const doc = normalizeDocument({ url: 'https://example.com/article', nodes: [{ kind: 'paragraph', text: '原文' }] });
  for (const mode of ['style', 'both']) {
    const job = { options: preferences({ extraction: { mode } }), document: doc, analyses: {} };
    assert.equal((await engine.run(job, doc.nodes)).type, '文章精读');
  }
  assert.equal(calls, 2);
});

test('retrying both directions reuses the first finished result after the second fails', async () => {
  let contentCalls = 0, styleCalls = 0;
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    if (messages[1].content.includes('## 蒸馏到我的视频')) {
      if (++styleCalls === 1) throw Error('画面提取暂时失败');
      yield '## 原片效果怎么做\n画面结果';
    } else { contentCalls++; yield '## 专业结论\n内容结果'; }
  } };
  const doc = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = doc.nodes;
  const job = { options: preferences({ extraction: { mode: 'both' } }), document: doc,
    resources: { [video.id]: { asset: { path: '/video.mp4', audio: true } } },
    analyses: { [video.id]: { transcript: { text: '教学示例' }, vision: { text: '画面示例' } } } };
  const engine = new CollectionExtraction({ provider });
  let persisted;
  await assert.rejects(engine.run(job, doc.nodes, { save: () => { persisted = JSON.parse(JSON.stringify(job)); } }), /画面提取暂时失败/);
  const combined = await engine.run(persisted, doc.nodes);
  assert.match(combined.text, /内容结果[\s\S]+画面结果/);
  assert.equal(contentCalls, 1); assert.equal(styleCalls, 2);
});

test('OCR-only reports repair unsupported speech labels and do not reuse an unsafe saved report', async () => {
  const document = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = document.nodes, calls = [];
  const job = { options: preferences({ extraction: { mode: 'both' } }), document,
    resources: { [video.id]: { asset: { path: '/video.mp4', audio: true } } },
    analyses: { [video.id]: { transcript: { text: ' ', note: '未识别到清晰语音' }, ocr: { text: '01:23 合上书' } } } };
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    calls.push(messages);
    const title = messages[1].content.includes('## 蒸馏到我的视频') ? '原片效果怎么做' : '专业结论';
    assert.match(messages[0].content, /本轮证据没有可用语音转写/);
    const repair = messages.at(-1).content.includes('语音来源标注没有依据');
    if (repair) assert.match(messages.at(-1).content, /实际能从 OCR 核对时标 \[画面OCR\].+标 \[待核实\]/);
    yield `## ${title}\n` + (repair || calls.length > 4 ? '- [画面OCR] 01:23 合上书。\n- [待核实] 复习间隔。' : '- 【画面OCR＋口述】合上书，五天后复习。');
  } };
  const engine = new CollectionExtraction({ provider });
  const result = await engine.run(job, document.nodes);
  assert.equal(calls.length, 4);
  assert.ok(result.reports.every(report => report.text.includes('[画面OCR]') && report.text.includes('[待核实]') && !report.text.includes('口述')));
  job.extraction = { ...result, reports: [result.reports[0], { ...result.reports[1], text: '## 原片效果怎么做\n- [口述] 过期结果' }] };
  job.extractionWork.routes['画面与视频制作拆解'].extraction = job.extraction.reports[1];
  const regenerated = await engine.run(job, document.nodes);
  assert.equal(calls.length, 5);
  assert.doesNotMatch(regenerated.reports[1].text, /口述|过期结果/);
});

test('a transcript licenses speech labels only for the fragment that contains it, and only a valid report is returned', async () => {
  const document = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = document.nodes, calls = [];
  const job = { options: preferences(), document,
    resources: { [video.id]: { asset: { path: '/video.mp4', audio: true } } },
    analyses: { [video.id]: { transcript: { text: '真正转写的句子' }, ocr: { text: '合上书。'.repeat(6500) } } } };
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    calls.push(messages);
    if (calls.length === 1) {
      assert.doesNotMatch(messages[0].content, /本轮证据没有可用语音转写/);
      yield '- [口述] 真正转写的句子';
    } else if (calls.length <= 3) {
      assert.match(messages[0].content, /本轮证据没有可用语音转写/);
      if (calls.length === 2) yield '- ［口述］只在画面里的句子';
      else yield '- [画面OCR] 合上书。';
    } else yield '## 专业结论\n- [口述] 真正转写的句子\n- [画面OCR] 合上书。';
  } };
  const engine = new CollectionExtraction({ provider });
  assert.match((await engine.run(job, document.nodes)).text, /\[口述\] 真正转写的句子/);
  assert.equal(calls.length, 4);

  job.analyses[video.id] = { transcript: { note: '无可用转写' }, ocr: { text: '合上书。' } };
  const stubborn = new CollectionExtraction({ provider: { ...provider, async *generate() { yield '## 专业结论\n- **口述**：没有证据。'; } } });
  await assert.rejects(stubborn.run(job, document.nodes), /仍含无转写依据的口述标注/);
});

test('a final evidence audit grounds numbered steps and chart groups across sections and labels added practice', async () => {
  const document = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = document.nodes, calls = [];
  const job = { options: preferences({ transcribe: false }), document,
    resources: { [video.id]: { asset: { path: '/video.mp4', audio: false } } },
    analyses: { [video.id]: { ocr: { text: '00:04 三步：先检查数据。交错练习。\n第二，读清字段规则。' }, vision: { text: '三组柱状图，标签难辨。第三步卡片不可辨。' } } } };
  const draft = ['## 专业结论', '第三步是清理数据。', '## 费曼解释', '分组标签属于第一组。', '## 给 AI 的指令', '先做第一关，再做第三关。',
    '## 展开细节', '### 详情｜实操复刻步骤与避坑清单', '- 第三步清理数据。', '### 详情｜证据链与底层原理', '- 三组。',
    '### 详情｜去口水话精简稿', '- 先检查数据，再清理。'].join('\n');
  const revised = draft.replaceAll('第三步是清理数据。', '先检查数据。').replace('分组标签属于第一组。', '柱状图分三组。交错练习是高效用方法。')
    .replace('先做第一关，再做第三关。', '第一关，安排一周后的自测。').replace('- 第三步清理数据。', '- **动作三** 检查数据。').replace('先检查数据，再清理。', '先检查数据。');
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    calls.push(messages);
    if (calls.length === 1) { yield draft; return; }
    if (calls.length === 2) {
      assert.match(messages[0].content, /从原始素材提取证据清单/);
      assert.equal(messages.length, 2);
      assert.doesNotMatch(messages[1].content, /第三步是清理数据/);
      yield JSON.stringify({ declaredSteps: 3, steps: [{ number: 1, quote: '先检查数据' }], stepGap: '原片第三步动作', groupGap: '', groupProof: [], unresolvedItems: ['交错练习（标签重叠，待确认组别）'], completeGroupProof: '' });
      return;
    }
    assert.match(messages[0].content, /独立审校员/);
    assert.match(messages[1].content, /标签难辨。第三步卡片不可辨/);
    assert.match(messages[2].content, /具体方法与各分组的完整对应关系/);
    assert.match(messages[3].content, /第三步是清理数据/);
    yield JSON.stringify({ practice: '换一组示例数据，检查字段是否齐全。', markdown: revised });
  } };
  const report = await new CollectionExtraction({ provider }).run(job, document.nodes);
  assert.equal(calls.length, 3);
  assert.doesNotMatch(report.text, /清理数据|第三关|动作三|交错练习是高效用方法|一周后的自测/);
  assert.match(report.text, /原片第 1 步\*\* 先检查数据 \[画面OCR\]/);
  assert.equal(report.text.match(/原片第 3 步的具体动作 \[待核实\]/g).length, 6);
  assert.equal(report.text.match(/具体方法与各分组的完整对应关系 \[待核实\]/g).length, 4);
  assert.match(report.text, /## 给 AI 的指令\n[^\n]+原片第 3 步的具体动作 \[待核实\][^\n]+\[补充建议\] 换一组示例数据/);
});

test('a later readable frame resolves an earlier unclear step and fixes the action numbering', async () => {
  const { reviewContentEvidence } = require('../src/collection/evidence-review.cjs');
  const { prepareReport } = require('../src/collection/report-markdown.cjs');
  const source = '关键帧文字：\n视频时间 15 秒：第一，每段最多划一句。\n视频时间 139 秒：三步\n第二，合上书问为什么对。\n视频时间约 142 秒（本机补帧 OCR）：第三，想重读，隔几天再读。';
  const draft = '## 专业结论\n把划线和合书追问结合。\n## 展开细节\n### 详情｜实操复刻步骤与避坑清单\n- **动作三** 合上书问为什么对。';
  const report = await reviewContentEvidence({ source, draft, validSources: () => true,
    prepare: text => prepareReport(text, { visual: false, hasReadableText: true, sourceIds: new Set() }),
    generate: async messages => messages.length === 2 ? JSON.stringify({ declaredSteps: 3, stepGap: '139 秒第三张卡偏暗',
      steps: [{ number: 2, quote: '合上书问为什么对' }],
      groupProof: [], unresolvedItems: [], groupGap: '', completeGroupProof: '' }) : JSON.stringify({ practice: '', markdown: draft }) });
  assert.match(report.text, /原片第 2 步\*\* 第二，合上书问为什么对。 \[画面OCR\]\n- \*\*原片第 3 步\*\* 第三，想重读，隔几天再读。 \[画面OCR\]/);
  assert.doesNotMatch(report.text, /待核实|动作三/);
});

test('a distillation tutorial is generated separately and appended after the original style report', async () => {
  const document = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = document.nodes, calls = [];
  const job = { options: preferences({ extraction: { mode: 'style' } }), document,
    resources: { [video.id]: { asset: { path: '/video.mp4', audio: false } } },
    analyses: { [video.id]: { vision: { text: '发光图表曲线' } } } };
  const draft = '## 原片效果怎么做\n用 SVG 滤镜实现曲线光晕。\n\n## 蒸馏到我的视频\n换成用户的新数据。\n\n## 给 AI 的指令\n用新数据渲染可编辑的曲线。';
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    calls.push(messages);
    if (calls.length === 1) { assert.doesNotMatch(messages[1].content, /蒸馏提示词教程/); yield draft; return; }
    assert.match(messages[0].content, /蒸馏提示词教程/);
    assert.match(messages[1].content, /用 SVG 滤镜实现曲线光晕/);
    yield ['- **蒸馏成变量** 曲线数据可替换。', '- **提示词怎么写** 指定输入和验收。', '- **同类风格示例** 请用 SVG 生成可运行的预览。',
      '- **动手练习** 将示例数据换成自己的。', '- **验收与迭代** 复验光晕层级。'].join('\n');
  } };
  const report = await new CollectionExtraction({ provider }).run(job, document.nodes);
  assert.equal(calls.length, 2);
  assert.ok(report.text.startsWith(draft + '\n\n## 展开细节'));
  assert.match(report.text, /### 详情｜提示词编写与练习[\s\S]+\[补充建议\] 将示例数据换成自己的/);
  const blocks = renderDocument(document, document.nodes, {}, {}, [], report, 'result-first').blocks;
  assert.equal(blocks.find(block => block.toggle?.rich_text[0].text.content === '提示词编写与练习').toggle.children.length, 5);
});

test('short articles keep the full 1A prompt in one Notion paragraph and repair simple folding locally', async () => {
  const doc = normalizeDocument({ url: 'https://example.com/tutorial', nodes: [{ kind: 'paragraph', text: '教学原文' }] });
  const instruction = '[补充建议] 你是我的陪练，先确认我手头的表格，再布置第一关。' + '每关只给一项练习，等待我提交结果。'.repeat(18);
  let calls = 0;
  const engine = new CollectionExtraction({ webSources: { openCollection: () => assert.fail('short material must not search') }, provider: {
    config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
      calls++;
      assert.match(messages[1].content, /由用户亲手学会.*每次只讲解和布置当前一关/s);
      yield ['```markdown', '## 专业结论', '先学会核对表格。'.repeat(21), '## 费曼解释', '就像先确认尺子刻度，再用它比较结果。',
        '## 给 AI 的指令', '```text', instruction, '第二关只在第一关通过后解锁。', '```', '## 展开细节',
        '### 证据链与底层原理', '#### 先检查输入', '- 原文要求核对输入。', '```'].join('\n');
    }
  } });
  const result = await engine.run({ options: preferences(), document: doc, analyses: {} }, doc.nodes);
  assert.equal(calls, 1);
  assert.doesNotMatch(result.text, /```|####/);
  assert.match(result.text, /### 详情｜证据链与底层原理\n- \*\*先检查输入\*\*/);
  const blocks = renderDocument(doc, doc.nodes, {}, {}, [], result, 'result-first').blocks;
  const agent = blocks.findIndex(block => block.heading_2?.rich_text[0]?.text.content === '给 AI 的指令');
  assert.equal(blocks[agent + 1].paragraph.rich_text[0].text.content, `${instruction} 第二关只在第一关通过后解锁。`);
  assert.equal(blocks.find(block => block.toggle).toggle.children[0].bulleted_list_item.rich_text[0].annotations.bold, true);
});

test('only actionable long-content gaps search, and read sources are linked only in the verification toggle', async () => {
  const document = normalizeDocument({ url: 'https://example.com/tutorial', nodes: [{ kind: 'paragraph', text: '教程内容'.repeat(7500) }] });
  for (const actionable of [false, true]) {
    const phases = [], url = 'https://example.com/technical-docs';
    const webSources = { openCollection() { return { signal: new AbortController().signal, close() {}, async execute(name) {
      if (name === 'search_web') return { results: [{ url, title: '遮罩路径' }] };
      return { url, title: '遮罩路径', text: '独立资料写了遮罩路径。'.repeat(25) };
    } }; } };
    const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
      if (messages[0].content.includes('只输出证据笔记')) {
        phases.push('notes');
        assert.ok(messages.every(message => !message.content.includes('<search_results>')));
        yield `- [正文] [OCR待核实：不清晰的数字]${actionable ? ' [实操缺口待核实：剪辑软件的遮罩路径]' : ''}`;
      } else if (messages[0].content.includes('公开搜索词')) {
        phases.push('plan');
        assert.match(messages[1].content, /遮罩路径/);
        assert.doesNotMatch(messages[1].content, /不清晰的数字/);
        yield '[{"feature":"遮罩路径","query":"遮罩路径 官方文档","must_have_terms":["遮罩路径"]}]';
      } else {
        const repair = messages.at(-1).content.includes('上一稿未按最终成稿格式输出');
        phases.push(repair ? 'repair' : 'final');
        assert.equal(messages.some(message => /^<search_results>$/m.test(message.content)), actionable);
        yield '## 专业结论\n- 原文讲解遮罩。' + (actionable && !repair ? ' [S1]' : '') +
          '\n## 展开细节\n### 详情｜证据链与底层原理\n- 原文未给路径。\n### 详情｜补充核验\n- **入口** 独立资料核对了遮罩路径。 [S1]';
      }
    } };
    const engine = new CollectionExtraction({ provider, webSources });
    const report = await engine.run({ options: preferences(), document, analyses: {} }, document.nodes);
    assert.deepEqual(phases, actionable ? ['notes', 'notes', 'plan', 'final', 'repair'] : ['notes', 'notes', 'final']);
    if (!actionable) { assert.doesNotMatch(report.text, /补充核验|\[S1\]/); continue; }
    const blocks = renderDocument(document, document.nodes, {}, {}, [], report, 'result-first').blocks;
    assert.ok(blocks.every(block => block.heading_2?.rich_text[0]?.text.content !== '制作参考'));
    const verification = blocks.find(block => block.toggle?.rich_text[0].text.content === '补充核验');
    assert.equal(verification.toggle.children[0].bulleted_list_item.rich_text.at(-1).text.link.url, url);
    assert.doesNotMatch(report.text.split('## 展开细节')[0], /独立资料|\[S1\]/);
  }
});

test('visual research caps fallback reads and reuses a relevant later passage for a second mechanism', async () => {
  const { researchStyle } = require('../src/collection/style-research.cjs');
  const calls = [], queries = [], base = 'https://example.com/', longIntro = '背景说明。'.repeat(3200);
  const candidates = [
    { url: 'https://mirror.invalid/guide', title: 'transmission ior roughness' },
    { url: base + 'de-de/guide', title: 'transmission ior' }, { url: base + 'guide.pdf', title: 'transmission ior' },
    { url: base + 'failed', title: 'transmission ior' }, { url: base + 'irrelevant', title: 'transmission ior' },
    { url: base + 'first', title: 'transmission' }, { url: base + 'second', title: 'ior' }, { url: base + 'extra' }
  ];
  const webSources = { openCollection() { return { signal: new AbortController().signal, close() {}, async execute(name, args) {
    if (name === 'search_web') { queries.push(args.query); return { results: candidates }; }
    calls.push([args.url.slice(base.length), args.offset || 0]);
    if (args.url.endsWith('/failed')) throw Error('HTTP 403');
    if (args.url.endsWith('/irrelevant')) return { url: args.url, text: 'prior usage of roughness. '.repeat(30) };
    if (!args.offset) return { url: args.url, title: '技术指南', text: longIntro, next_offset: 16000 };
    return { text: '光照铺垫。'.repeat(100) + '关键操作：设置 transmission 和 ior 调整玻璃折射。' };
  } }; } };
  const provider = { async *generate() { yield JSON.stringify([
    { feature: '玻璃折射', query: 'Three.js transmission ' + '透射文档 '.repeat(20).trim(), must_have_terms: ['transmission', 'roughness'], official_site: 'example.com' },
    { feature: '折射率', query: 'Three.js ior', must_have_terms: ['ior'], official_site: 'example.com' },
    { feature: '额外光晕', query: 'SVG feGaussianBlur', must_have_terms: ['feGaussianBlur'] }
  ]); } };
  const { visual } = await researchStyle({ webSources, provider, config: {}, visualEvidence: [], referenceEvidence: [], progress() {} });
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^Three\.js transmission .* site:example\.com$/);
  assert.ok(queries[0].split(' site:')[0].length <= 100);
  assert.deepEqual(calls, [['failed', 0], ['irrelevant', 0], ['first', 0], ['first', 16000]]);
  assert.deepEqual(visual.sources.map(source => source.url), [base + 'first']);
  for (const { passages } of visual.sources) {
    assert.deepEqual(passages[0].features, ['玻璃折射', '折射率']);
    assert.ok(passages[0].text.length <= 4000);
    assert.match(passages[0].text, /^背景说明[\s\S]+关键操作：设置 transmission 和 ior/);
  }
});
