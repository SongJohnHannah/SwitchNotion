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
    yield '## 逻辑架构与写法\n- 有证据的结论';
  } };
  const doc = normalizeDocument({ title: '原文', url: 'https://example.com/a', nodes: [
    { kind: 'paragraph', text: '完整原文'.repeat(9000) }, { kind: 'paragraph', text: '未选择的私人段落' }, { kind: 'image', url: 'https://example.com/illustration.jpg' }
  ] });
  const options = preferences({ extraction: { mode: 'auto', preference: '保留数字和步骤' } });
  const job = { options, document: doc, analyses: {} };
  const engine = new CollectionExtraction({ provider });
  const result = await engine.run(job, [doc.nodes[0], doc.nodes[2]], { signal: new AbortController().signal });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.messages[1].content.includes('保留数字和步骤') && call.messages[1].content.includes('写作特色与记忆点')));
  assert.ok(calls.every(call => !JSON.stringify(call.messages).includes('未选择的私人段落')));
  assert.ok(calls.every(call => call.messages[1].content.includes('本次正文只覆盖节选')));
  assert.ok(calls.slice(0, 2).every(call => call.messages[1].content.includes('只输出当前范围的紧凑证据笔记')));
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
      assert.match(messages[0].content, /从二级标题开始/);
      assert.match(prompt, /这是最终汇总，本轮根据各片段的证据笔记整理[\s\S]*按原顺序给精简稿/);
      phases.push('final'); yield '## 润色稿\n按原顺序的精简稿';
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
    yield messages[1].content.includes('个素材片段。') ? '- 证据笔记' : '## 学完能做什么\n内容总结';
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
    if (input.messages[0].content.includes('公开搜索词')) yield '{"content":["内容补全 不应搜索"],"visual":["https://should-not-search.example","/local/path","字幕遮罩 A / B 16:9 教程"]}';
    else yield '## 画面与视频制作拆解\n\n## 操作步骤\n### 步骤 1｜加字幕遮罩（剪辑）\n参考 [S1] [S2] [S9]';
  } };
  const url = 'https://example.com/guide', unavailable = 'https://example.com/unavailable';
  let closed = 0;
  const webSources = { openCollection(signal) { return { signal, close() { closed++; }, async execute(name, args) {
    if (name === 'search_web') { searches.push(args.query); return { results: [{ url }, { url: unavailable, snippet: '未读摘要' }] }; }
    reads.push(args.url);
    if (args.url === unavailable) return { url: unavailable, title: '', text: '加载中' };
    return { url: args.url, title: '官方操作文档', text: '使用遮罩裁切字幕', fetched_at: '2026-11-07T00:00:00Z' };
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
  assert.match(calls[0][1].content, /开工前要核实的规则.*口播脚本与表达/s);
  const style = await run('style');
  assert.equal(style.type, '画面与视频制作拆解');
  assert.deepEqual(searches, ['字幕遮罩 A/B 16:9 教程']);
  assert.deepEqual(reads, [url, unavailable]);
  assert.equal(closed, 1);
  assert.match(calls[1][1].content, /字幕从画面下方出现/);
  const [visuals, otherEvidence] = calls[1][1].content.split('其他素材证据节选');
  assert.match(visuals, /素材 1 · 画面识别\n字幕从画面下方出现/);
  assert.match(otherEvidence, /素材 1 · 逐字稿/);
  assert.doesNotMatch(otherEvidence, /字幕从画面下方出现/);
  assert.match(calls[2][1].content, /口播脚本与表达.*特效做法与查证结果/s);
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
  const combinedPage = renderDocument(doc, doc.nodes, { [video.id]: { uploads: [{ id: 'fixture', uploaded: true }] } },
    { [video.id]: { transcript: { text: '原始逐字稿' } } }, [], combined, 'result-first');
  assert.equal(combinedPage.blocks[0].type, 'video');
  assert.deepEqual(combinedPage.blocks.filter(block => block.heading_1).map(block => block.heading_1.rich_text[0].text.content),
    ['AI 提取结果 · 内容理解与画面分析', '内容理解', '画面与视频制作拆解']);
  assert.deepEqual(combinedPage.blocks.filter(block => block.toggle).map(block => block.toggle.rich_text[0].text.content),
    ['步骤 1｜加字幕遮罩（剪辑）', '步骤 1｜加字幕遮罩（剪辑）']);
  assert.equal(combinedPage.blocks.at(-1).paragraph.rich_text[0].text.content, '原始逐字稿');
});

test('OCR-only fallback is supplied as text evidence and an empty search plan makes no public query', async () => {
  const document = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = document.nodes;
  const ocrText = '视频时间 4.0 秒：随片字幕';
  const job = { options: preferences({ extraction: { mode: 'style' } }), document,
    analyses: { [video.id]: { vision: { text: ocrText, ocrText } } }, resources: { [video.id]: { asset: { path: '/video.mp4', audio: false } } } };
  const calls = [], provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    calls.push(messages);
    yield messages[0].content.includes('公开搜索词') ? '{"visual":[],"content":[]}' : '## 结论\n可核对画面文字';
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

test('final notes are rewritten as a report and overlong short-video style output is compacted without truncation', async () => {
  const document = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = document.nodes;
  const job = { options: preferences({ extraction: { mode: 'style' } }), document,
    analyses: { [video.id]: { vision: { text: '单一版式的双栏字卡' } } },
    resources: { [video.id]: { asset: { path: '/video.mp4', audio: false, duration: 26, width: 960, height: 540 } } } };
  const calls = [], compact = '## 复现目标与优先特征\nPowerPoint 双栏字卡\n## 操作步骤\n### 步骤 1｜搭双卡\n- 插入两个矩形并对齐。';
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    calls.push(messages);
    if (calls.length === 1) yield '- 尚未汇总的证据';
    else if (calls.length === 2) yield '## 复现目标与优先特征\n' + '双栏字卡'.repeat(420);
    else yield compact;
  } };
  const result = await new CollectionExtraction({ provider }).run(job, document.nodes);
  assert.match(calls[0].at(-1).content, /已读取的视频规格：\n26 秒，960 × 540 像素/);
  assert.match(calls[1].at(-1).content, /上一稿未按最终成稿格式输出/);
  assert.match(calls[2].at(-1).content, /700–950 字符/);
  assert.equal(result.text, compact);
});

test('a concept summary keeps its learning framework when no runnable steps are present', async () => {
  const document = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = document.nodes;
  const job = { options: preferences(), document, analyses: { [video.id]: { transcript: { text: '只改一个变量。' } } },
    resources: { [video.id]: { asset: { path: '/video.mp4', audio: true } } } };
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate() {
    yield '## 学完能做什么\n只改一个变量。\n\n## 开始前准备与合规核验\n- 工具待核实。\n\n## 操作步骤\n- 泛化的操作。\n\n## 口播脚本与表达\n短句先立原则。';
  } };
  const result = await new CollectionExtraction({ provider }).run(job, document.nodes);
  assert.equal(result.text, '## 学完能做什么\n只改一个变量。\n\n## 口播脚本与表达\n短句先立原则。');
});

test('detailed learning summaries retain their evidence, expression analysis and Feynman explanation', async () => {
  const document = normalizeDocument({ url: 'https://example.com/video', nodes: [{ kind: 'video', url: 'https://example.com/video.mp4' }] });
  const [video] = document.nodes;
  const job = { options: preferences(), document, analyses: { [video.id]: { ocr: { text: '视频时间约 10 秒：每天只重复会的题。' } } },
    resources: { [video.id]: { asset: { path: '/video.mp4', audio: false } } } };
  const report = '## 学完能做什么\n只做熟题容易停在原地。\n\n## 要点与证据链\n' +
    '视频时间约 10 秒，画面字幕提到每天只重复会的题。'.repeat(40) +
    '\n\n## 费曼解释\n像一直走熟路，你会走得更熟，学不到新的路线。' +
    '\n\n## 口播脚本与表达\n用重复出现的做题动作表现原地打转。';
  let calls = 0;
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate({ messages }) {
    calls++;
    assert.match(messages[0].content, /完整输出适用栏目/);
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
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate() {
    yield '## 复现目标与优先特征\n- 如 234.3→242.2→250.2 秒为硬切状态。\n- 仅依据字幕位置与关键帧硬切事实。\n- 片段间为硬切（关键帧 29→32 可对照）`[素材可核对]`。\n- 采样帧只见跳切换页，缓动待核实。\n- [补充建议] 复现时场景可直接硬切。';
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
    yield '{"visual":["遮罩展开 动效","候选软件 遮罩 官方文档"],"content":[]}';
  } };
  const { visual: result } = await researchStyle({ webSources, provider, config: {}, signal, progress() {},
    visualEvidence: [{ label: '素材 1 · 画面识别', text: '前段画面'.repeat(3500) + '\n后段遮罩展开' }], referenceEvidence: [] });
  assert.deepEqual(result.sources, []);
  assert.match(result.note, /搜索已返回.*部分搜索请求未完成/);
});

test('pure text uses article analysis once, even when visual or both directions were selected', async () => {
  let calls = 0;
  const engine = new CollectionExtraction({ webSources: { openCollection: () => assert.fail('articles do not search') },
    provider: { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate() { calls++; yield '## 核心意思\n原文'; } } });
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
    if (messages[1].content.includes('特效做法与查证结果')) {
      if (++styleCalls === 1) throw Error('画面提取暂时失败');
      yield '## 制作\n画面结果';
    } else { contentCalls++; yield '## 教学\n内容结果'; }
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
