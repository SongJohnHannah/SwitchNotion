import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const accelerator = require('../src/notion-accelerator.cjs');

function root(t) {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'test-accelerator-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('network settings default to direct with no pinned IP', t => {
  const directory = root(t);
  assert.deepEqual(accelerator.read(directory), { bypassVpn: false, autoIp: false, bestIp: '', checkedAt: '' });
  assert.deepEqual(accelerator.save(directory, { bypassVpn: true }), { bypassVpn: true, autoIp: false, bestIp: '', checkedAt: '' });
  assert.equal(accelerator.read(directory).bypassVpn, true);
  assert.match(accelerator.bypassList, /notion\.so/);
  assert.equal(accelerator.bypassList.includes('*'), false);
  assert.equal(accelerator.bypassList.includes('msgstore'), false);
  assert.equal(accelerator.bypassEnv.includes('msgstore'), false);
  assert.equal(accelerator.save(directory, { bypassVpn: false }).bypassVpn, false);
});

test('automatic IP selection keeps only valid addresses and builds Notion-only resolver rules', t => {
  const directory = root(t);
  const chosen = accelerator.save(directory, { autoIp: true, bestIp: '208.103.161.16', checkedAt: '2026-11-03T12:00:00.000Z' });
  assert.equal(chosen.autoIp, true);
  assert.equal(chosen.bestIp, '208.103.161.16');
  assert.equal(accelerator.hostRules(chosen.bestIp), accelerator.mappedHosts.map(host => `MAP ${host} 208.103.161.16`).join(', '));
  assert.match(accelerator.hostRules(chosen.bestIp), /MAP api\.notion\.com 208\.103\.161\.16/);
  assert.equal(accelerator.hostRules(chosen.bestIp).includes('api.pgncs.notion.so'), false);
  assert.equal(accelerator.mappedHosts.includes('msgstore.www.notion.so'), false);
  assert.equal(accelerator.hostRules(chosen.bestIp).includes('msgstore'), false);
  assert.equal(accelerator.hostRules('not-an-ip'), '');
  const kept = accelerator.save(directory, { bypassVpn: true });
  assert.equal(kept.bestIp, '208.103.161.16');
  assert.equal(kept.checkedAt, '2026-11-03T12:00:00.000Z');
  assert.equal(accelerator.save(directory, { bestIp: 'example.com' }).bestIp, '');
  assert.equal(accelerator.read(directory).autoIp, false);
});
