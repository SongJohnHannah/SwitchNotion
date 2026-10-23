import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { AgentMock } = require('../src/agent-mock.cjs');
const { compact } = require('../src/agent-context.cjs');
const { threadContext, selectionMessage } = require('../src/native-selection.cjs');
const SPACE = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';
const BLOCK = '33333333-3333-4333-8333-333333333333';
const pointer = { table: 'block', id: BLOCK, spaceId: SPACE };
const selection = { type: 'blocks', text: '合成引用：叙事文\n人物\n时间', value: [pointer] };
const context = { currentBlockId: PAGE, selectionPageId: PAGE, selection };
const waitFor = async agent => { for (let i = 0; i < 100; i++) { if (!agent.status().active) return; await sleep(5); } throw Error('selection fixture timed out'); };

test('selected block text is retained as native message context after sending, and reaches DeepSeek as quoted data', async () => {
  const requests = [];
  const agent = new AgentMock({ provider: { config: () => ({ mode: 'deepseek' }), async* generate({ messages }) { requests.push(structuredClone(messages)); yield '已解释选中的内容。'; } } });
  agent.create({ threadId: 'selection-fixture', spaceId: SPACE, threadContext: context, content: [{ type: 'text', text: '请解释选中的内容。' }] });
  await waitFor(agent);
  const transcript = await agent.transcript({ threadId: 'selection-fixture' }).json();
  const user = transcript.patches.find(p => p.entity.kind === 'user_message').entity;
  assert.deepEqual(user.thread_context?.selection, selection);
  assert.equal(user.thread_context.selectionPageId, PAGE);
  assert.ok(user.text[0][0].includes('【引用的选区】\n' + selection.text));
  assert.equal(user.user_prompt_text, '请解释选中的内容。');
  assert.equal(requests[0].findLast(m => m.role === 'user').content, '请解释选中的内容。');
  assert.equal(requests[0].some(m => { try { return JSON.parse(m.content).text === selection.text; } catch { return false; } }), true);
  assert.equal(agent.status().failed, 0);
});

test('exact text ranges survive restart and continuation without becoming the new current selection', async t => {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-selection-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const stateFile = path.join(root, 'conversations.json'), requests = [];
  const provider = { config: () => ({ mode: 'deepseek' }), async* generate({ messages }) { requests.push(structuredClone(messages)); yield 'ok'; } };
  const range = { type: 'text', text: '精确选中的三个字', value: { start: { index: 5, pointer }, end: { index: 14, pointer } }, isPreviewTruncated: false };
  const first = new AgentMock({ provider, stateFile });
  first.create({ threadId: 'text-range', spaceId: SPACE, threadContext: { ...context, selection: range }, content: [{ type: 'text', text: '解释这段' }] }); await waitFor(first);
  const restored = new AgentMock({ provider, stateFile });
  restored.send({ threadId: 'text-range', spaceId: SPACE, threadContext: { currentBlockId: PAGE }, event: { type: 'user.message', content: [{ type: 'text', text: '另一个没有选区的问题' }] } }); await waitFor(restored);
  const users = [...restored.threads.get('text-range').entities.values()].filter(e => e.kind === 'user_message');
  assert.deepEqual(users[0].thread_context.selection, range); assert.equal(users[1].thread_context.selection, undefined);
  assert.equal(requests[1].filter(m => { try { return JSON.parse(m.content).source === 'native-user-selection'; } catch { return false; } }).length, 1);
});

test('compaction preserves the original selection text as data before its associated user instruction', () => {
  const quote = selectionMessage(threadContext({ threadContext: context }, SPACE));
  const input = [{ role: 'system', content: 'system' }, quote, { role: 'user', content: '只解释选中部分，不要改动页面' }, { role: 'assistant', content: 'large '.repeat(50000) }];
  compact(input, { task: '只解释选中部分，不要改动页面', receipts: [], pending: [] }, { force: true });
  const index = input.findIndex(m => m.notionSwitchSelection);
  assert.ok(index > 0); assert.equal(JSON.parse(input[index].content).text, selection.text);
  assert.equal(input[index + 1].content, '只解释选中部分，不要改动页面');
});

test('malformed and cross-workspace selections do not silently fall back to answering about a whole page', async () => {
  let requested = false;
  const agent = new AgentMock({ provider: { config: () => ({ mode: 'deepseek' }), async* generate() { requested = true; yield 'must not run'; } } });
  agent.create({ threadId: 'bad-selection', spaceId: SPACE, threadContext: { ...context, selection: { ...selection, value: [{ ...pointer, spaceId: '44444444-4444-4444-8444-444444444444' }] } }, content: [{ type: 'text', text: '解释选中部分' }] }); await waitFor(agent);
  assert.equal(requested, false); assert.equal(agent.status().failed, 1);
  const errors = [...agent.threads.get('bad-selection').entities.values()].filter(e => e.kind === 'error');
  assert.ok(errors[0].message.includes('选区格式无效'));
});
