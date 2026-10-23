import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { NativeMock } = require('../src/native-mock.cjs');
const { AgentMock } = require('../src/agent-mock.cjs');

test('native rich-text links preserve only visible prompt text in creation and continuation', async () => {
  const received = [];
  const provider = {
    config: () => ({ mode: 'deepseek' }),
    status: () => ({ mode: 'deepseek', model: 'fixture' }),
    async *generate({ messages }) { received.push(structuredClone(messages)); yield 'ok'; }
  };
  const mock = new AgentMock({ provider });
  const visible = 'https://app.notion.com/p/fixture；严格追加“编号｜日期｜负责人”';
  const content = [{ type: 'text', text: [['读取 '], [visible, [['a', 'https://app.notion.com/p/fixture%EF%BC%9Bencoded']]], ['。']] }];
  const input = { threadId: 'rich-text', spaceId: 'space', content };
  await mock.create(input);
  while (mock.status().active) await sleep(1);
  assert.equal(received[0].at(-1).content, '读取 ' + visible + '。');
  mock.send({ threadId: input.threadId, event: { type: 'user.message', content: [{ type: 'text', text: [['继续', [['b']]], ['，保留｜']] }] } });
  while (mock.status().active) await sleep(1);
  assert.equal(received[1].at(-1).content, '继续，保留｜');
  assert.equal(received[1].filter(m => m.role === 'user')[0].content, '读取 ' + visible + '。');
  assert.equal(mock.status().failed, 0);
});

test('legacy stream completes and abort stops the producer', async () => {
  const mock = new NativeMock({ delayMs: 1 });
  const first = await mock.handle('runInferenceTranscript', { threadId: 'test', transcript: [] });
  const events = (await first.text()).trim().split('\n').map(JSON.parse);
  assert.ok(events.length > 3);
  assert.match(events.at(-1).data.s[0].value[0].content, /NS-MOCK-DONE-1/);
  const abort = new AbortController();
  const second = await mock.handle('runInferenceTranscript', { threadId: 'test', transcript: [] }, abort.signal);
  const reader = second.body.getReader();
  await reader.read(); abort.abort();
  assert.equal((await reader.read()).done, true);
  assert.equal(mock.status().stoppedTurns, 1);
  assert.equal(mock.status().activeTurns, 0);
});

test('Agent creation is idempotent, stops, and continues with the same history', async () => {
  const mock = new AgentMock({ delayMs: 1 });
  const args = { threadId: 'agent-test', spaceId: 'space-test', content: [{ type: 'text', text: 'test only' }], clientMessageId: 'message-1' };
  const created = await (await mock.create(args)).json();
  assert.equal(created.thread.data.agent_provider.providerId, 'agent_service');
  await mock.create(args);
  assert.equal(mock.find(args).turns.length, 1);
  await sleep(5);
  mock.send({ threadId: args.threadId, event: { type: 'interrupt' } });
  const stopped = await mock.transcript(args).json();
  assert.equal(stopped.session.status, 'idle');
  assert.ok(stopped.patches.some(p => p.entity.kind === 'turn_completed' && p.entity.stop_reason === 'interrupted'));
  const frames = mock.find(args).frames.length;
  await sleep(8);
  assert.equal(mock.find(args).frames.length, frames);
  mock.send({ threadId: args.threadId, event: { type: 'user_message', content: [{ type: 'text', text: 'continue' }] } });
  for (let i = 0; mock.status().active && i < 100; i++) await sleep(5);
  const continued = await mock.transcript(args).json();
  assert.equal(mock.status().active, 0);
  assert.equal(mock.status().completed, 1);
  const assistants = continued.patches.filter(p => p.entity.kind === 'assistant_message');
  assert.equal(assistants.length, 2);
  assert.match(assistants[1].entity.content[0].text, /上一轮状态为 stopped/);
  assert.match(assistants[1].entity.content[0].text, /NS-MOCK-DONE-2/);
});

test('Agent listener can disconnect and resume from a cursor without cancelling generation', async () => {
  const mock = new AgentMock({ delayMs: 2 });
  const input = { threadId: 'listen-test', spaceId: 'space-test', content: [{ type: 'text', text: 'test' }] };
  await mock.create(input);
  const reader = mock.listen(input).body.getReader();
  const first = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  await reader.cancel();
  assert.equal(mock.status().active, 1);
  await sleep(8);
  const abort = new AbortController();
  const resumed = mock.listen({ ...input, cursor: first.cursor }, abort.signal).body.getReader();
  const next = JSON.parse(new TextDecoder().decode((await resumed.read()).value));
  assert.ok(Number(next.cursor) > Number(first.cursor));
  abort.abort();
  mock.find(input).stop('test-cleanup');
});

test('local conversation survives restart and interrupted generation recovers to idle', async () => {
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'test-persistence-'));
  try {
    const stateFile = path.join(dir, 'conversations.json');
    const first = new AgentMock({ stateFile, delayMs: 1 });
    const input = { threadId: 'persist-test', spaceId: 'space', content: [{ type: 'text', text: 'local' }] };
    await first.create(input);
    const second = new AgentMock({ stateFile, delayMs: 1 });
    first.find(input).stop('cleanup');
    const restored = await second.transcript(input).json();
    assert.equal(restored.session.status, 'idle');
    assert.equal(second.find(input).turns[0].status, 'stopped');
    assert.equal(restored.patches.filter(p => p.entity.kind === 'user_message').length, 1);
    assert.equal(second.record(input.threadId).data.agent_provider.providerId, 'agent_service');
  } finally { assert.equal(path.dirname(path.resolve(dir)), parent); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('record reads split local threads from remote batches and preserve response order', async () => {
  const { localRecords } = require('../src/local-records.cjs');
  const input = { requests: [{ pointer: { table: 'thread', id: 'local' } }, { pointer: { table: 'block', id: 'remote' } }] };
  const req = new Request('https://app.notion.com/api/v3/getRecordValues', { method: 'POST', body: JSON.stringify(input) });
  let calls = 0;
  const res = await localRecords(req, input, 'getRecordValues', { record: id => id === 'local' ? { id } : undefined }, async request => {
    calls++; const data = await request.json();
    assert.deepEqual(data.requests, [input.requests[1]]);
    return new Response(JSON.stringify({ results: [{ role: 'reader', value: { id: 'remote' } }] }));
  }, () => {});
  const { results } = await res.json();
  assert.equal(calls, 1);
  assert.deepEqual(results.map(r => r.value.id), ['local', 'remote']);
});

test('initial record sync uses the native v3 envelope with space identity', async () => {
  const { localRecords } = require('../src/local-records.cjs');
  const record = { id: 'local', space_id: 'space', data: {} };
  const input = { requests: [{ pointer: { table: 'thread', id: 'local', spaceId: 'space' } }] };
  const request = new Request('https://app.notion.com/api/v3/syncRecordValuesSpaceInitial', { method: 'POST', body: JSON.stringify(input) });
  const response = await localRecords(request, input, 'syncRecordValuesSpaceInitial', { record: () => record }, () => { throw Error('Local read must not go upstream'); }, () => {});
  const data = await response.json();
  assert.equal(data.recordMap.__version__, 3);
  assert.deepEqual(data.recordMap.thread.local, { spaceId: 'space', value: { role: 'editor', value: record } });
});
