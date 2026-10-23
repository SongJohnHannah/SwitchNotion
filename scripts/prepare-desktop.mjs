import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRuntime } from './runtime-update.mjs';
export { project, stateRoot, runtime } from './runtime-update.mjs';
export { reviewedBuilds, assertReviewedBuild } from './desktop-compat.mjs';

export function prepare(source, options = {}) { return prepareRuntime({ ...options, ...(source ? { source } : {}) }); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(prepare(process.argv[2]), null, 2));
