import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { CollectionService } = require('../src/collection/service.cjs'), { selectedNodes } = require('../src/collection/model.cjs'), { matchesBlockContent } = require('../src/notion-blocks.cjs'), { openResponse } = require('../src/collection/network.cjs');
const root = path.resolve(import.meta.dirname, '../.notion-switch'), file = process.argv.find(value => value.endsWith('.local.json'));
if (!file) throw Error('Provide ignored local input containing {urls:[...]}. This command only reads Notion.');
const input = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')), service = new CollectionService({ root }), output = path.join(root, 'collection', 'acceptance-media');
fs.mkdirSync(output, { recursive: true });
try {
  const results = [];
  for (const url of input.urls) {
    const job = [...service.jobs.values()].find(job => job.url === url && job.status === 'completed'); assert.ok(job, 'No completed job for provided source');
    const signal = AbortSignal.timeout(120000), c = await service.notion.connect(job.options.destination, signal, 'collection-acceptance:' + job.id);
    if (job.options.destination.kind === 'database') { const entry = await c.session.execute('read_database_entry', { page_id: job.page.id }); if (job.managedStatus) assert.equal(entry.properties['处理状态'], '已保存'); }
    const blocks = []; let cursor;
    do { const batch = await c.session.execute('read_block_children', { block_id: job.page.id, ...(cursor ? { start_cursor: cursor } : {}) }); blocks.push(...batch.results); cursor = batch.next_cursor; } while (cursor);
    const echoes = new Map();
    for (const name of fs.readdirSync(path.join(root, 'write-journal')).filter(name => /^content-[a-f\d]{64}\.json$/.test(name))) {
      const record = JSON.parse(fs.readFileSync(path.join(root, 'write-journal', name), 'utf8'));
      if (record.operation_scope?.startsWith('collection:' + job.id)) for (const block of record.response?.results || []) echoes.set(block.id, block);
    }
    let position = -1, images = 0, videos = 0, audioVerified = false;
    for (const node of selectedNodes(job.document, job.options, job.selectedIds)) {
      const slot = job.sourceSlots[node.id]; assert.ok(slot && !slot.placeholder);
      let duration = 0;
      for (const [part, id] of slot.ids.entries()) {
        const index = blocks.findIndex(block => block.id === id); assert.ok(index > position, 'Source order changed'); position = index;
        const block = blocks[index]; assert.equal(matchesBlockContent(block, slot.original[part], slot.echo || echoes.get(id)), true, 'Source content differs from saved plan');
        if (block.type === 'image') images++;
        if (block.type !== 'video') continue;
        videos++; assert.equal(block.video.type, 'file');
        const prefix = path.join(output, job.id + '-' + part + '.mp4'), stream = await openResponse(block.video.file.url, { signal, headers: { range: 'bytes=0-4194303' } });
        const chunks = []; let bytes = 0;
        try { for await (const chunk of stream) { const remaining = 4194304 - bytes; chunks.push(chunk.subarray(0, remaining)); bytes += Math.min(chunk.length, remaining); if (bytes >= 4194304) break; } fs.writeFileSync(prefix, Buffer.concat(chunks));
          let metadata;
          try { metadata = await service.media.probe(prefix, signal); }
          catch (error) {
            // Some original MP4s keep moov metadata at the end. Verify small
            // originals in full rather than mistaking a prefix for corruption.
            const total = Number(String(stream.headers['content-range'] || '').split('/')[1] || stream.headers['content-length']);
            if (!total || total <= bytes || total > 64 * 1024 ** 2) throw error;
            const full = await openResponse(block.video.file.url, { signal }), content = []; let size = 0;
            try { for await (const chunk of full) { size += chunk.length; if (size > 64 * 1024 ** 2) throw Error('Verification file exceeds its bounded limit'); content.push(chunk); } }
            finally { full.destroy(); }
            assert.equal(size, total); fs.writeFileSync(prefix, Buffer.concat(content)); metadata = await service.media.probe(prefix, signal);
          }
          duration += metadata.duration;
          if (job.resources[node.id].asset.audio) { assert.equal(metadata.audio, true, 'Uploaded video has no audio'); audioVerified = true; }
        } finally { stream.destroy(); if (fs.existsSync(prefix)) fs.unlinkSync(prefix); }
      }
      if (node.kind === 'video') assert.ok(Math.abs(duration - job.resources[node.id].asset.duration) < Math.max(.5, slot.ids.length * .1));
    }
    const text = blocks.map(block => (block[block.type]?.rich_text || []).map(span => span.plain_text ?? span.text?.content ?? '').join('')).join('');
    for (const analysis of Object.values(job.analyses)) for (const kind of ['transcript', 'vision']) if (analysis[kind]?.text) assert.ok(text.includes(analysis[kind].text), 'Complete analysis text missing');
    results.push({ id: job.id, status: job.status, page: job.page.url, sourceOrderVerified: true, fullTextVerified: true, images, videos, uploadedAudioVerified: audioVerified });
  }
  fs.writeFileSync(path.join(root, 'collection', 'saved-acceptance.local.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results));
} finally { service.close(); }
