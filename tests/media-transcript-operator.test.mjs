import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { MediaTranscript } = require('../src/media-transcript.cjs'), { GpuOperatorClient } = require('../src/speech/operator-client.cjs');

function fixture(t, execute) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'media-operator-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = [];
  const operator = new GpuOperatorClient({ root, directory: path.join(root, 'bundle'), loader: () => ({ transcribeFile: async options => {
    calls.push(options); fs.mkdirSync(options.outputDirectory, { recursive: true });
    const eventsFile = path.join(options.outputDirectory, 'raw-results.jsonl'), checkpointFile = path.join(options.outputDirectory, 'checkpoint.json');
    fs.writeFileSync(eventsFile, '{"event":"result"}\n'); fs.writeFileSync(checkpointFile, '{"parts":[]}');
    if (execute) await execute(options);
    return { text: 'A complete GPU transcript.', device: 'cuda', complete: true, sourceIdentity: 'operator-owned', eventsFile, checkpointFile };
  } }) });
  const media = new MediaTranscript({ root, operator, binaries: {}, speech: { probe: () => assert.fail('old GPU provider must not load') }, chooseOpen: async () => path.join(root, 'video.mp4') });
  media.backend.probe = async () => ({ audio: true, duration: 60 });
  return { root, media, calls };
}

test('file picker forwards the original file to GPU and keeps diagnostics independently of temporary files', async t => {
  const { root, media, calls } = fixture(t), source = path.join(root, 'video.mp4'); fs.writeFileSync(source, 'original video');
  assert.equal((await media.request('transcript.start')).ok, true); await media.queue;
  const status = media.status(); assert.equal(status.status, 'completed'); assert.equal(status.device, 'cuda');
  assert.equal(calls.length, 1); assert.equal(calls[0].source, source); assert.equal(calls[0].language, 'auto');
  assert.ok(fs.existsSync(status.operator.eventsFile)); assert.ok(fs.existsSync(status.operator.checkpointFile));
  assert.equal(fs.readFileSync(source, 'utf8'), 'original video'); assert.equal(fs.existsSync(path.join(root, 'media-transcripts')), false);
});

test('attachments keep one source and let the standalone operator verify reuse instead of trusting old text cache', async t => {
  const { root, media, calls } = fixture(t), bytes = Buffer.from('same attachment bytes');
  const oldKey = createHash('sha256').update(bytes).update(JSON.stringify(['audio-transcript-v1', 'configured'])).digest('hex');
  fs.mkdirSync(path.join(root, 'media-transcripts')); fs.writeFileSync(path.join(root, 'media-transcripts', oldKey + '.json'), JSON.stringify({ cacheKey: oldKey, text: 'stale legacy transcript' }));
  const first = await media.parse(bytes, 'voice.wav', 'audio/wav'), second = await media.parse(bytes, 'renamed.wav', 'audio/wav');
  assert.equal(first.text, 'A complete GPU transcript.'); assert.equal(second.filename, 'renamed.wav'); assert.equal(calls.length, 2);
  assert.equal(calls[0].source, calls[1].source); assert.equal(calls[0].outputDirectory, calls[1].outputDirectory);
  assert.equal(fs.readdirSync(path.join(root, 'media-transcripts', 'sources')).length, 1);
  assert.ok(fs.existsSync(first.operator.eventsFile)); assert.ok(fs.existsSync(first.operator.checkpointFile));
});

test('failed and cancelled file operations keep original diagnostics and never emit cached successful text', async t => {
  const failure = Object.assign(Error('GPU native exit; diagnostic retained'), { code: 'CUDA_EXIT' });
  const { root, media, calls } = fixture(t, async () => { throw failure; });
  await assert.rejects(media.parse(Buffer.from('attachment'), 'voice.wav', 'audio/wav'), error => error === failure);
  assert.ok(fs.existsSync(path.join(calls[0].outputDirectory, 'raw-results.jsonl')));
  assert.ok(fs.existsSync(path.join(calls[0].outputDirectory, 'checkpoint.json')));
  fs.writeFileSync(path.join(root, 'video.mp4'), 'original'); await media.request('transcript.start'); await media.queue;
  const status = media.status(); assert.equal(status.status, 'failed'); assert.equal(status.errorCode, 'CUDA_EXIT'); assert.equal(status.text, '');
  assert.equal(status.error, failure.message);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(media.parse(Buffer.from('attachment'), 'voice.wav', 'audio/wav', { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(calls.length, 2);
});
