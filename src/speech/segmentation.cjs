const policy = require('./segmentation.json');

// Boundaries depend on the audio samples, never on transport packet size.
// Keep all samples, including pauses and a final partial analysis window.
class PcmSegmenter {
  constructor() { this.parts = []; this.bytes = 0; this.samples = 0; this.window = 0; this.energy = 0; this.silence = 0; }
  append(pcm) { if (pcm.length) { this.parts.push(pcm); this.bytes += pcm.length; } }
  take() {
    const pcm = Buffer.concat(this.parts, this.bytes);
    this.parts = []; this.bytes = 0; this.samples = 0; this.window = 0; this.energy = 0; this.silence = 0;
    return pcm;
  }
  push(pcm, emit) {
    let from = 0;
    for (let at = 0; at < pcm.length; at += 4) {
      this.samples++; this.window++; this.energy += pcm.readFloatLE(at) ** 2;
      if (this.window < policy.windowSamples) continue;
      this.silence = Math.sqrt(this.energy / this.window) < policy.silenceRms ? this.silence + this.window : 0;
      this.window = 0; this.energy = 0;
      if (this.samples >= policy.maximumSamples || this.samples >= policy.minimumSamples && this.silence >= policy.pauseSamples) {
        this.append(pcm.subarray(from, at + 4)); from = at + 4; emit(this.take());
      }
    }
    this.append(pcm.subarray(from));
  }
  flush(emit) { if (this.bytes) emit(this.take()); }
}
module.exports = { PcmSegmenter };
