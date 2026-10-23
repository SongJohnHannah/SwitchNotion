import fs from 'node:fs';
import { createRequire } from 'node:module';

// Electron virtualizes *.asar in fs; updater operations need the physical files.
export default process.versions.electron ? createRequire(import.meta.url)('original-fs') : fs;
