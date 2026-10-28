import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { CollectionService } = require('../src/collection/service.cjs');
const { SpeechSettings } = require('../src/speech/settings.cjs');
const { ProviderRouter } = require('../src/provider.cjs');
const root = path.resolve(import.meta.dirname, '../.notion-switch');
const inputFile = process.argv.find(arg => arg.endsWith('.local.json'));
if (!inputFile) throw Error('Provide an ignored local JSON file containing {urls: [...]} or {input: "share text"}.');
const input = JSON.parse(fs.readFileSync(path.resolve(inputFile), 'utf8'));
const speech = new SpeechSettings({ root }), service = new CollectionService({ root, speech: speech.provider, provider: new ProviderRouter({ root }) });
let previous = '';
service.on('change', () => {
  const job = service.running && service.jobs.get(service.running.id);
  const value = job && job.status + ' · ' + job.message;
  if (value && value !== previous) { console.log(value); previous = value; }
});
const idle = async () => { while (service.active) await sleep(500); };
try {
  if (input.browserProfile) await service.configure({ browserProfile: input.browserProfile });
  const inspect = process.argv.includes('--inspect');
  const created = await service.create({ input: input.input || input.urls.join('\n'), options: input.options || {}, preview: inspect });
  if (process.argv.includes('--reread')) for (const result of created.jobs) { const job = service.jobs.get(result.id); if (!job.page && !['queued','reading','downloading','processing','uploading','saving'].includes(job.status)) service.reread(job.id); }
  for (const result of created.jobs) { const job = service.jobs.get(result.id); if (job.status === 'needs_login') service.retry(job.id); }
  await idle();
  if (!inspect) {
    for (const result of created.jobs) { const job = service.jobs.get(result.id); if (job.status === 'awaiting_selection' && !job.document.incomplete) service.select(job.id, { ids: job.document.nodes.map(n => n.id) }); }
    await idle();
  }
  const results = created.jobs.map(result => { const job = service.jobs.get(result.id); return { id: job.id, source: job.url, status: job.status, title: job.document?.title,
    message: job.message, nodes: job.document?.nodes.length, types: job.document && Object.fromEntries(['image', 'video', 'audio', 'paragraph'].map(kind => [kind, job.document.nodes.filter(n => n.kind === kind).length])),
    textCharacters: job.document?.nodes.reduce((count, n) => count + n.text.length, 0), page: job.page, warnings: job.warnings }; });
  fs.writeFileSync(path.join(root, 'collection', 'link-acceptance.local.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results));
  if (results.some(r => !['completed', 'awaiting_selection'].includes(r.status))) process.exitCode = 2;
} finally { service.close(); speech.provider.close(); }
