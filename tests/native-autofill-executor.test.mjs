import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { autofillFixture } from './helpers/native-autofill.mjs';
const { AutofillExecutor } = createRequire(import.meta.url)('../src/native-autofill-executor.cjs');
const { autofillInput } = createRequire(import.meta.url)('../src/native-autofill-store.cjs');
function fixture(t) {
  const f = autofillFixture(), parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-autofill-executor-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const requests = [], provider = { config: () => ({ mode: 'deepseek' }), async* generate(args) {
    requests.push(args); const second = JSON.stringify(args.messages).includes('第二条市场资料');
    yield JSON.stringify({ summary: second ? '市场摘要' : '青色927摘要', category: second ? '市场' : '研发', tags: second ? [] : ['青色', '927'] });
  } };
  return { ...f, root, requests, provider, executor: new AutofillExecutor({ root, provider }), store: f.createStore(), info: autofillInput(f.input) };
}

test('Autofill generates selected records, writes and verifies every target, with repeat and restart recovery', async t => {
  const f = fixture(t), result = await f.executor.fill(f.info, f.store);
  assert.equal(result.verifiedRows, 2); assert.equal(f.writes().length, 2); assert.equal(f.requests.length, 2);
  assert.equal(f.get('block', f.ids.first).properties.summary[0][0], '青色927摘要');
  assert.equal(f.get('block', f.ids.second).properties.category[0][0], '市场');
  assert.equal(f.requests[0].tools, undefined); assert.ok(!JSON.stringify(f.requests).includes('must-not-read-unselected'));
  const restarted = new AutofillExecutor({ root: f.root, provider: f.provider });
  assert.equal((await restarted.fill(f.info, f.store)).verifiedRows, 2);
  assert.equal(f.writes().length, 2); assert.equal(f.requests.length, 2, 'Verified rows with unchanged sources must not be regenerated');
});

test('native JSON key reordering does not make a verified result look like a new source', async t => {
  const f = fixture(t); await f.executor.fill(f.info, f.store);
  const reverse = value => Object.fromEntries(Object.entries(value).reverse());
  f.get('collection', f.ids.collection).schema = reverse(f.get('collection', f.ids.collection).schema);
  f.get('workflow', f.ids.workflow).data = reverse(f.get('workflow', f.ids.workflow).data);
  for (const id of f.info.rowIds) f.get('block', id).properties = reverse(f.get('block', id).properties);
  await new AutofillExecutor({ root: f.root, provider: f.provider }).fill(f.info, f.store);
  assert.equal(f.writes().length, 2); assert.equal(f.requests.length, 2);
});

test('a bad result in a later row prevents all writes, and retry reuses the already generated draft', async t => {
  const f = fixture(t), original = f.provider.generate;
  f.provider.generate = async function* (args) {
    if (JSON.stringify(args.messages).includes('第二条市场资料')) { f.requests.push(args); yield '{"summary":"错","category":"虚构","tags":[]}'; }
    else yield* original(args);
  };
  await assert.rejects(f.executor.fill(f.info, f.store), /选项/); assert.equal(f.writes().length, 0);
  f.provider.generate = original; const before = f.requests.length;
  await f.executor.fill(f.info, f.store); assert.equal(f.requests.length - before, 1); assert.equal(f.writes().length, 2);
});

test('Autofill recovers a lost response after commit by reading back without repeating the write', async t => {
  const f = fixture(t); f.info.rowIds = [f.ids.first]; f.setBehavior('after-error');
  const result = await f.executor.fill(f.info, f.store); assert.equal(result.verifiedRows, 1); assert.equal(f.writes().length, 1);
  await f.executor.fill(f.info, f.store); assert.equal(f.writes().length, 1);
});

test('an unknown write outcome blocks a blind retry and all following row writes', async t => {
  const f = fixture(t); f.setBehavior('before-error');
  await assert.rejects(f.executor.fill(f.info, f.store), /确认/); assert.equal(f.writes().length, 1);
  f.setBehavior('ok'); const restarted = new AutofillExecutor({ root: f.root, provider: f.provider });
  await assert.rejects(restarted.fill(f.info, f.store), /确认/); assert.equal(f.writes().length, 1);
});

test('a confirmed validation rejection can be retried without another model call', async t => {
  const f = fixture(t); f.info.rowIds = [f.ids.first]; f.setBehavior('reject');
  await assert.rejects(f.executor.fill(f.info, f.store)); assert.equal(f.requests.length, 1);
  f.setBehavior('ok'); await f.executor.fill(f.info, f.store); assert.equal(f.requests.length, 1); assert.equal(f.writes().length, 2);
});

test('cancelling generation writes nothing; a changed source is detected before submitting old results', async t => {
  const f = fixture(t), controller = new AbortController();
  f.provider.generate = async function* () { controller.abort(); yield '{"summary":"stale"}'; };
  await assert.rejects(f.executor.fill(f.info, f.store, controller.signal)); assert.equal(f.writes().length, 0);
  f.provider.generate = async function* () {
    f.get('block', f.ids.body1).properties.title = [['内容已修改']];
    yield '{"summary":"旧结果","category":"研发","tags":[]}';
  };
  await assert.rejects(f.executor.fill(f.info, f.store), /变化/); assert.equal(f.writes().length, 0);
});

test('cancelling one native row run does not cancel the other selected rows', async t => {
  const f = fixture(t), first = new AbortController(), original = f.provider.generate;
  f.provider.generate = async function* (args) {
    if (JSON.stringify(args.messages).includes('第一条青色927研发资料')) { first.abort(); yield '{}'; }
    else yield* original(args);
  };
  const result = await f.executor.fill(f.info, f.store, undefined, () => {}, { rowSignals: new Map([[f.ids.first, first.signal]]) });
  assert.equal(result.verifiedRows, 1); assert.deepEqual(result.cancelledRowIds, [f.ids.first]);
  assert.equal(f.get('block', f.ids.first).properties.summary[0][0], '旧摘要');
  assert.equal(f.get('block', f.ids.second).properties.summary[0][0], '市场摘要');
});
