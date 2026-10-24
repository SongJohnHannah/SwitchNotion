'use strict';
class SpeechRecorder {
  constructor(api, onState) { this.api = api; this.onState = onState; this.state = 'idle'; this.generation = 0; }
  setState(state, message) { this.state = state; this.onState({ state, message }); }
  async start() {
    if (this.state !== 'idle') return;
    const generation = ++this.generation; this.setState('preparing', '正在准备本机麦克风…');
    try {
      const result = await this.api.startSpeechRecording(); if (!result.ok) throw Error(result.error);
      const recordingId = result.result.recordingId;
      if (generation !== this.generation) { await this.api.cancelSpeechRecording({ recordingId }); return; }
      this.recordingId = recordingId;
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream; this.parts = []; this.bytes = 0;
      this.recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      this.recorder.ondataavailable = event => { if (generation !== this.generation) return; if (event.data.size) { this.bytes += event.data.size; this.parts.push(event.data); if (this.bytes > 16 * 1024 * 1024) this.cancel(); } };
      this.recorder.onerror = () => this.cancel('录音未完成，请检查麦克风授权后重试。');
      this.recorder.onstop = () => void this.complete(generation);
      this.recorder.start(1000); this.started = Date.now();
      this.setState('recording', '正在录音，再次点击停止并转写。');
      this.ticker = setInterval(() => this.onState({ state: this.state, message: `正在录音 ${Math.floor((Date.now() - this.started) / 1000)} 秒，点击停止并转写。` }), 1000);
      this.limit = setTimeout(() => this.stop(), result.result.maxSeconds * 1000);
    } catch (error) {
      if (generation !== this.generation) return;
      const message = error.name === 'NotAllowedError' ? '麦克风未获授权，请在系统提示中允许录音。' : error.message || '无法打开麦克风。';
      await this.cancel(); this.onState({ state: 'error', message });
    }
  }
  stop() {
    if (this.state !== 'recording') return;
    clearInterval(this.ticker); clearTimeout(this.limit); this.setState('transcribing', '录音已停止，正在本机转写…');
    this.recorder.stop(); this.stream?.getTracks().forEach(track => track.stop());
  }
  async complete(generation) {
    if (generation !== this.generation) return;
    try {
      const data = new Blob(this.parts, { type: 'audio/webm;codecs=opus' });
      const result = await this.api.finishSpeechRecording({ recordingId: this.recordingId, audio: new Uint8Array(await data.arrayBuffer()), mimeType: data.type });
      if (generation !== this.generation) return;
      if (!result.ok) throw Error(result.error);
      this.onState({ state: 'complete', result: result.result });
    } catch (error) { if (generation === this.generation) this.onState({ state: 'error', message: error.message || '本机转写未完成。' }); }
    finally { if (generation === this.generation) await this.cancel(); }
  }
  async cancel(message) {
    this.generation++; clearInterval(this.ticker); clearTimeout(this.limit);
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null; this.parts = [];
    const recordingId = this.recordingId; this.recordingId = null;
    await this.api.cancelSpeechRecording(recordingId ? { recordingId } : {}).catch(() => {});
    this.setState('idle', message);
  }
}
window.SpeechRecorder = SpeechRecorder;
