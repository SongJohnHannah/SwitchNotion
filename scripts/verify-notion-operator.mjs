import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollectionMedia } = require('../src/collection/media.cjs');
const [source, outputDirectory] = process.argv.slice(2);
if (!source || !outputDirectory) throw Error('需要音视频路径和全新验收输出目录。');
const output = path.resolve(outputDirectory);
if (fs.existsSync(path.join(output, 'checkpoint.json'))) throw Error('整片独立验收不接受旧检查点。');
fs.mkdirSync(output, { recursive: true });
const controller = new AbortController();
process.once('SIGINT', () => controller.abort(Error('已停止应用入口验收。')));
const before = performance.now();
const media = new CollectionMedia({ root: path.resolve(import.meta.dirname, '../.notion-switch') });
const bundle = media.operator.directory;
const operatorSha256 = createHash('sha256').update(fs.readFileSync(path.join(bundle, 'operator.cjs'))).digest('hex');
const result = await media.transcript({ path: path.resolve(source), kind: 'video', audio: true, duration: 2806.061 },
  { directory: output, language: 'en', signal: controller.signal, progress: message => console.log(JSON.stringify({ event: 'progress', message })) });
const receipt = { version: 1, entry: 'notionSwitch.CollectionMedia.transcript', bundleDirectory: bundle, operatorSha256,
  language: 'en', adapterWallSeconds: (performance.now() - before) / 1000, verifiedAt: new Date().toISOString(),
  timingScope: 'adapter-call includes preparation, model loading and GPU queue wait; ranking uses raw start/complete',
  complete: result.operator?.complete, device: result.device, operator: result.operator };
fs.writeFileSync(path.join(output, 'app-entry.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
