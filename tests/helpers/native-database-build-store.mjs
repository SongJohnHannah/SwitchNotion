import { createRequire } from 'node:module';
import { buildIds, buildId, databaseBuildDraft } from './native-database-build.mjs';
const { NativeBuildStore } = createRequire(import.meta.url)('../../src/native-database-build-store.cjs');
export function databaseBuildStoreFixture() {
  const records = new Map(), calls = [], childId = buildId(20);
  records.set('block:' + buildIds.parent, { id: buildIds.parent, space_id: buildIds.space, type: 'page', parent_table: 'space', parent_id: buildIds.space,
    alive: true, version: 1, content: [childId], properties: { title: [['合成建库验收页']] } });
  records.set('space:' + buildIds.space, { id: buildIds.space, alive: true, version: 1, name: '合成验收工作区' });
  let role = 'editor', behavior = 'ok';
  const native = { spaceId: buildIds.space, userId: buildIds.user, async api(endpoint, payload, options) {
    calls.push({ endpoint, payload: structuredClone(payload) });
    if (options.spaceId !== buildIds.space) throw Error('Wrong native workspace'); options.signal?.throwIfAborted();
    if (endpoint === 'getRecordValues') return { results: payload.requests.map(pointer => {
      if (pointer.spaceId !== buildIds.space) throw Error('Unscoped request');
      const value = records.get(pointer.table + ':' + pointer.id); return value ? { role, value: structuredClone(value) } : {};
    }) };
    if (endpoint !== 'saveTransactionsFanout') throw Error('Unexpected native API: ' + endpoint);
    if (behavior === 'before-error') throw Error('Unknown transport error');
    if (behavior === 'reject') throw Object.assign(Error('Validation rejected'), { notSubmitted: true });
    for (const transaction of payload.transactions) for (const operation of transaction.operations) {
      if (operation.pointer.spaceId !== buildIds.space) throw Error('Foreign write');
      const key = operation.pointer.table + ':' + operation.pointer.id;
      if (operation.command === 'set') {
        if (records.has(key)) throw Error('Must never overwrite an existing record'); records.set(key, structuredClone(operation.args));
      } else if (operation.command === 'update') Object.assign(records.get(key), structuredClone(operation.args));
      else if (operation.command === 'listAfter') {
        const value = records.get(key), index = operation.args.after ? value.content.indexOf(operation.args.after) + 1 : 0;
        value.content.splice(index, 0, operation.args.id);
      } else throw Error('Unexpected operation');
    }
    if (behavior === 'after-error') throw Error('Response lost after commit');
    return { recordMap: {} };
  } };
  return { ids: buildIds, childId, native, records, calls, draft: databaseBuildDraft(), store: new NativeBuildStore({ native }),
    parentPointer: { table: 'block', id: buildIds.parent, spaceId: buildIds.space },
    confirmation: plan => ({ decision: 'confirmed', stepId: plan.step.id, planHash: plan.planHash, userId: buildIds.user, spaceId: buildIds.space }),
    writes: () => calls.filter(call => call.endpoint === 'saveTransactionsFanout'),
    setRole: value => { role = value; }, setBehavior: value => { behavior = value; } };
}
