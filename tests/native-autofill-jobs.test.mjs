import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { autofillFixture, autofillId } from './helpers/native-autofill.mjs';
const { NativeAutofillJobs, createAutofillJobs } = createRequire(import.meta.url)('../src/native-autofill-jobs.cjs');
function fixture(t) {
  const f = autofillFixture(), parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-autofill-jobs-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const provider = { config: () => ({ mode: 'deepseek' }), async* generate() { yield '{"summary":"青色927","category":"研发","tags":["青色"]}'; } };
  const service = new NativeAutofillJobs({ root, provider }); t.after(() => service.close());
  return { ...f, root, provider, service, meta: { store: f.createStore(), userId: f.ids.user } };
}
async function start(f, endpoint = 'triggerLiteAgentAutofill') {
  const response = await f.service.handle(endpoint, f.input, undefined, f.meta); assert.equal(response.status, 200); return response.json();
}

test('native Autofill queues expose run IDs, task output and final verified record updates for both endpoints', async t => {
  for (const endpoint of ['triggerLiteAgentAutofill', 'triggerAgentOverCollection']) {
    const f = fixture(t), queued = await start(f, endpoint);
    assert.equal(queued.totalBlocks, 2); assert.equal(queued.workflowAutomationRunIds.length, 2);
    assert.equal(queued.notionSwitchAutofill.version, 1);
    if (endpoint === 'triggerAgentOverCollection') assert.equal(queued.outputKey, queued.groupId);
    await f.service.wait(queued.groupId);
    const response = await f.service.handle('notionSwitchGetAutofillStatus', { spaceId: f.ids.space, jobId: queued.groupId }, undefined, f.meta);
    const state = await response.json(); assert.equal(state.status, 'success'); assert.equal(state.value.percentageComplete, 100);
    assert.equal(state.counts.success, 2); assert.equal(state.recordMap.workflow_automation_run[queued.workflowAutomationRunIds[0]].value.value.status, 'success');
    assert.match(state.recordMap.block[f.ids.first].value.value.properties.summary[0][0], /927/); assert.equal(f.service.active, 0);
  }
});

test('local run records and status do not cross accounts or workspaces', async t => {
  const f = fixture(t), queued = await start(f); await f.service.wait(queued.groupId);
  for (const scope of [{ userId: autofillId(90), spaceId: f.ids.space }, { userId: f.ids.user, spaceId: autofillId(91) }]) {
    assert.equal(f.service.record(queued.workflowAutomationRunIds[0], 'workflow_automation_run', scope), undefined);
    assert.equal((await f.service.handle('notionSwitchGetAutofillStatus', { jobId: queued.groupId, spaceId: scope.spaceId }, undefined, scope)).status, 404);
  }
  const restarted = new NativeAutofillJobs({ root: f.root, provider: f.provider });
  assert.equal(restarted.record(queued.workflowAutomationRunIds[0], 'workflow_automation_run', { userId: f.ids.user, spaceId: f.ids.space }).status, 'success');
  assert.equal(await f.service.handle('markWorkflowAutomationRunCancelled', { runId: autofillId(99), spaceId: f.ids.space }, undefined, f.meta), null);
});

test('the original native stop action cancels one row while the other rows finish and dirty task states are cleared', async t => {
  const f = fixture(t); let begin;
  const began = new Promise(resolve => { begin = resolve; });
  f.provider.generate = async function* ({ messages, signal }) {
    if (JSON.stringify(messages).includes('第一条青色927研发资料')) {
      begin(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted();
    }
    yield '{"summary":"第二条结果","category":"市场","tags":[]}';
  };
  const queued = await start(f); await began;
  const stopped = await f.service.handle('markWorkflowAutomationRunCancelled', { spaceId: f.ids.space, runId: queued.workflowAutomationRunIds[0] }, undefined, f.meta);
  assert.equal(stopped.status, 200); await f.service.wait(queued.groupId);
  const state = await (await f.service.handle('notionSwitchGetAutofillStatus', { spaceId: f.ids.space, jobId: queued.groupId }, undefined, f.meta)).json();
  assert.equal(state.counts.cancelled, 1); assert.equal(state.counts.success, 1);
  assert.equal(f.get('block', f.ids.first).properties.summary[0][0], '旧摘要');
  assert.equal(f.get('block', f.ids.first).format.agent_workflow_status.summary, null);
  assert.equal(f.get('block', f.ids.second).properties.summary[0][0], '第二条结果');
});

test('unknown write results stop field and metadata writes and remain visible after a restart', async t => {
  const f = fixture(t); f.setBehavior('before-error'); const queued = await start(f); await f.service.wait(queued.groupId);
  assert.equal(f.writes().length, 1);
  const state = await (await f.service.handle('notionSwitchGetAutofillStatus', { spaceId: f.ids.space, jobId: queued.groupId }, undefined, f.meta)).json();
  assert.equal(state.status, 'failure'); assert.match(state.value.error.message, /确认/);
  const restarted = new NativeAutofillJobs({ root: f.root, provider: f.provider });
  assert.equal(restarted.record(queued.workflowAutomationRunIds[0], 'workflow_automation_run', { userId: f.ids.user, spaceId: f.ids.space }).status, 'failure');
});

test('a corrupt private Autofill journal disables this feature without deleting evidence or blocking other startup', async t => {
  const f = fixture(t), file = path.join(f.root, 'autofill-journal.local.json'); fs.writeFileSync(file, '{corrupt private journal');
  const logs = [], service = createAutofillJobs({ root: f.root, provider: f.provider, log: event => logs.push(event) });
  assert.equal(service.available, false); assert.equal(service.active, 0);
  const response = await service.handle('triggerLiteAgentAutofill', f.input, undefined, f.meta);
  assert.equal(response.status, 503); assert.match((await response.json()).message, /保留|核验/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt private journal'); assert.equal(f.calls.length, 0);
  assert.deepEqual(logs, [{ type: 'autofill-storage-unavailable' }]); service.close();
});
