import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseBuildStoreFixture } from './helpers/native-database-build-store.mjs';
import { buildId } from './helpers/native-database-build.mjs';

test('native builder preflight produces a source-bound preview without saving records', async () => {
  const f = databaseBuildStoreFixture(), plan = await f.store.prepare(f.draft, f.parentPointer);
  assert.equal(f.writes().length, 0); assert.match(plan.parentHash, /^[a-f0-9]{64}$/);
  assert.equal(plan.step.threadOperations.at(-1).operation.args.after, f.childId);
  assert.equal(plan.userId, f.ids.user); assert.equal(plan.spaceId, f.ids.space);
});

test('a confirmed native plan creates one database transaction and independent readback verifies all fields and links', async () => {
  const f = databaseBuildStoreFixture(), plan = await f.store.prepare(f.draft, f.parentPointer); let submitted = 0;
  await f.store.submit(plan, { confirmation: f.confirmation(plan), onSubmit: () => { submitted++; } }); const result = await f.store.verify(plan);
  assert.equal(submitted, 1); assert.equal(f.writes().length, 1); assert.equal(result.ok, true);
  assert.equal(result.recordMap.block[plan.databaseId].value.value.collection_id, plan.collectionId);
  assert.deepEqual(f.records.get('block:' + f.ids.parent).content, [f.childId, plan.databaseId]);
  assert.equal(f.writes()[0].payload.transactions[0].id, plan.transactionId);
});

test('a repeated confirmation or a response lost after commit reads the same planned IDs instead of creating again', async () => {
  const f = databaseBuildStoreFixture(), plan = await f.store.prepare(f.draft, f.parentPointer); f.setBehavior('after-error');
  await assert.rejects(f.store.submit(plan, { confirmation: f.confirmation(plan) }), /Response lost/); assert.equal((await f.store.verify(plan)).ok, true);
  const repeat = await f.store.submit(plan, { confirmation: f.confirmation(plan) }); assert.equal(repeat.reused, true); assert.equal(f.writes().length, 1);
});

test('changed parent placement, revoked permissions and a foreign identity prevent the first transaction', async () => {
  for (const change of [f => { f.records.get('block:' + f.ids.parent).content.push(buildId(99)); },
    f => { f.setRole('reader'); },
    (_f, plan) => { plan.userId = buildId(99); },
    (_f, plan) => { plan.spaceId = buildId(99); }]) {
    const f = databaseBuildStoreFixture(), plan = await f.store.prepare(f.draft, f.parentPointer); change(f, plan);
    await assert.rejects(f.store.submit(plan, { confirmation: f.confirmation(plan) })); assert.equal(f.writes().length, 0);
  }
});

test('tampered preview operations or preexisting planned records never overwrite another record', async () => {
  for (const change of [(_f, plan) => { plan.step.threadOperations[0].operation.pointer.id = buildId(98); },
    (_f, plan) => { plan.step.threadOperations[1].operation.args = { content: [buildId(99)] }; },
    (f, plan) => { f.records.set('block:' + plan.databaseId, { id: plan.databaseId, space_id: f.ids.space, type: 'page', alive: true }); }]) {
    const f = databaseBuildStoreFixture(), plan = await f.store.prepare(f.draft, f.parentPointer); change(f, plan);
    await assert.rejects(f.store.submit(plan, { confirmation: f.confirmation(plan) })); assert.equal(f.writes().length, 0);
  }
});

test('workspace-top-level previews bind the new private database page to the selected native user', async () => {
  const f = databaseBuildStoreFixture(), plan = await f.store.prepare(f.draft, { table: 'space', id: f.ids.space, spaceId: f.ids.space });
  const block = plan.step.threadOperations[0].operation.args;
  assert.equal(block.type, 'collection_view_page'); assert.equal(block.parent_table, 'space');
  assert.deepEqual(block.permissions, [{ type: 'user_permission', role: 'editor', user_id: f.ids.user }]);
  await f.store.submit(plan, { confirmation: f.confirmation(plan) }); assert.equal((await f.store.verify(plan)).ok, true);
});

test('readback is not successful when a server field or the parent link does not match the confirmed plan', async () => {
  for (const change of [(f, plan) => { f.records.get('collection:' + plan.collectionId).schema.title.name = 'wrong'; },
    (f, plan) => { const fields = f.records.get('collection:' + plan.collectionId).schema; delete Object.values(fields).find(field => field.type === 'select').options; },
    (f, plan) => { f.records.get('block:' + f.ids.parent).content = [f.childId]; }]) {
    const f = databaseBuildStoreFixture(), plan = await f.store.prepare(f.draft, f.parentPointer);
    await f.store.submit(plan, { confirmation: f.confirmation(plan) }); change(f, plan); assert.equal((await f.store.verify(plan)).ok, false);
  }
});

test('a top-level database that does not retain the confirmed private permission is never reported verified', async () => {
  const f = databaseBuildStoreFixture(), plan = await f.store.prepare(f.draft, { table: 'space', id: f.ids.space, spaceId: f.ids.space });
  await f.store.submit(plan, { confirmation: f.confirmation(plan) }); f.records.get('block:' + plan.databaseId).permissions = [{ type: 'space_permission', role: 'editor' }];
  assert.equal((await f.store.verify(plan)).ok, false);
});

test('missing, rejected or mismatched confirmation receipts cannot start a native database transaction', async () => {
  const f = databaseBuildStoreFixture(), plan = await f.store.prepare(f.draft, f.parentPointer), reads = f.calls.length;
  for (const receipt of [undefined, { ...f.confirmation(plan), decision: 'rejected' }, { ...f.confirmation(plan), userId: buildId(90) },
    { ...f.confirmation(plan), spaceId: buildId(91) }, { ...f.confirmation(plan), stepId: buildId(92) }, { ...f.confirmation(plan), planHash: 'changed' }]) {
    await assert.rejects(f.store.submit(plan, { confirmation: receipt }), /确认/);
  }
  assert.equal(f.calls.length, reads); assert.equal(f.writes().length, 0);
});
