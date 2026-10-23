import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { stateRoot, project } from './prepare-desktop.mjs';
const { ProviderRouter } = createRequire(import.meta.url)('../src/provider.cjs');
fs.mkdirSync(stateRoot, { recursive: true });
const file = path.join(stateRoot, 'provider.local.json');
const keyFile = path.join(stateRoot, 'deepseek-api-key.txt');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, '', { mode: 0o600 });
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { mode: 'mock', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKeyFile: 'deepseek-api-key.txt', maxTokens: 'max' };
const action = process.argv[2] || 'status';
if (!['status', 'mock', 'deepseek'].includes(action)) throw Error('Usage: node scripts/provider.mjs [status|mock|deepseek] [model]');
if (action === 'deepseek') {
  const validation = path.join(project, 'research', 'native-validation.json');
  if (!fs.existsSync(validation) || !JSON.parse(fs.readFileSync(validation, 'utf8')).pass) throw Error('Complete the native mock validation before enabling DeepSeek');
  config.mode = 'deepseek'; if (process.argv[3]) config.model = process.argv[3];
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  const router = new ProviderRouter({ root: stateRoot });
  if (!router.key(router.config())) { config.mode = 'mock'; fs.writeFileSync(file, JSON.stringify(config, null, 2)); throw Error('Fill the local deepseek-api-key.txt first; mock mode retained'); }
} else {
  if (action === 'mock') config.mode = 'mock';
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}
console.log(JSON.stringify(new ProviderRouter({ root: stateRoot }).status(), null, 2));
