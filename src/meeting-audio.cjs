const { randomUUID } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { PcmSegmenter } = require('./speech/segmentation.cjs');
const FRAME_LIMIT = 16000 * 4 * 2;
const QUEUE_LIMIT = 16000 * 4 * 600;
class MeetingAudioSession {
  constructor({ root, provider, emit, inputMode = 'meeting', authorize = async () => {}, onActivity = () => {}, onTranscript = () => {} }) {
    if (!['microphone', 'meeting'].includes(inputMode)) throw Error('录音来源设置无效。');
    this.inputMode = inputMode;
    this.root = root; this.provider = provider; this.emit = emit; this.authorize = authorize; this.onActivity = onActivity; this.onTranscript = onTranscript;
    this.id = randomUUID(); this.context = null; this.sources = new Map(); this.seen = new Map(); this.jobs = Promise.resolve(); this.queuedBytes = 0; this.closed = false; this.failure = null; this.abort = new AbortController(); this.drained = false;
  }
  settings() {
    const status = this.provider.status?.() || {};
    this.emit({ type: 'audio_writer_settings', settings: { max_block_char_size: 1800,
      transcription_model: 'no_diarization', supports_transcription_drain: true, supports_speaker_revisions: false,
      transcription_model_detail: `NotionSwitch / ${status.provider || 'local'} ${status.model || ''} ${status.device || ''} · offline` } });
  }
  async handle(input) {
    if (!input || typeof input !== 'object' || typeof input.requestId !== 'string' || input.requestId.length > 100 || !/^\/api\/v1\/[a-zA-Z]+$/.test(input.type || '')) throw Error('音频请求格式无效。');
    if (this.seen.has(input.requestId)) { const value = await this.seen.get(input.requestId); this.emit(value); return; }
    if (this.seen.size > 100000) throw Error('单次录音过长，请停止并新建录音。');
    const method = input.type.split('/').pop();
    const job = this.dispatch(method, input).then(result => ({ type: 'response', requestId: input.requestId, status: 'ok', result: { method, result: result || {} } }));
    this.seen.set(input.requestId, job);
    try { this.emit(await job); } catch (e) { this.seen.delete(input.requestId); throw e; }
  }
  async dispatch(method, input) {
    if (this.closed) throw Error('录音连接已结束。');
    if (method === 'clientInfo' || method === '_placeholder') { this.settings(); return {}; }
    if (method === 'transcriptionInfo') {
      const blockId = uuid(input.rootBlockId), spaceId = uuid(input.spaceId);
      if (!blockId || !spaceId) throw Error('会议页面标识无效。');
      const changed = this.context && (this.context.blockId !== blockId || this.context.spaceId !== spaceId);
      if (changed && !this.drained) throw Error('一个活动录音连接不能切换会议页面。');
      await this.authorize({ blockId, spaceId }); if (changed) this.sources.clear();
      this.context = { blockId, spaceId }; this.drained = false; this.settings(); this.onActivity(true); return {};
    }
    if (method === 'transcriptionSettings') return { result: 'success' };
    if (method === 'audioData') {
      if (!this.context || uuid(input.blockId) !== this.context.blockId || uuid(input.spaceId) !== this.context.spaceId) throw Error('音频与当前会议不匹配。');
      if (this.drained) throw Error('录音已结束，请重新开始。');
      if (this.failure) throw this.failure;
      if (typeof input.base64Audio !== 'string' || input.base64Audio.length > Math.ceil(FRAME_LIMIT / 3) * 4 || !/^[A-Za-z\d+/]+={0,2}$/.test(input.base64Audio)) throw Error('音频帧格式无效。');
      const bytes = Buffer.from(input.base64Audio, 'base64');
      if (!bytes.length || bytes.length > FRAME_LIMIT || bytes.length % 4 || bytes.toString('base64') !== input.base64Audio) throw Error('音频帧格式无效。');
      for (let i = 0; i < bytes.length; i += 4) { const n = bytes.readFloatLE(i); if (!Number.isFinite(n) || Math.abs(n) > 1.01) throw Error('音频采样格式无效。'); }
      const source = input.audioSource || 'microphone'; if (!['microphone', 'system_audio'].includes(source)) throw Error('音频来源无效。');
      if (this.inputMode === 'microphone' && source === 'system_audio') return {};
      const buffered = [...this.sources.values()].reduce((sum, state) => sum + state.segmenter.bytes, 0);
      if (this.queuedBytes + buffered + bytes.length > QUEUE_LIMIT) throw Error('转写积压超过十分钟，请停止录音并等待处理完成；已接收的音频会继续转写。');
      const state = this.sources.get(source) || { segmenter: new PcmSegmenter(), offset: 0, context: '' };
      this.sources.set(source, state);
      state.segmenter.push(bytes, pcm => this.enqueue(source, state, pcm));
      return {};
    }
    if (['drainTranscription', 'audioFinished', 'destroySession'].includes(method)) {
      for (const [source, state] of this.sources) state.segmenter.flush(pcm => this.enqueue(source, state, pcm));
      await this.jobs; this.drained = true; this.onActivity(false); if (this.failure) throw this.failure;
      return {};
    }
    throw Error('尚未支持此音频操作。');
  }
  enqueue(source, state, pcm) {
    const duration = pcm.length / (16000 * 4), start = state.offset, audioSessionId = randomUUID();
    state.offset += duration;
    this.queuedBytes += pcm.length; const id = randomUUID();
    const frame = (status, text = '') => ({ type: 'transcription', audioSessionId, segmentId: id, isAudioSessionComplete: status !== 'pending', isSegmentComplete: status !== 'pending', audioSource: source, segmentSortkey: start * 1000, hasUnreliableTranscriptTiming: true, serverSentAtMs: Date.now(), transcription: { id, status, audioDuration: duration, ...(status === 'complete' ? { text, audioStartMs: start * 1000, audioEndMs: (start + duration) * 1000 } : {}) } });
    this.emit(frame('pending'));
    this.jobs = this.jobs.then(async () => {
      if (this.closed || this.failure) return;
      // Notion's preferred dictation language can default to English even
      // when the speaker is Chinese. Native meeting input is always bilingual.
      const options = { pcm, language: 'auto', context: state.context || '', signal: this.abort.signal };
      const result = this.provider.transcribeDetailed ? await this.provider.transcribeDetailed(options) : { text: await this.provider.transcribe(options) };
      if (this.closed) return;
      const text = result.text; state.context = typeof result.context === 'string' ? result.context.slice(-120) : '';
      if (text.trim()) this.onTranscript({ ...this.context, id, text, source, start, duration });
      this.emit(frame(text.trim() ? 'complete' : 'ignore', text));
    }).catch(() => { this.failure = Error('本机语音转写失败，请停止录音后在配置中检测引擎。'); this.onActivity(false); this.emit({ type: 'openai_error', message: this.failure.message }); }).finally(() => { this.queuedBytes -= pcm.length; });
  }
  close() { this.closed = true; this.abort.abort(); this.sources.clear(); this.onActivity(false); }
}
module.exports = { MeetingAudioSession };
