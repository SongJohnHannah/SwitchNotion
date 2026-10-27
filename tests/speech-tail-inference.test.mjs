import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import speech from '../src/speech-provider.cjs';
import audio from '../src/meeting-audio.cjs';
import client from '../src/speech/client.cjs';

test('real offline GPU preserves English and Chinese sentence endings through two consecutive stops',
  process.env.NOTION_SWITCH_TEST_GPU === '1' ? { timeout: 120000 } : { skip: 'Explicit local GPU fixture test' }, async () => {
    const root = path.resolve('.notion-switch'), runtime = JSON.parse(fs.readFileSync(path.join(root, 'speech.local.json'))).runtime;
    const provider = new speech.SpeechProvider({ root, runtime }); provider.retain();
    const blockId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', spaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    try {
      const decode = name => speech.decodeWav(fs.readFileSync(path.resolve('research/speech-fixtures/' + name + '.wav'))).pcm;
      for (const sample of [{ name: 'en', language: 'en', start: /tribal chieftain/, end: /pieces of gold/ },
        { name: 'meeting-zh', language: 'zh', start: /项目进度/, end: /下周的负责人/ }]) {
      const events = []; let requestId = 0;
      const session = new audio.MeetingAudioSession({ provider, emit: event => events.push(event) });
      const send = (method, input = {}) => session.handle({ type: '/api/v1/' + method, requestId: String(++requestId), ...input });
      const pcm = decode(sample.name);
      await send('transcriptionInfo', { rootBlockId: blockId, spaceId });
      const frameBytes = 16000 * 4 * 2; let at = 0;
      for (; at + frameBytes <= pcm.length; at += frameBytes) await send('audioData', { blockId, spaceId, language: sample.language, base64Audio: pcm.subarray(at, at + frameBytes).toString('base64') });
      const tail = pcm.subarray(at); assert.ok(tail.length > 0 && tail.length < frameBytes);
      const state = { state: { rootBlock: { id: blockId, pointer: { spaceId } }, enabled: true }, setState(value) { this.state = value; } };
      const actions = { audioBuffer: Array.from(new Float32Array(tail.buffer.slice(tail.byteOffset, tail.byteOffset + tail.length))),
        sourceAudioBuffers: { microphone: [], system_audio: [] }, audioEncoderQueue: { afterFlush: async () => {}, enqueue: run => Promise.resolve().then(run) },
        sessionOwnership: { getCurrentGeneration: () => 1, isCurrentGeneration: () => true },
        resetAudioBuffers() { this.audioBuffer = []; },
        stopDictationAfterLocalFlush() { return { startBarrier: Promise.resolve(), revisionDrain: send('drainTranscription') }; } };
      await client.stopWithAudioFlush(actions, { environment: {} }, { state, transport: { H1() {}, async Tg() {} }, language: () => sample.language,
        encode: async pieces => Buffer.from(pieces[0].buffer).toString('base64'), send: input => send('audioData', input) }).revisionDrain;
      const completed = events.filter(event => event.transcription?.status === 'complete');
      const text = completed.map(event => event.transcription.text).join(' ').toLowerCase();
      assert.match(text, sample.start); assert.match(text, sample.end);
      const seconds = events.filter(event => ['complete', 'ignore'].includes(event.transcription?.status)).reduce((sum, event) => sum + event.transcription.audioDuration, 0);
      assert.ok(Math.abs(seconds - pcm.length / (16000 * 4)) < .001, 'No accepted audio or partial-frame tail may be omitted');
      console.log(JSON.stringify({ sample: sample.name, model: provider.status().model, durationSeconds: seconds, partialFrameSeconds: tail.length / (16000 * 4), finalSentencePresent: true }));
      session.close();
      }
    } finally { provider.close(); }
  });
