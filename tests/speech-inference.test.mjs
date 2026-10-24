import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import speech from '../src/speech-provider.cjs';
test('real offline GPU rejects non-speech, retains genuine spoken outro and decodes browser recordings',
  process.env.NOTION_SWITCH_TEST_GPU === '1' ? { timeout: 120000 } : { skip: 'Explicit local GPU fixture test' }, async () => {
    const root = path.resolve('.notion-switch'), runtime = JSON.parse(fs.readFileSync(path.join(root, 'speech.local.json'))).runtime;
    const provider = new speech.SpeechProvider({ root, runtime });
    try {
      provider.retain(); await provider.probe();
      let seed = 123456; const pcm = Buffer.alloc(3 * 16000 * 4);
      for (let n = 0; n < pcm.length; n += 4) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pcm.writeFloatLE((seed / 4294967296 * 2 - 1) * .003, n); }
      assert.equal(await provider.transcribe({ pcm }), '');
      const outro = await provider.transcribeWav({ wav: fs.readFileSync(path.resolve('research/speech-fixtures/thanks.wav')), language: 'en' });
      assert.match(outro.toLowerCase(), /thanks for watching/);
      const text = await provider.transcribeRecording({ audio: fs.readFileSync(path.resolve('research/speech-fixtures/browser-test.webm')) });
      assert.match(text, /tribal chieftain/i);
    } finally { provider.close(); }
  });
