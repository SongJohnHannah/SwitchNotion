import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { CollectionMedia } = require('../src/collection/media.cjs');

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'notion-operator-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), parent); fs.rmSync(directory, { recursive: true, force: true }); });
  const source = path.join(directory, 'source.mp4'); fs.writeFileSync(source, 'test-media');
  return { source, directory, asset: { path: source, kind: 'video', audio: true, duration: 2806 } };
}

test('collection calls the standalone operator once for the complete file without the old speech runtime', async t => {
  const { source, directory, asset } = fixture(t), calls = [], progress = [], controller = new AbortController();
  const records = path.join(directory, 'records');
  fs.writeFileSync(path.join(directory, 'transcript-progress.json'), JSON.stringify({ chunks: { 0: 'old partial transcript' } }));
  const media = new CollectionMedia({ root: directory, operator: { transcribeFile: async options => {
    calls.push(options); options.onProgress({ stage: 'transcribing', seconds: 60, totalSeconds: 2806, index: 2, totalChunks: 94 });
    return { text: 'Whole file transcript.', complete: true, device: 'cuda', sourceIdentity: 'owned-by-operator',
      profile: 'winner', transcriptFile: path.join(records, 'transcript.txt'), eventsFile: path.join(records, 'raw-results.jsonl'), checkpointFile: path.join(records, 'checkpoint.json') };
  } } });
  const result = await media.transcript(asset, { directory: records, signal: controller.signal, progress: message => progress.push(message) });
  assert.equal(calls.length, 1); assert.equal(calls[0].source, source); assert.equal(calls[0].outputDirectory, records);
  assert.equal(calls[0].language, 'auto'); assert.equal(calls[0].signal, controller.signal);
  assert.equal(calls[0].allowExperimental, false);
  assert.equal(result.text, 'Whole file transcript.'); assert.equal(result.device, 'cuda'); assert.equal(result.note, '');
  assert.equal(result.operator.sourceIdentity, 'owned-by-operator'); assert.equal(result.operator.eventsFile, path.join(records, 'raw-results.jsonl'));
  assert.ok(progress.some(message => /GPU/.test(message))); assert.equal(fs.existsSync(path.join(records, 'transcript-progress.json')), false);
});

test('collection explicitly forwards an experimental profile and returns to the default on the next call', async t => {
  const { directory, asset } = fixture(t), calls = [];
  const media = new CollectionMedia({ root: directory, operator: { transcribeFile: async options => {
    calls.push(options); return { text: 'text', complete: true, device: 'cuda' };
  } } });
  await media.transcript(asset, { profile: 'candidate', allowExperimental: true });
  await media.transcript(asset);
  assert.equal(calls[0].profile, 'candidate'); assert.equal(calls[0].allowExperimental, true);
  assert.equal(calls[1].profile, 'winner'); assert.equal(calls[1].allowExperimental, false);
});

test('collection preserves explicit language, operator failures and aborts without retrying through CPU', async t => {
  const { directory, asset } = fixture(t), failure = Object.assign(Error('CUDA failed; raw evidence saved'), { code: 'CUDA_FAILURE' });
  let calls = 0;
  const media = new CollectionMedia({ root: directory, speech: { probe: () => assert.fail('old runtime loaded'), transcribeWav: () => assert.fail('legacy fallback') },
    operator: { transcribeFile: async options => { calls++; assert.equal(options.language, 'en'); throw failure; } } });
  await assert.rejects(media.transcript(asset, { directory: path.join(directory, 'records'), language: 'en' }), error => error === failure);
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(media.transcript(asset, { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(calls, 1);
});
