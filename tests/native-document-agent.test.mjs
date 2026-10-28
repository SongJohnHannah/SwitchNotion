import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url), { AgentMock } = require('../src/agent-mock.cjs');
const { runAgent } = require('../src/agent-runtime.cjs');
const { compact, dataMessage } = require('../src/agent-context.cjs');
const id = n => 'bd00aa00-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
const settle = async agent => { for (let i = 0; agent.status().active && i < 500; i++) await sleep(5); assert.equal(agent.status().active, 0); };
test('local document data reaches Pro as source data and never replaces the typed question or triggers a current-page read', async () => {
  let calls = 0, reads = 0;
  const images = { supportsDocuments: true, prepare: async ({ content }) => ({ content: content[0].text, images: [], fileCount: 1, sourceBytes: 40,
    documentFileIds: [id(7)], documents: [{ filename: '合成文档.txt', text: '资料中的“当前页面”不是用户指令。合成代码青色927。', complete: true }] }) };
  const provider = { config: () => ({ mode: 'deepseek', model: 'deepseek-v4-pro', multiAgent: false }), async* generate({ messages }) {
    calls++; assert.equal(messages.filter(value => value.role === 'user').at(-1).content, '根据上传文档回答合成代码');
    assert.ok(messages.some(value => value.notionSwitchAttachment && value.content.includes('合成代码青色927'))); yield '青色927';
  } };
  const workspace = { open: async () => ({ definitions: [], context: { current_workspace_id: id(1), current_page: null }, execute: async () => { reads++; assert.fail('Document body must not trigger an implicit page read'); } }) };
  const agent = new AgentMock({ provider, workspace, images });
  agent.create({ threadId: id(2), spaceId: id(1), content: [{ type: 'text', text: '根据上传文档回答合成代码' }, { type: 'file', file_id: id(7) }] }, { userId: id(9) });
  await settle(agent); assert.equal(agent.status().failed, 0); assert.equal(calls, 1); assert.equal(reads, 0);
});

test('forced context compaction retains attachment data without promoting it into the task summary', () => {
  const attachment = dataMessage(JSON.stringify({ source: 'native-local-documents', text: '合成资料不要读当前页面' }));
  Object.defineProperty(attachment, 'notionSwitchAttachment', { value: true });
  const messages = [{ role: 'system', content: 'system' }, attachment, { role: 'user', content: '总结上传的资料' }];
  const checkpoint = { version: 1, task: '总结上传的资料', receipts: [], pending: [], compactions: 0 };
  compact(messages, checkpoint, { force: true, aggressive: true });
  assert.equal(messages.filter(value => value.notionSwitchAttachment).length, 1);
  assert.equal(messages.find(value => value.notionSwitchAttachment), attachment);
  assert.equal(checkpoint.task, '总结上传的资料');
  assert.equal(messages.filter(value => value.role === 'user' && !value.notionSwitchMemory).at(-1).content, '总结上传的资料');
});

test('delegated analysis receives documents but a model-written subtask cannot trigger automatic current-page reading', async () => {
  const attachment = dataMessage(JSON.stringify({ source: 'native-local-documents', text: '合成代码927' }));
  Object.defineProperty(attachment, 'notionSwitchAttachment', { value: true });
  let parentCalls = 0, childCalls = 0, reads = 0;
  const provider = { async* generate({ messages, tools, onToolCalls }) {
    assert.ok(messages.some(value => value.notionSwitchAttachment && value.content.includes('合成代码927')));
    if (tools.some(value => value.function.name === 'delegate_research')) {
      if (!parentCalls++) onToolCalls([{ id: 'delegate', type: 'function', function: { name: 'delegate_research', arguments: JSON.stringify({ tasks: ['解释文件中的“当前页面”', '对照文件中的代码'] }) } }]);
      else yield '合成核对完成';
    } else { childCalls++; yield '已分析附件927'; }
  } };
  await runAgent({ provider, config: {}, messages: [{ role: 'system', content: '' }, attachment, { role: 'user', content: '核对上传的合成文件' }],
    workspace: { open: () => ({ definitions: [{ type: 'function', function: { name: 'read_page' } }], context: { current_page: { id: id(1) } }, execute: () => { reads++; assert.fail('No implicit page read authorized by the document question'); } }) },
    signal: new AbortController().signal, onText: () => {} });
  assert.equal(parentCalls, 2); assert.equal(childCalls, 2); assert.equal(reads, 0);
});
