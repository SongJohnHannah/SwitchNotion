import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollectionService } = require('../src/collection/service.cjs');
const service = new CollectionService({ root: path.resolve(import.meta.dirname, '../.notion-switch') });
try { console.log(JSON.stringify(await service.browser.login(process.argv[2], AbortSignal.timeout(60000)))); }
finally { service.close(); }
