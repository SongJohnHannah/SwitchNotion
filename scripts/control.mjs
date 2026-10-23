import fs from 'node:fs';
import path from 'node:path';
import { stateRoot } from './prepare-desktop.mjs';

const info = JSON.parse(fs.readFileSync(path.join(stateRoot, 'control.json'), 'utf8'));
const action = process.argv[2] || 'status';
if (!['status', 'quit'].includes(action)) throw new Error('Supported actions: status, quit');
const response = await fetch(`http://127.0.0.1:${info.port}/${action}`, {
  method: action === 'quit' ? 'POST' : 'GET',
  headers: { authorization: `Bearer ${info.token}` },
  signal: AbortSignal.timeout(5000),
});
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
