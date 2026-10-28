// Real-source acceptance without retaining a completed task history.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { CollectionService } = require('../src/collection/service.cjs');
const { SpeechSettings } = require('../src/speech/settings.cjs');
const { ProviderRouter } = require('../src/provider.cjs');
const { matchesBlockContent } = require('../src/notion-blocks.cjs');
const { download } = require('../src/collection/network.cjs');
const root = path.resolve(import.meta.dirname, '../.notion-switch');
const inputFile = process.argv.find(arg => arg.endsWith('.local.json'));
if (!inputFile) throw Error('Provide an ignored local input file with {input:"source"} or {urls:[...]}.');
const input = JSON.parse(fs.readFileSync(path.resolve(inputFile), 'utf8'));
const speech = new SpeechSettings({ root }), service = new CollectionService({ root, speech: speech.provider, provider: new ProviderRouter({ root }) });
const snapshots = new Map(), hashes = new Map(), captureErrors = new Map(), results = []; let previous = '';
service.on('change', () => {
  const job = service.running && service.jobs.get(service.running.id), progress = job && job.status + ' · ' + job.message;
  if (progress && progress !== previous) { console.log(progress); previous = progress; }
  if (job) for (const [nodeId, resource] of Object.entries(job.resources)) for (const [index, part] of (resource.parts || []).entries()) {
    const key = job.id + ':' + nodeId + ':' + index;
    if (hashes.has(key) || !fs.existsSync(part.path)) continue;
    const bytes = fs.statSync(part.path).size;
    hashes.set(key, { bytes, sha256: bytes <= 64 * 1024 ** 2 ? createHash('sha256').update(fs.readFileSync(part.path)).digest('hex') : null });
  }
});
service.on('finished', ({ id }) => {
  try {
  const job = structuredClone(service.jobs.get(id)), echoes = new Map(), files = new Map();
  for (const name of fs.readdirSync(path.join(root, 'write-journal')).filter(name => /^content-[a-f\d]{64}\.json$/.test(name))) {
    let record; try { record = JSON.parse(fs.readFileSync(path.join(root, 'write-journal', name), 'utf8')); } catch { continue; }
    if (record.operation_scope === 'collection:' + id || record.operation_scope?.startsWith('collection:' + id + ':')) for (const block of record.response?.results || []) echoes.set(block.id, block);
  }
  for (const [nodeId, resource] of Object.entries(job.resources)) for (const [index, part] of (resource.parts || []).entries()) files.set(nodeId + ':' + index, {
    ...hashes.get(id + ':' + nodeId + ':' + index)
  });
  snapshots.set(id, { job, echoes, files });
  } catch { captureErrors.set(id, true); }
});
try {
  const created = await service.create({ input: input.input || input.urls.join('\n'), options: input.options || {} });
  while (service.active) await sleep(400);
  for (const [sourceIndex, result] of created.jobs.entries()) {
    const captured = snapshots.get(result.id), current = service.jobs.get(result.id);
    if (!captured || captured.job.status !== 'completed') { results.push({ id: result.id, status: current?.status, message: current?.message, page: current?.page?.url, verified: false }); continue; }
    const { job, echoes, files } = captured, signal = AbortSignal.timeout(180000); assert.equal(captureErrors.has(job.id), false, 'Acceptance capture failed');
    const c = await service.notion.connect(job.options.destination, signal, 'collection-live-verify:' + job.id);
    const blocks = []; let cursor;
    do { const response = await c.session.execute('read_block_children', { block_id: job.page.id, ...(cursor ? { start_cursor: cursor } : {}) }); blocks.push(...response.results); cursor = response.next_cursor; } while (cursor);
    const expected = job.writeGroups.flat(), ids = job.written.flat(); let position = -1;
    for (let i = 0; i < ids.length; i++) {
      const index = blocks.findIndex(block => block.id === ids[i]); assert.ok(index > position, 'Saved block order differs'); position = index;
      assert.equal(matchesBlockContent(blocks[index], expected[i], echoes.get(ids[i])), true, 'Independently read content differs');
    }
    const imageNodes = job.document.nodes.filter(node => node.kind === 'image' && job.sourceSlots[node.id]);
    const videoNodes = job.document.nodes.filter(node => node.kind === 'video' && job.sourceSlots[node.id]);
    const expectation = input.expectations?.[sourceIndex];
    if (expectation?.images !== undefined) assert.equal(imageNodes.length, expectation.images, 'Source image count differs');
    if (expectation?.videos !== undefined) assert.equal(videoNodes.length, expectation.videos, 'Source video count differs');
    const images = [];
    for (const node of imageNodes) {
      const ids = job.sourceSlots[node.id].ids;
      assert.equal(ids.length, 1);
      const block = blocks.find(block => block.id === ids[0]); assert.equal(block.image.type, 'file');
      const original = files.get(node.id + ':0'); assert.ok(original.bytes <= 64 * 1024 ** 2);
      const output = path.join(root, 'collection', job.id + '-verify-' + node.id + '.image');
      try {
        await download(block.image.file.url, output, { signal, maxBytes: 64 * 1024 ** 2 });
        assert.equal(createHash('sha256').update(fs.readFileSync(output)).digest('hex'), original.sha256, 'Saved image bytes differ from uploaded original');
        const metadata = await service.media.probe(output, signal);
        images.push({ width: metadata.width, height: metadata.height, originalBytesVerified: true });
      } finally { if (fs.existsSync(output)) fs.unlinkSync(output); }
    }
    const videos = [];
    for (const node of videoNodes) {
      let duration = 0, audio = false;
      for (const [part, id] of job.sourceSlots[node.id].ids.entries()) {
        const block = blocks.find(block => block.id === id); assert.equal(block.video.type, 'file');
        const original = files.get(node.id + ':' + part); assert.ok(original.bytes <= 64 * 1024 ** 2, 'Acceptance downloads are bounded to 64 MiB per part');
        const output = path.join(root, 'collection', job.id + '-verify-' + part + '.mp4');
        try {
          await download(block.video.file.url, output, { signal, maxBytes: 64 * 1024 ** 2 });
          assert.equal(createHash('sha256').update(fs.readFileSync(output)).digest('hex'), original.sha256, 'Saved video bytes differ from uploaded original');
          const metadata = await service.media.probe(output, signal); duration += metadata.duration; audio ||= metadata.audio;
        } finally { if (fs.existsSync(output)) fs.unlinkSync(output); }
      }
      assert.ok(Math.abs(duration - job.resources[node.id].asset.duration) < .5, 'Saved duration differs');
      if (job.resources[node.id].asset.audio) assert.equal(audio, true, 'Saved video has no audio');
      videos.push({ duration, audio, originalBytesVerified: true });
    }
    const text = blocks.map(block => (block[block.type]?.rich_text || []).map(span => span.plain_text ?? span.text?.content ?? '').join('')).join('');
    let transcriptCharacters = 0;
    for (const item of Object.values(job.analyses)) if (item.transcript?.text) { assert.ok(text.includes(item.transcript.text), 'Complete transcript missing'); transcriptCharacters += item.transcript.text.length; }
    const aiIndex = blocks.findIndex(block => block.heading_1?.rich_text?.some(span => (span.plain_text ?? span.text?.content ?? '').startsWith('AI 提取结果')));
    if (job.extraction?.text) { assert.ok(aiIndex >= 0); for (const node of [...imageNodes, ...videoNodes]) assert.ok(blocks.findIndex(block => block.id === job.sourceSlots[node.id].ids.at(-1)) < aiIndex); }
    results.push({ id: job.id, status: 'completed', page: job.page.url, sourceOrderVerified: true, fullContentVerified: true, images, videos,
      transcriptCharacters, aiCharacters: job.extraction?.text?.length || 0, historyCleared: !fs.existsSync(path.join(root, 'collection/jobs', job.id)) });
  }
  fs.writeFileSync(path.join(root, 'collection', 'live-verification.local.json'), JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(results)); if (results.some(result => result.status !== 'completed' || result.verified === false)) process.exitCode = 2;
} finally { service.close(); speech.provider.close(); }
