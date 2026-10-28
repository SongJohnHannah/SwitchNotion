import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollectionBinaries } = require('../src/collection/binaries.cjs');
const { CollectionMedia } = require('../src/collection/media.cjs');
const { run } = require('../src/collection/process.cjs');
const { ProviderRouter } = require('../src/provider.cjs');
const { SpeechSettings } = require('../src/speech/settings.cjs');
const { describeLocal } = require('../src/collection/local-media.cjs');
const { CollectionExtraction } = require('../src/collection/extraction.cjs');
const { preferences, normalizeDocument } = require('../src/collection/model.cjs');
const root = path.resolve(import.meta.dirname, '../.notion-switch'), directory = path.join(root, 'collection-media-qa');
fs.mkdirSync(directory, { recursive: true });
const binaries = new CollectionBinaries({ root }), speech = new SpeechSettings({ root });
const provider = new ProviderRouter({ root });
const media = new CollectionMedia({ root, browser: {}, binaries, speech: speech.provider, provider });
const ffmpeg = media.ffmpeg(), file = path.join(directory, 'fixture.mp4'), image = path.join(directory, 'image.png');
const signal = AbortSignal.timeout(180000);
try {
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '6', '-c:v', 'libx264', '-threads', '1', '-crf', '17', '-g', '25', '-c:a', 'aac', '-movflags', '+faststart', '-y', file], { signal });
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=640x360', '-frames:v', '1', '-y', image], { signal });
  const asset = await media.importLocal(describeLocal(file), path.join(directory, 'local-video'), { signal });
  assert.ok(asset.audio && asset.video); assert.ok(Math.abs(asset.duration - 6) < .1);
  const parts = await media.prepareUpload(asset, { compress: true, quality: '720p' }, 120000, { signal });
  assert.ok(parts.length > 1); assert.ok(parts.every(p => fs.statSync(p.path).size <= 120000));
  const result = { binaries: binaries.status(), media: { duration: asset.duration, parts: parts.length, completeDurationVerified: true } };
  if (process.argv.includes('--speech')) {
    const spoken = path.join(directory, 'spoken.wav');
    if (!fs.existsSync(spoken)) throw Error('Generate spoken.wav before the speech acceptance check.');
    const audio = await media.importLocal(describeLocal(spoken), path.join(directory, 'local-audio'), { signal });
    const transcript = await media.transcript(audio, { signal });
    assert.match(transcript.text.toLowerCase(), /content|collection|transcription|article/);
    result.speech = { passed: true, characters: transcript.text.length };
    if (process.argv.includes('--extraction')) {
      const engine = new CollectionExtraction({ provider }), options = preferences();
      const videoJob = { options, analyses: { local: { transcript } } };
      const extracted = await engine.run(videoJob, [{ id: 'local', kind: 'audio', caption: '测试音频' }], { signal });
      assert.ok(extracted.text.length > 30); assert.equal(extracted.kind, 'video');
      const document = normalizeDocument({ url: 'https://example.com/fixture', nodes: [{ kind: 'paragraph', text: '测试文章：每天阅读十分钟，并用三句话记录主要观点。每周末回顾笔记，选择一个能实践的方法。本文没有测试效果或提供外部证据。' }] });
      const article = await engine.run({ options, analyses: {} }, document.nodes, { signal }); assert.ok(article.text.length > 30); assert.equal(article.kind, 'article');
      result.extraction = { article: { passed: true, characters: article.text.length }, audioVideo: { passed: true, characters: extracted.text.length } };
    }
  }
  if (process.argv.includes('--vision')) {
    const analysis = await media.vision({ path: image, kind: 'image' }, { signal });
    assert.ok(analysis.text.length > 5); result.vision = { passed: true, characters: analysis.text.length, model: 'deepseek-flash' };
  }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { speech.provider.close(); }
