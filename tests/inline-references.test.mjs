import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NativeMock } from '../src/native-mock.cjs';

const SPACE = '11111111-1111-4111-8111-111111111111', PAGE = '22222222-2222-4222-8222-222222222222';
const BLOCK = '33333333-3333-4333-8333-333333333333', THREAD = '44444444-4444-4444-8444-444444444444';
const CONTEXT = '55555555-5555-4555-8555-555555555555';
const payload = () => ({ threadId: THREAD, spaceId: SPACE, createdSource: 'writer', transcript: [
  { id: '66666666-6666-4666-8666-666666666666', type: 'context', value: { blockId: PAGE } },
  { id: CONTEXT, type: 'user-specified-context', value: { pointers: [{ table: 'block', id: BLOCK, spaceId: SPACE }] } },
  { id: '77777777-7777-4777-8777-777777777777', type: 'user', value: [['只根据引用解释，不修改页面。']] }
] });
function model(requests) {
  return { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek' }),
    async* generate(args) { requests.push(args); yield '已读取合成引用。'; } };
}
async function output(native, input) {
  const response = await native.handle('runInferenceTranscript', input);
  return (await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('floating dialog resolves attached references before generation and retains pointers after reload', async t => {
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-inline-references-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const requests = [], resolutions = [], stateFile = path.join(root, 'conversations.json');
  const native = new NativeMock({ stateFile, provider: model(requests), inlineReferences: async args => {
    resolutions.push(args); return { references: [{ pointer: args.pointers[0], text: '附加合成页面：青色927', complete: true }] };
  } });
  const input = payload(), before = structuredClone(input), frames = await output(native, input);
  assert.equal(requests.length, 1, 'The attached reference must reach the model instead of being rejected or dropped');
  assert.equal(resolutions.length, 1); assert.equal(resolutions[0].pageId, PAGE);
  assert.equal(requests[0].tools, undefined); assert.match(JSON.stringify(requests[0].messages), /附加合成页面：青色927/);
  assert.equal(frames.at(-1).recordMap.thread[THREAD].value.value.last_turn_outcome.status, 'success');
  assert.deepEqual(input, before, 'Resolving references must not rewrite the native request');
  const restored = new NativeMock({ stateFile });
  assert.deepEqual(restored.record(CONTEXT, 'thread_message').step.value.pointers, input.transcript[1].value.pointers);
  assert.ok(!fs.readFileSync(path.join(root, 'inline-conversations.local.json'), 'utf8').includes('附加合成页面：青色927'));
});

for (const selection of [
  { type: 'blocks', text: '', value: [{ table: 'block', id: BLOCK, spaceId: SPACE }] },
  { type: 'text', text: '合成预览', isPreviewTruncated: true, value: {
    start: { pointer: { table: 'block', id: BLOCK, spaceId: SPACE }, index: 0 },
    end: { pointer: { table: 'block', id: BLOCK, spaceId: SPACE }, index: 20 } } }
]) test(`floating dialog supplies resolved ${selection.type} content together with its original selection`, async () => {
  const requests = [], native = new NativeMock({ provider: model(requests), inlineReferences: async args => ({
    selection: { type: args.selection.type, text: '完整合成选区：927', complete: true }, references: []
  }) });
  const input = payload(); input.transcript[1].value = { pointers: [], [selection.type === 'text' ? 'textSelection' : 'blockSelection']: selection };
  await output(native, input);
  assert.equal(requests.length, 1); assert.match(JSON.stringify(requests[0].messages), /完整合成选区：927/);
  assert.equal(requests[0].messages.filter(m => m.notionSwitchSelection).length, 1);
});

test('stopping during reference reads aborts the resolver and never calls the model', async () => {
  const requests = []; let received, start;
  const began = new Promise(resolve => { start = resolve; });
  const native = new NativeMock({ provider: model(requests), inlineReferences: async ({ signal }) => {
    received = signal; start(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted();
  } });
  const response = await native.handle('runInferenceTranscript', payload());
  await Promise.race([began, new Promise((_, reject) => setTimeout(() => reject(Error('Reference resolver was not reached')), 500))]);
  await native.handle('stopWorkflowAutomationRunThread', { threadId: THREAD });
  assert.equal(received.aborted, true); assert.equal((await response.text()), ''); assert.equal(requests.length, 0);
  assert.equal(native.status().activeTurns, 0);
});

test('reference read failures never become a partial question or a model request', async () => {
  const requests = [], native = new NativeMock({ provider: model(requests), inlineReferences: async () => { throw Error('Notion 引用页面未授权。'); } });
  const frames = await output(native, payload());
  assert.equal(requests.length, 0);
  assert.match(frames.find(frame => frame.type === 'agent-inference').value[0].content, /未授权/);
});
