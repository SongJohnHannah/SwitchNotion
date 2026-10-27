import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import speech from '../src/speech-provider.cjs';
import audio from '../src/meeting-audio.cjs';

test('a continuous recording preserves both languages when the speaker changes between English and Chinese',
  process.env.NOTION_SWITCH_TEST_GPU === '1' ? { timeout: 120000 } : { skip: 'Explicit local GPU bilingual acceptance test' }, async t => {
    const root = path.resolve('.notion-switch'), runtime = JSON.parse(fs.readFileSync(path.join(root, 'speech.local.json'))).runtime;
    const provider = new speech.SpeechProvider({ root, runtime }); provider.retain();
    const decode = name => speech.decodeWav(fs.readFileSync(path.resolve('research/speech-fixtures/' + name + '.wav'))).pcm;
    try {
      for (const order of [['en', 'meeting-zh'], ['meeting-zh', 'en']]) await t.test(order.join(' → '), async () => {
        const blockId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', spaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const pcm = Buffer.concat([decode(order[0]), Buffer.alloc(64000), decode(order[1])]), events = [];
        const session = new audio.MeetingAudioSession({ provider, emit: event => events.push(event) }); let id = 0;
        const send = (method, input = {}) => session.handle({ type: '/api/v1/' + method, requestId: String(++id), ...input });
        try {
          await send('transcriptionInfo', { rootBlockId: blockId, spaceId });
          for (let at = 0; at < pcm.length; at += 128000) await send('audioData', { blockId, spaceId, language: 'en-US',
            base64Audio: pcm.subarray(at, Math.min(pcm.length, at + 128000)).toString('base64') });
          await send('drainTranscription');
          const done = events.filter(event => ['complete', 'ignore'].includes(event.transcription?.status));
          assert.ok(Math.abs(done.reduce((sum, event) => sum + event.transcription.audioDuration, 0) - pcm.length / 64000) < .001,
            'All audio samples must be delivered even when text is omitted');
          const text = done.map(event => event.transcription.text || '').join(' ');
          assert.match(text, /tribal chieftain/i, 'The English section must not disappear');
          assert.match(text, /pieces of gold/i, 'The English ending must remain in English');
          assert.match(text, /下周的负责人/, 'The Chinese section must not disappear');
          const direct = await provider.transcribeDetailed({ pcm, language: 'auto', context: '这是上一句中文，不应该影响下一句英文。' });
          assert.match(direct.text, /tribal chieftain/i, 'Configuration recordings and SDK inputs must also retain English');
          assert.match(direct.text, /下周的负责人/, 'Configuration recordings and SDK inputs must also retain Chinese');
          console.log(JSON.stringify({ order, model: provider.status().model, nativeText: text, directText: direct.text,
            processedSeconds: pcm.length / 64000 }));
        } finally { session.close(); }
      });
    } finally { provider.close(); }
  });
