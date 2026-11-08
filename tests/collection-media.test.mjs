import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url), {CollectionMedia} = require('../src/collection/media.cjs'), {createSpeechPlatform} = require('../src/speech/platform.cjs');
test('a local reference image is copied without audio or video probing', async t => {
  const { describeLocal } = require('../src/collection/local-media.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-image-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '参考图.png');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHioAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(file, bytes);
  const media = new CollectionMedia({ root: directory });
  media.probe = () => assert.fail('images have no audio or video stream to probe');
  const imported = await media.importLocal(describeLocal(file), path.join(directory, 'working'));
  assert.equal(imported.kind, 'image'); assert.deepEqual(fs.readFileSync(imported.path), bytes);
});
test('local Qwen vision sends ordered frames to Ollama and starts the service when it is down', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-switch-vision-')); const first = path.join(directory, '0.jpg'), second = path.join(directory, '1.jpg');
  fs.writeFileSync(first, 'first-frame'); fs.writeFileSync(second, 'second-frame');
  const requests = [], calls = [], progress = [];
  const ollama = { available: async () => false, ensure: async () => { calls.push('ensure'); return 'http://127.0.0.1:21434'; } };
  const media = new CollectionMedia({ ollama, fetchImpl: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ message: { content: '第一张和第二张的画面分析' } }) }; } });
  try {
    assert.equal(await media.localVision([{ frame: first, time: 0 }, { frame: second, time: 30 }], undefined, value => progress.push(value), { ocrPaths: new Set([first]) }), '第一张和第二张的画面分析');
    assert.deepEqual(calls, ['ensure']); assert.match(progress.join(' '), /正在启动本机 Ollama/);
    const body = requests[0].body, content = body.messages[0].content;
    assert.equal(requests[0].url, 'http://127.0.0.1:21434/api/chat'); assert.equal(body.model, 'qwen3.8-27b-vl:latest'); assert.equal(body.stream, false);
    assert.deepEqual(body.messages[0].images, [first, second].map(frame => Buffer.from(frame === first ? 'first-frame' : 'second-frame').toString('base64')));
    assert.match(content, /关键帧 1 · 视频时间 0\.0 秒 · 已有本机 OCR 文字/);
    assert.match(content, /关键帧 2 · 视频时间 30\.0 秒 · 无本机 OCR 文字/);
    assert.match(content, /遮罩或叠加的视觉线索/);
    const thinking = new CollectionMedia({ fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: '', thinking: '思考后的画面描述' } }) }) });
    assert.equal(await thinking.localVision([{ frame: first, time: 0 }]), '思考后的画面描述');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('vision only suppresses text transcription for the exact frames covered by OCR', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-frame-coverage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const frames = [1, 2].map(time => ({ time, frame: path.join(directory, time + '.jpg') }));
  for (const item of frames) fs.writeFileSync(item.frame, `frame-${item.time}`);
  const messages = [];
  const provider = { config: () => ({ mode: 'deepseek' }), key: () => 'fixture', async *generate(input) { messages.push(input.messages); yield '可见画面'; } };
  const media = new CollectionMedia({ provider });
  media.extractFrames = async () => frames;
  await media.runVision({ kind: 'video' }, { style: true, ocrText: '旧批次已识别文字', recognizedFramePaths: [frames[0].frame, '/old-frame.jpg'] });
  const content = messages[0][1].content;
  assert.match(content[0].text, /每张图都可描述字幕排版/);
  assert.match(content[1].text, /关键帧 1 · 视频时间 1\.0 秒 · 已有本机 OCR 文字/);
  assert.match(content[3].text, /关键帧 2 · 视频时间 2\.0 秒 · 无本机 OCR 文字/);
  assert.equal(content[2].type, 'image_url');
  assert.equal(content[4].type, 'image_url');
  media.ocrEngine = {};
  media.ocrFrames = async () => { throw Error('fixture OCR unavailable'); };
  assert.equal((await media.runVision({ kind: 'video' })).text, '可见画面');
  assert.match(messages[1][1].content[1].text, /无本机 OCR 文字/);
  media.ocrFrames = async () => ({ text: '第二帧字幕', note: '基于两张采样帧。', frames, recognizedFramePaths: [frames[1].frame] });
  await media.runVision({ kind: 'video' }, { onOcr(result) {
    assert.equal(result.text, '第二帧字幕');
    assert.match(result.note, /由画面识别阶段补做/);
    assert.equal(messages.length, 2, 'OCR is persisted before the visual request');
  } });
  assert.match(messages[2][1].content[3].text, /已有本机 OCR 文字/);
});
test('mediaocr extracts frame text while the local model only describes the picture', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-switch-ocr-')); const frame = path.join(directory, '0.jpg');
  fs.writeFileSync(frame, 'frame-bytes');
  const calls = [];
  const media = new CollectionMedia({ ocr: { recognize: async (file, options) => { calls.push({ file, signal: !!options.signal }); return { pages: [{ text: '第一行\n第二行' }] }; } } });
  try {
    assert.equal(media.localOcr, true);
    assert.equal(await media.frameText(frame), '第一行\n第二行');
    assert.equal(await media.frameText(frame, undefined, { recognize: async () => ({ pages: [{ text: '会话文字' }] }) }), '会话文字');
    assert.deepEqual(calls, [{ file: frame, signal: false }]);
    const unavailable = new CollectionMedia({ ocr: { recognize: async () => null } });
    await assert.rejects(unavailable.frameText(frame), /尚未准备/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('dense OCR samples short text and keeps the separate times of repeated lines', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-dense-ocr-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const media = new CollectionMedia({ binaries: { find: () => 'ffmpeg' }, ocr: {}, runImpl: async (_exe, args) => {
    assert.match(args[args.indexOf('-vf') + 1], /fps=2:/);
    assert.equal(args[args.indexOf('-frames:v') + 1], '5');
    for (let i = 0; i < 5; i++) fs.writeFileSync(args.at(-1).replace('%05d', String(i).padStart(5, '0')), 'frame');
  } });
  media.recognizeFrameTexts = async () => ['相同', '相同', '短字卡 1280', '', '相同'];
  const result = await media.ocr({ kind: 'video', path: path.join(directory, 'demo.mp4'), duration: 2.5 }, { dense: true });
  assert.equal(result.dense, true);
  assert.match(result.text, /约 0\.0–0\.5、2\.0 秒：相同/);
  assert.match(result.text, /约 1\.0 秒：短字卡 1280/);
  assert.match(result.rawText, /约 2\.0 秒：相同/);
  assert.deepEqual(fs.readdirSync(directory), []);
});
test('OCR line cleanup joins supported English fragments and preserves conflicting numbers with their times', () => {
  const { organizeOcr } = require('../src/collection/ocr-text.cjs');
  const texts = [
    '直到一切突然改变。\nUNTIL EVERYTHING CHANGES AT\nONCE\n正确率 61%',
    '直到一切突然改变\nUNTIL EVERYTHING CHANGES AT ONCE\n正确率 63%',
    '直到一切突然改变。\nDAY 3O',
    '另一句。',
    '直到一切突然改变。'
  ];
  const result = organizeOcr(texts.map((_, index) => ({ time: index / 2 })), texts, .5);
  assert.match(result.cleaned, /0\.0–1\.0、2\.0 秒：直到一切突然改变。/);
  assert.match(result.cleaned, /0\.0–0\.5 秒：UNTIL EVERYTHING CHANGES AT ONCE/);
  assert.match(result.raw, /CHANGES AT\nONCE/);
  assert.match(result.cleaned, /0\.0 秒：正确率 61% \[待核实\]/);
  assert.match(result.cleaned, /0\.5 秒：正确率 63% \[待核实\]/);
  assert.match(result.cleaned, /1\.0 秒：DAY 3O \[待核实\]/);
  const split = organizeOcr([{ time: 4.5 }, { time: 5 }], [
    'UNTIL EVERYTHING CHANGES AT\nONCE', 'UNTIL EVERY\nTHING CHANGES AT\nONCE'
  ], .5);
  assert.equal(split.cleaned, '视频时间约 4.5–5.0 秒：UNTIL EVERYTHING CHANGES AT ONCE');
});
test('one OCR session is shared across vision runs until it is closed', async () => {
  let opens = 0, closes = 0;
  const session = { recognize: async () => ({ pages: [{ text: '文字' }] }), close: async () => { closes++; } };
  const media = new CollectionMedia({ ocr: { openSession: async () => { opens++; return session; }, recognize: async () => ({ pages: [{ text: '文字' }] }) } });
  const [first, second] = await Promise.all([media.ensureOcrSession(), media.ensureOcrSession()]);
  assert.equal(first, session); assert.equal(second, session); assert.equal(opens, 1);
  assert.equal(await media.ensureOcrSession(), session); assert.equal(opens, 1);
  await media.closeOcrSession(); assert.equal(closes, 1);
  await media.closeOcrSession(); assert.equal(closes, 1);
  assert.equal(await media.ensureOcrSession(), session); assert.equal(opens, 2);
  await media.closeOcrSession();
});
test('mediaocr reuses one client session for every frame', async () => {
  const { MediaOcr } = require('../src/mediaocr.cjs');
  const events = [], requests = [];
  const client = { start: async () => events.push('start'), tools: async () => [{ name: 'ocr_image', inputSchema: { properties: { image_paths: {} } } }],
    request: async (_method, params) => { requests.push(params); const paths = params.arguments.image_paths; return paths.length > 1 ? { structuredContent: { errcode: 0, results: paths.map(() => ({ errcode: 0, text: '多图文字' })) } } : { structuredContent: { errcode: 0, text: '帧文字', confidence: .9 } }; },
    child: null, close: () => events.push('close') };
  const ocr = new MediaOcr({ root: '/fixture', clientFactory: () => client });
  ocr.available = () => true;
  const session = await ocr.openSession();
  assert.equal((await session.recognize('/a.jpg')).pages[0].text, '帧文字');
  assert.deepEqual(await session.recognizeMany(['/a.jpg', '/b.jpg']), ['多图文字', '多图文字']);
  assert.deepEqual(await session.recognizeMany(['/a.jpg']), ['帧文字']);
  await session.close(); await session.close();
  assert.deepEqual(events, ['start', 'close']); assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].arguments, { image_paths: ['/a.jpg'], compact: true });
  assert.deepEqual(requests[1].arguments, { image_paths: ['/a.jpg', '/b.jpg'], compact: true });
});
test('Ollama unloads the local model when released', async () => {
  const { OllamaService } = require('../src/collection/ollama.cjs');
  const calls = [];
  const service = new OllamaService({ fetchImpl: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true }; } });
  service.active = 'http://127.0.0.1:21434';
  await service.unload('qwen3.8-27b-vl:latest');
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:21434/api/generate', body: { model: 'qwen3.8-27b-vl:latest', keep_alive: 0 } }]);
  calls.length = 0; service.active = ''; await service.unload('qwen3.8-27b-vl:latest'); assert.equal(calls.length, 0);
});
test('Ollama starts on the fallback port when the default port is unavailable', async () => {
  const { OllamaService } = require('../src/collection/ollama.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-switch-ollama-')), executable = path.join(directory, 'ollama.exe');
  fs.writeFileSync(executable, '');
  let fallbackUp = false; const spawned = [];
  const service = new OllamaService({ executable, fetchImpl: async url => ({ ok: url.startsWith('http://127.0.0.1:21434') ? fallbackUp : false }),
    spawnImpl: (file, args, options) => { spawned.push({ file, args, options }); fallbackUp = true; return { unref() {} }; } });
  try {
    assert.equal(await service.ensure(), 'http://127.0.0.1:21434');
    assert.equal(spawned.length, 1); assert.equal(spawned[0].file, executable);
    assert.deepEqual(spawned[0].args, ['serve']); assert.equal(spawned[0].options.detached, true);
    assert.equal(spawned[0].options.cwd, directory);
    assert.equal(spawned[0].options.env.OLLAMA_HOST, '127.0.0.1:21434');
    assert.equal(await service.ensure(), 'http://127.0.0.1:21434'); assert.equal(spawned.length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  assert.throws(() => new OllamaService({ executable: '', platform: 'win32', env: {} }).locate(), /未找到 Ollama/);
});
test('local Qwen vision is serialized while cloud vision stays concurrent', async () => {
  const media = new CollectionMedia({});
  let active = 0, max = 0;
  media.runVision = async () => { active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 30)); active--; return { text: 'ok' }; };
  await Promise.all([media.vision({ kind: 'video' }, { engine: 'local' }), media.vision({ kind: 'video' }, { engine: 'local' })]);
  assert.equal(max, 1);
  active = 0; max = 0;
  await Promise.all([media.vision({ kind: 'image' }, { engine: 'deepseek' }), media.vision({ kind: 'image' }, { engine: 'deepseek' })]);
  assert.equal(max, 2);
  let calls = 0;
  media.runVision = async () => { if (++calls === 1) throw Error('识别失败'); return { text: '恢复' }; };
  await assert.rejects(media.vision({ kind: 'video' }, { engine: 'local' }), /识别失败/);
  assert.deepEqual(await media.vision({ kind: 'video' }, { engine: 'local' }), { text: '恢复' });
});
test('an incomplete, CPU or degenerate operator result never becomes a collection transcript', async () => {
  for (const result of [{ text: 'partial', complete: false, device: 'cuda' }, { text: 'CPU result', complete: true, device: 'cpu' }, { text: '!'.repeat(224), complete: true, device: 'cuda' }]) {
    let calls = 0;
    const media = new CollectionMedia({ operator: { transcribeFile: async () => { calls++; return result; } } });
    await assert.rejects(media.transcript({ path: path.resolve('fixture.mp4'), audio: true }), /AI 总结已暂停/);
    assert.equal(calls, 1);
  }
});
test('explicit CPU profiles never inherit API credentials', () => {
  const platform = createSpeechPlatform({id:'win32',arch:'x64',device:'cpu',env:{DEEPSEEK_API_KEY:'private',NOTION_TOKEN:'private'}});
  assert.equal(platform.profile.device,'cpu');assert.equal(platform.profile.computeType,'int8');assert.equal(platform.withModel('large-v3-turbo').profile.device,'cpu');
  const env=platform.environment('C:\\state');assert.equal(env.NOTION_SWITCH_SPEECH_DEVICE,'cpu');assert.equal(env.DEEPSEEK_API_KEY,undefined);assert.equal(env.NOTION_TOKEN,undefined);
});

test('legacy minute checkpoints are preserved as history and ignored by whole-file operator transcription', async t => {
  const { hash } = require('../src/collection/model.cjs');
  const parent = path.resolve(import.meta.dirname, '../.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'test-gpu-resume-')); t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(parent)); fs.rmSync(directory, { recursive: true }); });
  const file = path.join(directory, 'original.wav'); fs.writeFileSync(file, 'preserved-media'); const stat = fs.statSync(file), duration = 60;
  const identity = hash(JSON.stringify([stat.size, stat.mtimeMs, duration, 'fixture', 'minute-checkpoints-10s-inference']));
  fs.writeFileSync(path.join(directory, 'transcript-progress.json'), JSON.stringify({ identity, backend: 'cpu', chunks: { 0: '已保存的文字' } }));
  let calls = 0; const media = new CollectionMedia({ operator: { transcribeFile: async options => {
    calls++; assert.equal(options.source, file); return { text: '独立算子的完整逐字稿', device: 'cuda', complete: true };
  } }, speech: { probe: () => assert.fail('must not probe the old runtime') } });
  const result = await media.transcript({ path: file, kind: 'audio', bytes: stat.size, duration, audio: true });
  assert.equal(result.text, '独立算子的完整逐字稿'); assert.equal(result.device, 'cuda'); assert.equal(calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'transcript-progress.json'))).chunks[0], '已保存的文字');
});

test('expired Xiaohongshu video addresses are refreshed only for the same complete source', async () => {
  const contentId = 'a'.repeat(64), sourceUrl = 'https://www.xiaohongshu.com/explore/1234567890abcdef12345678?xsec_token=fixture';
  for (const document of [
    { incomplete: true, nodes: [{ kind: 'video', platform: 'xiaohongshu', direct: true, contentId }] },
    { incomplete: false, nodes: [{ kind: 'video', platform: 'xiaohongshu', direct: true, contentId: 'b'.repeat(64) }] },
    { incomplete: false, nodes: [{ kind: 'video', platform: 'xiaohongshu', contentId }] }
  ]) {
    let inspected = false;
    const media = new CollectionMedia({ browser: { inspect: async url => { assert.equal(url,sourceUrl); inspected=true; return document; } } });
    await assert.rejects(media.acquire({ kind: 'video', platform: 'xiaohongshu', direct: true, contentId, sourceUrl, url: 'https://sns-video-qc.xhscdn.com/expired.mp4' }, '/unused'), /小红书原视频/);
    assert.equal(inspected,true);
  }
});
