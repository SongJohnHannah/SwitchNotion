// One-time runtime preparation; no desktop package is produced.
import path from 'node:path';
import { stateRoot } from './runtime-update.mjs';
import preparation from '../src/mediaocr-prepare.cjs';
try { await preparation.prepareMediaOcr({ root: path.resolve(process.argv[2] || stateRoot), progress: message => console.log(message) }); }
catch (error) { console.error(error.message); process.exitCode = 1; }
