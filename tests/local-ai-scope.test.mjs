import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { NativeMock, json } = require('../src/native-mock.cjs');
const { InlineRecords } = require('../src/inline-records.cjs');
const { localRecords } = require('../src/local-records.cjs');
const id = n => 'b00b0000-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
const USER = id(1), OTHER = id(2), SPACE = id(3), FOREIGN = id(4), THREAD = id(5);
const writer = () => ({ threadId: THREAD, spaceId: SPACE, createdSource: 'writer', transcript: [
  { id: id(6), type: 'config', value: { type: 'writer' } }, { id: id(7), type: 'user', value: [['合成引用内容，仅账号甲可读']] }
] });
const draft = () => ({ threadId: THREAD, spaceId: SPACE, listenToken: 'synthetic-listen-token', content: [{ type: 'text', text: '账号甲的合成历史' }] });
const settle = async mock => { for (let i = 0; mock.status().activeTurns && i < 500; i++) await sleep(2); assert.equal(mock.status().activeTurns, 0); };
function fixture(t, persistent = false) {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-ai-scope-'));
  const stateFile = persistent ? path.join(root, 'conversations.json') : undefined;
  let calls = 0;
  const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek' }), async* generate() { calls++; yield '合成回复'; } };
  const mock = new NativeMock({ provider, stateFile });
  t.after(() => { for (const item of mock.agent.threads.values()) item.stop?.('cleanup'); for (const item of mock.threads.values()) item.stop?.('cleanup'); clearTimeout(mock.agent.saveTimer); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const call = (name, input, userId = USER) => mock.handle(name, input, undefined, { userId });
  return { mock, call, stateFile, provider, calls: () => calls };
}

test('native chat creation cannot disclose or reuse another account or workspace thread', async t => {
  const f = fixture(t); await f.call('createAgentThread', draft()); await settle(f.mock);
  for (const [input, user] of [[draft(), OTHER], [draft(), null], [{ ...draft(), spaceId: FOREIGN }, USER]]) {
    const response = await f.call('createAgentThread', input, user); assert.equal(response.status, 403);
    assert.ok(!(await response.text()).includes('账号甲的合成历史'));
  }
  assert.equal(f.calls(), 1); assert.equal(f.mock.agent.find(draft()).turns.length, 1);
  assert.equal((await f.call('createAgentThread', { ...draft(), threadId: THREAD.replaceAll('-', '').toUpperCase() }, OTHER)).status, 403);
});

test('native transcript, queued messages and listener validate the account even with a known listen token', async t => {
  const f = fixture(t); await f.call('createAgentThread', draft()); await settle(f.mock);
  for (const name of ['getThreadTranscript', 'getThreadQueuedMessages', 'listenToThreadTranscript']) {
    for (const input of [{ threadId: THREAD }, { listenToken: draft().listenToken }, { threadId: THREAD, spaceId: FOREIGN }]) {
      const response = await f.call(name, input, input.spaceId ? USER : OTHER);
      if (response.status === 200 && name === 'listenToThreadTranscript') await response.body.cancel();
      assert.equal(response.status, 403, name);
    }
  }
  const owned = await (await f.call('getThreadTranscript', { threadId: THREAD })).json();
  assert.ok(owned.patches.some(p => p.entity.kind === 'user_message'));
});

test('foreign continuation and stop events leave the original history and running turn untouched', async t => {
  const f = fixture(t); await f.call('createAgentThread', draft()); await settle(f.mock);
  const thread = f.mock.agent.find(draft()); let stopped = 0; thread.stop = () => { stopped++; };
  const before = thread.entities.size;
  for (const event of [{ type: 'interrupt' }, { type: 'user.message', text: '窃用合成会话' }]) {
    assert.equal((await f.call('sendEventToAgentThread', { threadId: THREAD, event }, OTHER)).status, 403);
  }
  assert.equal(stopped, 0); assert.equal(thread.entities.size, before); assert.equal(f.calls(), 1); thread.stop = null;
  assert.equal((await f.call('stopWorkflowAutomationRunThread', { threadId: THREAD }, OTHER)).status, 403);
  assert.equal((await f.call('sendEventToAgentThread', { threadId: THREAD, event: { type: 'user.message', text: '继续自己的合成问题' } })).status, 200);
  await settle(f.mock); assert.equal(f.calls(), 2);
});

test('inline account and workspace checks happen before source resolution, model generation or stop', async t => {
  const f = fixture(t, true); await (await f.call('runInferenceTranscript', writer())).text();
  const before = fs.readFileSync(f.mock.inline.file, 'utf8'); let resolved = 0;
  f.mock.inlineReferences = async () => { resolved++; throw Error('Must not read a foreign source'); };
  for (const [input, user] of [[writer(), OTHER], [writer(), null], [{ ...writer(), spaceId: FOREIGN }, USER]]) {
    const response = await f.call('runInferenceTranscript', input, user); if (response.status === 200) await response.text();
    assert.equal(response.status, 403);
  }
  let stopped = 0; f.mock.threads.get(THREAD).stop = () => { stopped++; };
  assert.equal((await f.call('stopWorkflowAutomationRunThread', { threadId: THREAD }, OTHER)).status, 403);
  assert.equal(stopped, 0); f.mock.threads.get(THREAD).stop = null;
  assert.equal(f.calls(), 1); assert.equal(resolved, 0); assert.equal(fs.readFileSync(f.mock.inline.file, 'utf8'), before);
  const restored = new NativeMock({ provider: f.provider, stateFile: f.stateFile });
  assert.equal(restored.record(THREAD, 'thread', { userId: OTHER, spaceId: SPACE }), undefined);
  assert.equal(restored.record(THREAD, 'thread', { userId: USER, spaceId: SPACE }).created_by_id, USER);
});

test('local record batches mask denied local IDs and preserve the order of allowed and ordinary remote records', async t => {
  const f = fixture(t); await f.call('createAgentThread', draft()); await settle(f.mock);
  const data = { requests: [{ table: 'thread', id: THREAD, spaceId: SPACE }, { table: 'block', id: id(90), spaceId: SPACE }] };
  const remote = [];
  const request = new Request('https://app.notion.com/api/v3/getRecordValues', { method: 'POST', headers: { 'x-notion-active-user-header': OTHER }, body: JSON.stringify(data) });
  const result = await (await localRecords(request, data, 'getRecordValues', f.mock, async req => {
    remote.push(await req.json()); return json({ results: [{ role: 'reader', value: { id: id(90) } }] });
  }, () => {})).json();
  assert.deepEqual(result.results[0], { role: 'none' }); assert.equal(result.results[1].value.id, id(90));
  assert.deepEqual(remote[0].requests, [data.requests[1]]);
  const denied = f.mock.record(THREAD, 'thread', { userId: USER, spaceId: FOREIGN }); assert.equal(denied, undefined);
  const sync = { requests: [data.requests[0]] }, syncRequest = new Request('https://app.notion.com/api/v3/syncRecordValues', { method: 'POST', headers: { 'x-notion-active-user-header': OTHER }, body: JSON.stringify(sync) });
  const syncResult = await (await localRecords(syncRequest, sync, 'syncRecordValues', f.mock, () => assert.fail('Denied local records are not remote requests'), () => {})).json();
  assert.deepEqual(syncResult.recordMap.thread[THREAD].value, { role: 'none' });
});

test('inline ownership is reserved while the first request is still resolving its references', async t => {
  const f = fixture(t); let release;
  const waiting = new Promise(resolve => { release = resolve; });
  f.mock.inlineReferences = async () => { await waiting; return { references: [{ complete: true, body_available: true, markdown: '合成引用' }] }; };
  const input = writer(); input.transcript.splice(1, 0, { id: id(30), type: 'user-specified-context', value: { pointers: [{ table: 'block', id: id(31), spaceId: SPACE }] } });
  const first = await f.call('runInferenceTranscript', input);
  const foreign = await f.call('runInferenceTranscript', { ...input, threadId: THREAD.replaceAll('-', '').toUpperCase() }, OTHER);
  if (foreign.status === 200) await foreign.body.cancel();
  const stopped = await f.call('stopWorkflowAutomationRunThread', { threadId: THREAD }, OTHER);
  release(); await first.text();
  assert.equal(foreign.status, 403); assert.equal(stopped.status, 403); assert.equal(f.calls(), 1);
});

test('inline ownership and message collisions fail before changing the saved graph', () => {
  const records = new InlineRecords(), input = writer(), output = { id: id(8), type: 'agent-inference', value: [{ type: 'text', content: '合成输出' }] };
  records.snapshot(input, output, 'completed', USER);
  const before = JSON.stringify({ threads: [...records.threads], messages: [...records.messages] });
  assert.throws(() => records.snapshot(input, output, 'completed', OTHER), /账号/);
  assert.equal(JSON.stringify({ threads: [...records.threads], messages: [...records.messages] }), before);
  assert.throws(() => records.snapshot({ ...input, threadId: id(20) }, output, 'completed', USER), /消息|线程/);
  assert.equal(JSON.stringify({ threads: [...records.threads], messages: [...records.messages] }), before);
  const legacy = new InlineRecords(); legacy.snapshot(input, output, 'completed');
  assert.equal(legacy.record(THREAD, 'thread', { userId: USER }), undefined);
  assert.throws(() => legacy.snapshot(input, output, 'completed', USER), /账号|归属/);
  assert.equal(records.record(THREAD.replaceAll('-', '').toUpperCase(), 'thread', { userId: USER.toUpperCase() }).id, THREAD);
  assert.throws(() => records.snapshot({ ...input, threadId: THREAD.toUpperCase() }, output, 'completed', OTHER), /账号/);
  records.messages.get(output.id).parent_id = THREAD.toUpperCase();
  records.threads.get(THREAD).messages = records.threads.get(THREAD).messages.map(value => value.toUpperCase());
  assert.doesNotThrow(() => records.snapshot(input, output, 'completed', USER.toUpperCase()));
  assert.deepEqual(records.record(THREAD).messages, [id(6), id(7), output.id]);
});

test('desktop record and metadata routes pass the current account through to the native mock', async t => {
  const f = fixture(t); await f.call('createAgentThread', draft()); await settle(f.mock);
  const source = fs.readFileSync(new URL('../src/desktop-hook.cjs', import.meta.url), 'utf8'); let forwarded = 0;
  const context = { Request, Response, Headers, URL, mock: f.mock, json, localRecords, provider: f.provider,
    aiRecords: { record: (id, table, scope) => f.mock.record(id, table, scope), hasRecord: (id, table) => f.mock.hasRecord(id, table) },
    settings: { speech: { enabled: false }, isLoginSyncing: () => false }, nativeSpeech: { enabled: false }, meetingBridge: { observe() {} }, recordings: { wake() {} },
    log() {}, localUploadPrefix: '/notion-switch-local-upload/', isNotion: host => host === 'app.notion.com', endpoints: new Set() };
  const route = vm.runInNewContext(source.slice(source.indexOf('async function route('), source.indexOf('\nfunction install(ses)')) + '\nroute', context);
  const call = (endpoint, input, user = OTHER) => route(new Request('https://app.notion.com/api/v3/' + endpoint, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-notion-active-user-header': user }, body: JSON.stringify(input) }), () => { forwarded++; return json({ remote: true }); });
  for (const endpoint of ['getThreadSpaceId', 'recordAgentThreadView', 'markInferenceTranscriptSeen']) assert.equal((await call(endpoint, { threadId: THREAD })).status, 403);
  const denied = await (await call('getRecordValues', { requests: [{ table: 'thread', id: THREAD, spaceId: SPACE }] })).json();
  assert.deepEqual(denied.results, [{ role: 'none' }]); assert.equal(forwarded, 0);
  assert.equal((await (await call('getThreadSpaceId', { threadId: THREAD }, USER)).json()).spaceId, SPACE);
});

test('restored account ownership remains enforced and unowned legacy records are never claimed by the next login', async t => {
  const f = fixture(t, true); await f.call('createAgentThread', draft()); await settle(f.mock);
  const restored = new NativeMock({ provider: f.provider, stateFile: f.stateFile });
  assert.equal((await restored.handle('getThreadTranscript', { threadId: THREAD }, undefined, { userId: OTHER })).status, 403);
  assert.equal((await restored.handle('getThreadTranscript', { threadId: THREAD }, undefined, { userId: USER })).status, 200);
  delete restored.agent.record(THREAD).created_by_id; restored.agent.save();
  const unowned = new NativeMock({ provider: f.provider, stateFile: f.stateFile }), before = fs.readFileSync(f.stateFile, 'utf8');
  assert.equal((await unowned.handle('createAgentThread', draft(), undefined, { userId: USER })).status, 403);
  assert.equal((await unowned.handle('createAgentThread', { ...draft(), threadId: id(99) }, undefined, { userId: null })).status, 403);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
});
