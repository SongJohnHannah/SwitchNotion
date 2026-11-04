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
    assert.deepEqual(calls, [{ file: frame, signal: false }]);
    const unavailable = new CollectionMedia({ ocr: { recognize: async () => null } });
    await assert.rejects(unavailable.frameText(frame), /尚未准备/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
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
test('repeated GPU worker exits fall back to local CPU without changing the audio or model', async () => {
  const wav = Buffer.from('bounded-wave'), calls = [], backend = {};
  const media = new CollectionMedia({root:'/fixture',speech:{status:()=>({device:'cuda'}),transcribeWav:async options=>{calls.push(['gpu',options.wav]);throw Error('离线转写进程已退出。')}}});
  media.makeCpuSpeech = async () => ({transcribeWav:async options=>{calls.push(['cpu',options.wav]);assert.equal(options.chunkSeconds,10);return '原始逐字稿';}});
  assert.equal(await media.transcribeChunk(wav,{},backend),'原始逐字稿');assert.deepEqual(calls.map(call=>call[0]),['gpu','gpu','cpu']);assert.ok(calls.every(call=>call[1]===wav));assert.equal(backend.usedCpu,true);
  await media.transcribeChunk(wav,{},backend);assert.equal(calls.at(-1)[0],'cpu');assert.equal(calls.length,4);
});
test('Windows CPU fallback uses the native CPU worker profile and never inherits API credentials', () => {
  const platform = createSpeechPlatform({id:'win32',arch:'x64',device:'cpu',env:{DEEPSEEK_API_KEY:'private',NOTION_TOKEN:'private'}});
  assert.equal(platform.profile.device,'cpu');assert.equal(platform.profile.computeType,'int8');assert.equal(platform.withModel('large-v3-turbo').profile.device,'cpu');
  const env=platform.environment('C:\\state');assert.equal(env.NOTION_SWITCH_SPEECH_DEVICE,'cpu');assert.equal(env.DEEPSEEK_API_KEY,undefined);assert.equal(env.NOTION_TOKEN,undefined);
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
