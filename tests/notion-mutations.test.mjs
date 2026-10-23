import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createMutator } = createRequire(import.meta.url)('../src/notion-mutations.cjs');
function fixture(t, extra = {}) {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-content-mutations-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  let blocked = false, writes = 0;
  const mutate = createMutator({ root, workspaceId: 'fixture', operationScope: 'fixture', request: async () => { writes++; return { id: 'fixture-created-id' }; }, isBlocked: () => blocked, onUncertain: () => { blocked = true; }, ...extra });
  return { root, mutate, writes: () => writes, blocked: () => blocked };
}
const spec = { name: 'create_page', target: 'fixture-parent', args: { title: 'fixture' }, method: 'POST', endpoint: 'pages', body: { parent: 'fixture-parent', title: 'fixture' }, verify: async response => ({ page_id: response.id, verified: true }) };
test('new content operations persist created IDs before readback and deduplicate verified requests', async t => {
  const f = fixture(t);
  const first = await f.mutate({ ...spec, verify: async response => {
    const journal = JSON.parse(fs.readFileSync(path.join(f.root, 'write-journal', fs.readdirSync(path.join(f.root, 'write-journal'))[0]), 'utf8'));
    assert.equal(journal.status, 'submitted'); assert.equal(journal.response.id, response.id);
    return { page_id: response.id, verified: true };
  } });
  const repeated = await f.mutate({ ...spec, body: { title: 'fixture', parent: 'fixture-parent' } });
  assert.equal(first.verified, true); assert.equal(repeated.duplicate, true); assert.equal(f.writes(), 1);
});
test('failed verification retains the created ID, blocks later writes, and cannot replay after restart', async t => {
  const f = fixture(t);
  await assert.rejects(f.mutate({ ...spec, verify: async () => { throw Error('Notion readback unavailable'); } }), /readback/);
  assert.equal(f.blocked(), true); assert.equal(f.writes(), 1);
  await assert.rejects(f.mutate({ ...spec, target: 'other' }), /停止后续写入/);
  let repeated = false;
  const restarted = createMutator({ root: f.root, workspaceId: 'fixture', operationScope: 'fixture', request: async () => { repeated = true; } });
  await assert.rejects(restarted(spec), /不能重复提交/); assert.equal(repeated, false);
  const journal = JSON.parse(fs.readFileSync(path.join(f.root, 'write-journal', fs.readdirSync(path.join(f.root, 'write-journal'))[0]), 'utf8'));
  assert.equal(journal.response.id, 'fixture-created-id'); assert.equal(journal.status, 'uncertain');
});
test('read-only content operations are rejected before any submission', async t => {
  const f = fixture(t, { readOnly: true });
  await assert.rejects(f.mutate(spec), /只读/); assert.equal(f.writes(), 0);
});
