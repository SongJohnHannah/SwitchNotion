const fs = require('node:fs');
const path = require('node:path');
const { hash, atomicJson } = require('./model.cjs');
const { transcriptQualityIssue } = require('../speech/transcript-quality.cjs');

async function transcribeMacMedia(media, asset, { signal, progress = () => {}, directory, language = 'auto' } = {}) {
  const speech = media.speech;
  if (!speech) throw Error('本地转写引擎未配置，请在离线语音中检测并准备。');
  if (!['auto', 'zh', 'en'].includes(language)) throw Error('转写语言无效。');
  if (!Number.isFinite(asset.duration) || asset.duration <= 0) throw Error('无法确认媒体时长，未开始转写。');
  const source = fs.realpathSync(asset.path), stat = fs.statSync(source);
  const identity = hash(JSON.stringify([source, stat.size, stat.mtimeMs, asset.duration, speech.status?.().model, language, 'mac-cpu-10s-v1']));
  directory ||= path.dirname(source);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'mac-transcript-progress.json');
  let checkpoint = { identity, chunks: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.identity === identity && saved.chunks && typeof saved.chunks === 'object') checkpoint = saved;
  } catch {}
  const paragraphs = [];
  speech.retain?.();
  try {
    await speech.probe({ signal });
    for (let start = 0; start < asset.duration; start += 60) {
      signal?.throwIfAborted();
      let text = checkpoint.chunks[start];
      if (typeof text !== 'string') {
        progress(`正在生成逐字稿（本机 CPU）：${Math.floor(start / 60)} / ${Math.ceil(asset.duration / 60)} 分钟`);
        const wav = path.join(directory, 'mac-speech-' + start + '.wav');
        try {
          await media.runMedia(media.ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-ss', String(start),
            '-protocol_whitelist', 'file,pipe,crypto,data', '-i', source, '-t', String(Math.min(60, asset.duration - start)),
            '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav], { signal });
          text = await speech.transcribeWav({ wav: fs.readFileSync(wav), language, chunkSeconds: 10, signal });
          signal?.throwIfAborted();
          if (typeof text !== 'string') throw Error('本机离线转写没有返回文字。');
          const issue = transcriptQualityIssue(text);
          if (issue) throw Object.assign(Error(issue + '；AI 总结已暂停。'), { code: 'SPEECH_UNRELIABLE' });
          checkpoint.chunks[start] = text.trim();
          atomicJson(file, checkpoint);
        } finally { try { fs.unlinkSync(wav); } catch {} }
      }
      const issue = transcriptQualityIssue(text);
      if (issue) throw Object.assign(Error(issue + '；AI 总结已暂停。'), { code: 'SPEECH_UNRELIABLE' });
      if (text.trim()) paragraphs.push(text.trim());
    }
  } finally { speech.release?.(); }
  return { text: paragraphs.join('\n\n'), note: paragraphs.length ? '' : '未识别到清晰语音。', device: 'cpu' };
}
module.exports = { transcribeMacMedia };
