const rate = 16000;
const maxSeconds = 600;
// Decode a bounded, uncompressed WAV without FFmpeg, Python or system codecs.
function decodeWav(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const invalid = () => Error('请使用不超过 10 分钟的 PCM16 或 Float32 WAV（单声道或双声道）。');
  if (bytes.length < 44 || bytes.length > 128 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid();
  let format, audio;
  for (let at = 12; at + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4), end = at + 8 + size;
    if (end > bytes.length) throw invalid();
    if (name === 'fmt ') { if (format || size < 16) throw invalid(); format = bytes.subarray(at + 8, end); }
    if (name === 'data') { if (audio) throw invalid(); audio = bytes.subarray(at + 8, end); }
    at = end + (size % 2);
  }
  if (!format || !audio?.length) throw invalid();
  const encoding = format.readUInt16LE(0), channels = format.readUInt16LE(2), sampleRate = format.readUInt32LE(4);
  const align = format.readUInt16LE(12), bits = format.readUInt16LE(14);
  if (![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 48000 || !((encoding === 1 && bits === 16) || (encoding === 3 && bits === 32)) || align !== channels * (bits / 8) || format.readUInt32LE(8) !== sampleRate * align || audio.length % align) throw invalid();
  const frames = audio.length / align;
  if (frames > maxSeconds * sampleRate) throw invalid();
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const at = i * align + c * (bits / 8), value = encoding === 1 ? audio.readInt16LE(at) / 32768 : audio.readFloatLE(at);
      if (!Number.isFinite(value) || Math.abs(value) > 1.01) throw invalid();
      mono[i] += value / channels;
    }
  }
  const count = Math.floor(frames * rate / sampleRate), pcm = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i++) {
    const position = i * sampleRate / rate, left = Math.floor(position), mix = position - left;
    pcm.writeFloatLE(mono[left] * (1 - mix) + mono[Math.min(left + 1, frames - 1)] * mix, i * 4);
  }
  return { pcm, sampleRate: rate, duration: count / rate };
}
function validatePcm(pcm) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 4 || pcm.length > rate * 4 * 60) throw Error('音频须为 16kHz、单声道 Float32 LE PCM，单段不超过 60 秒。');
  for (let at = 0; at < pcm.length; at += 4) { const v = pcm.readFloatLE(at); if (!Number.isFinite(v) || Math.abs(v) > 1.01) throw Error('音频采样格式无效。'); }
}
module.exports = { decodeWav, validatePcm, sampleRate: rate };
