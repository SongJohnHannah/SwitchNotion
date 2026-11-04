import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { SpeechProvider } = require('../provider.cjs');
const { createSpeechPlatform } = require('../platform.cjs');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.join(repo, '.notion-switch');
const settings = JSON.parse(fs.readFileSync(path.join(root, 'speech.local.json'), 'utf8'));
const directory = path.join(repo, 'research/speech-fixtures/soak');
const clips = fs.readdirSync(directory).filter(name => name.endsWith('.wav')).sort()
  .map(name => ({ name, wav: fs.readFileSync(path.join(directory, name)) }));
if (!clips.length) throw new Error('No soak clips found');
const logFile = path.join(root, 'custom-varied-soak.log');
const minutes = Number(process.env.SOAK_MINUTES || 12);
const log = line => {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  fs.appendFileSync(logFile, text + '\n');
};
const makeProvider = () => new SpeechProvider({ root, runtime: settings.runtime, model: settings.model,
  platform: createSpeechPlatform({ model: settings.model }) });

let provider = makeProvider();
let cycles = 0, failures = 0;
const started = Date.now();
log(`start clips=${clips.length} minutes=${minutes}`);

(async () => {
  try {
    provider.retain();
    let probe = Date.now();
    await provider.probe();
    log(`probe_ms=${Date.now() - probe}`);
    while (Date.now() - started < minutes * 60_000) {
      const clip = clips[cycles % clips.length];
      const at = Date.now();
      try {
        const text = await provider.transcribeWav({ wav: clip.wav, language: 'auto', chunkSeconds: 30 });
        log(`cycle=${cycles + 1} clip=${clip.name} ms=${Date.now() - at} chars=${text.length} text=${JSON.stringify(text.slice(0, 80))}`);
      } catch (error) {
        failures++;
        log(`cycle=${cycles + 1} clip=${clip.name} FAIL elapsed_s=${Math.round((Date.now() - started) / 1000)} error=${error.message}`);
        try { provider.close(); } catch {}
        await new Promise(resolve => setTimeout(resolve, 15000));
        provider = makeProvider(); provider.retain(); await provider.probe();
        log('provider restarted');
      }
      cycles++;
    }
  } catch (error) {
    log(`FATAL ${error.message}`);
  } finally {
    try { provider.release(); provider.close(); } catch {}
    log(`SUMMARY cycles=${cycles} failures=${failures} elapsed_s=${Math.round((Date.now() - started) / 1000)}`);
  }
})();
