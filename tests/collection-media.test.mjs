import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url), {CollectionMedia} = require('../src/collection/media.cjs'), {createSpeechPlatform} = require('../src/speech/platform.cjs');
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
