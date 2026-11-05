import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
const { AgentMock } = createRequire(import.meta.url)('../src/agent-mock.cjs');
const THREAD = 'fixture-build-chat';

const assistantText = thread => [...thread.entities.values()].find(entity => entity.kind === 'assistant_message').content[0].text;
const settled = async agent => { for (let n = 0; n < 200; n++) { const status = agent.status(); if (status.completed || status.failed) return status; await sleep(5); } return agent.status(); };

test('a /建库 chat message opens the wizard with the remaining description and never calls the model', async () => {
  const calls = [], generations = [];
  const provider = { config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate() { generations.push(1); yield '不应调用模型。'; } };
  const agent = new AgentMock({ provider });
  agent.onDatabaseBuild = input => { calls.push(input); };
  agent.create({ threadId: THREAD, content: [{ type: 'text', text: '/建库 读书笔记库，字段：书名、作者、评分' }] });
  const status = await settled(agent);
  assert.equal(status.completed, 1); assert.equal(status.failed, 0); assert.equal(generations.length, 0);
  assert.equal(calls.length, 1); assert.equal(calls[0].prompt, '读书笔记库，字段：书名、作者、评分');
  const thread = agent.threads.get(THREAD);
  assert.equal(thread.turns.length, 1);
  assert.match(assistantText(thread), /已打开 AI 建库向导/);
  const user = [...thread.entities.values()].find(entity => entity.kind === 'user_message');
  assert.equal(user.text[0][0], '/建库 读书笔记库，字段：书名、作者、评分');
});

test('a bare /建库 opens the wizard without a prefilled description', async () => {
  const calls = [];
  const provider = { config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate() { yield '不应调用模型。'; } };
  const agent = new AgentMock({ provider });
  agent.onDatabaseBuild = input => { calls.push(input); };
  agent.create({ threadId: 'fixture-build-empty', content: [{ type: 'text', text: '／建库' }] });
  const status = await settled(agent);
  assert.equal(status.completed, 1); assert.equal(calls.length, 1); assert.equal(calls[0].prompt, '');
  assert.match(assistantText(agent.threads.get('fixture-build-empty')), /已打开 AI 建库向导/);
});

test('/AI建库 is accepted as the same trigger', async () => {
  const calls = [];
  const provider = { config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate() { yield '不应调用模型。'; } };
  const agent = new AgentMock({ provider });
  agent.onDatabaseBuild = input => { calls.push(input); };
  agent.create({ threadId: 'fixture-build-alias', content: [{ type: 'text', text: '/AI建库 项目跟踪库' }] });
  const status = await settled(agent);
  assert.equal(status.completed, 1); assert.equal(calls.length, 1); assert.equal(calls[0].prompt, '项目跟踪库');
});

test('ordinary chat messages still reach the model and do not open the wizard', async () => {
  const calls = [];
  const provider = { config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate() { yield '正常的本地回复。'; } };
  const agent = new AgentMock({ provider });
  agent.onDatabaseBuild = input => { calls.push(input); };
  agent.create({ threadId: 'fixture-build-chat-normal', content: [{ type: 'text', text: '帮我整理今天的计划' }] });
  const status = await settled(agent);
  assert.equal(status.completed, 1); assert.equal(calls.length, 0);
  assert.equal(assistantText(agent.threads.get('fixture-build-chat-normal')), '正常的本地回复。');
});

test('a wizard opening failure is reported in the chat turn instead of claiming success', async () => {
  const provider = { config: () => ({ mode: 'deepseek', multiAgent: false }), async* generate() { yield '不应调用模型。'; } };
  const agent = new AgentMock({ provider });
  agent.onDatabaseBuild = async () => { throw Error('Notion 建库向导 请先在 Notion 打开目标工作区中的页面，再点击“AI 建库”。'); };
  agent.create({ threadId: 'fixture-build-chat-failed', content: [{ type: 'text', text: '/建库 客户反馈库' }] });
  const status = await settled(agent);
  assert.equal(status.failed, 1); assert.equal(status.completed, 0);
  const text = assistantText(agent.threads.get('fixture-build-chat-failed'));
  assert.match(text, /建库向导打开失败/); assert.match(text, /请先在 Notion 打开目标工作区中的页面/);
});
