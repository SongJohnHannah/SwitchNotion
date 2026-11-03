import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const probe = require('../src/notion-ip-probe.cjs');
const accelerator = require('../src/notion-accelerator.cjs');

test('probing picks the fastest address that completes a Notion TLS handshake', async () => {
  const times = { '1.1.1.1': 300, '2.2.2.2': 90, '3.3.3.3': null };
  const result = await probe.check({ lookup: async () => Object.keys(times).map(address => ({ address, family: 4 })), handshakeImpl: async ip => times[ip] });
  assert.equal(result.host, 'api.notion.com');
  assert.equal(result.best.ip, '2.2.2.2');
  assert.deepEqual(result.candidates.map(row => row.ip), ['2.2.2.2', '1.1.1.1', '3.3.3.3']);
  assert.equal(result.candidates.at(-1).ms, null);
});

test('refresh stores the fastest address and keeps the previous one when every probe fails', async t => {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'test-ip-probe-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const saved = await probe.refresh(directory, { lookup: async () => ['9.9.9.9', '8.8.8.8'], handshakeImpl: async ip => ip === '8.8.8.8' ? 55 : null });
  assert.equal(saved.saved, true);
  const settings = accelerator.read(directory);
  assert.equal(settings.bestIp, '8.8.8.8');
  assert.ok(Number.isFinite(Date.parse(settings.checkedAt)));
  const failed = await probe.refresh(directory, { lookup: async () => { throw Error('dns'); }, handshakeImpl: async () => null });
  assert.equal(failed.saved, false);
  assert.equal(accelerator.read(directory).bestIp, '8.8.8.8');
});
