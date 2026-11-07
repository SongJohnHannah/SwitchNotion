import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url), {CollectionMedia} = require('../src/collection/media.cjs'), {createSpeechPlatform} = require('../src/speech/platform.cjs');
test('local Qwen vision sends ordered frames to Ollama and starts the service when it is down', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-switch-vision-')); const first = path.join(directory, '0.jpg'), second = path.join(directory, '1.jpg');
  fs.writeFileSync(first, 'first-frame'); fs.writeFileSync(second, 'second-frame');
  const requests = [], calls = [], progress = [];
  const ollama = { available: async () => false, ensure: async () => { calls.push('ensure'); return 'http://127.0.0.1:21434'; } };
  const media = new CollectionMedia({ ollama, fetchImpl: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ message: { content: '第一张和第二张的画面分析' } }) }; } });
  try {
    assert.equal(await media.localVision([{ frame: first, time: 0 }, { frame: second, time: 30 }], undefined, value => progress.push(value)), '第一张和第二张的画面分析');
    assert.deepEqual(calls, ['ensure']); assert.match(progress.join(' '), /正在启动本机 Ollama/);
    const body = requests[0].body, content = body.messages[0].content;
    assert.equal(requests[0].url, 'http://127.0.0.1:21434/api/chat'); assert.equal(body.model, 'qwen3.8-27b-vl:latest'); assert.equal(body.stream, false);
    assert.deepEqual(body.messages[0].images, [first, second].map(frame => Buffer.from(frame === first ? 'first-frame' : 'second-frame').toString('base64')));
    assert.match(content, /视频时间 30\.0 秒/); assert.match(content, /请描述以下视频关键帧/);
    const thinking = new CollectionMedia({ fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: '', thinking: '思考后的画面描述' } }) }) });
    assert.equal(await thinking.localVision([{ frame: first, time: 0 }]), '思考后的画面描述');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
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
  await session.close(); await session.close();
  assert.deepEqual(events, ['start', 'close']); assert.equal(requests.length, 2);
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
