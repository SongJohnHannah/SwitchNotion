import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { NativeMock } = require('../src/native-mock.cjs');
const SPACE = '11111111-1111-4111-8111-111111111111', PAGE = '22222222-2222-4222-8222-222222222222', BLOCK = '33333333-3333-4333-8333-333333333333';
const THREAD = '44444444-4444-4444-8444-444444444444';
const input = () => ({ threadId: THREAD, spaceId: SPACE, createdSource: 'writer', transcript: [
  { id: '55555555-5555-4555-8555-555555555555', type: 'config', value: { type: 'workflow' } },
  { id: '66666666-6666-4666-8666-666666666666', type: 'context', value: { blockId: PAGE, userEmail: 'must-not-forward@example.test' } },
  { id: '77777777-7777-4777-8777-777777777777', type: 'user-specified-context', value: { pointers: [], blockSelection: { type: 'blocks', text: '合成选区原文', value: [{ table: 'block', id: BLOCK, spaceId: SPACE }] } } },
  { id: '88888888-8888-4888-8888-888888888888', type: 'user', value: [['请解释选中的这段话。']] }
] });

test('the native floating writer entry streams DeepSeek preview text and includes its selection without enabling mutations', async () => {
  let requested = false, writes = 0;
  const provider = { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek' }), async* generate({ messages, tools }) {
    requested = true; assert.equal(tools?.length || 0, 0);
    assert.ok(JSON.stringify(messages).includes('合成选区原文'));
    assert.equal(JSON.stringify(messages).includes('must-not-forward'), false);
    yield '这是'; yield '选中文字的解释。';
  } };
  const native = new NativeMock({ provider, workspace: { open: () => { writes++; throw Error('must not open write tools'); } } });
  const response = await native.handle('runInferenceTranscript', input(), new AbortController().signal);
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].type, 'record-map');
  const output = events.filter(e => e.type === 'agent-inference');
  assert.equal(output.at(-1).value[0].content, '这是选中文字的解释。');
  const persisted = events.at(-1).recordMap;
  assert.equal(persisted.thread[THREAD].value.value.messages.length, 5);
  assert.equal(persisted.thread_message[output.at(-1).id].value.value.step.value[0].content, '这是选中文字的解释。');
  assert.equal(JSON.stringify(persisted).includes('must-not-forward'), false);
  assert.equal(requested, true); assert.equal(writes, 0); assert.equal(native.status().activeTurns, 0);
});

test('a container-only selection directs floating text preview to Agent without inventing unavailable content', async () => {
  let requested = false;
  const native = new NativeMock({ provider: { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek' }), async* generate() { requested = true; yield 'must not run'; } } });
  const payload = input(); payload.transcript[2].value.blockSelection.text = '';
  const response = await native.handle('runInferenceTranscript', payload);
  const text = await response.text(); assert.equal(requested, false); assert.ok(text.includes('右侧 Agent'));
});

test('floating writer never silently drops additional page or file references', async () => {
  let requested = false;
  const native = new NativeMock({ provider: { status: () => ({ mode: 'deepseek' }), config: () => ({}), async* generate() { requested = true; yield 'bad'; } } });
  for (const pointers of [[{ table: 'block', id: BLOCK, spaceId: SPACE }], 'invalid']) {
    const payload = input(); payload.transcript[2].value.pointers = pointers;
    const response = await native.handle('runInferenceTranscript', payload);
    assert.ok((await response.text()).includes('右侧 Agent')); assert.equal(requested, false);
  }
});

test('floating writer never answers after silently dropping a native attachment or unknown source step', async () => {
  let requested = false;
  const native = new NativeMock({ provider: { status: () => ({ mode: 'deepseek' }), config: () => ({}), async* generate() { requested = true; yield 'bad'; } } });
  for (const source of [{ type: 'attachment', fileUrl: 'https://file.notion.so/f/f/synthetic', fileName: '资料.pdf', contentType: 'application/pdf' },
    { type: 'computer-file', fileUrl: 'https://file.notion.so/f/f/synthetic', fileName: '资料.csv', contentType: 'text/csv' },
    { type: 'future-source', value: { source: 'must not ignore' } }]) {
    const payload = input(); payload.transcript.splice(3, 0, { id: '99999999-9999-4999-8999-999999999999', ...source });
    const response = await native.handle('runInferenceTranscript', payload);
    assert.ok((await response.text()).includes('尚未支持'), source.type);
    assert.equal(requested, false, source.type);
  }
});

test('closing or stopping inline preview cancels the provider without applying text', async () => {
  let modelSignal;
  const native = new NativeMock({ provider: { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek' }), async* generate({ signal }) { modelSignal = signal; yield 'partial'; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted(); } } });
  const response = await native.handle('runInferenceTranscript', input(), new AbortController().signal), reader = response.body.getReader();
  await reader.read(); await reader.read();
  await native.handle('stopWorkflowAutomationRunThread', { threadId: THREAD });
  assert.equal(modelSignal.aborted, true); assert.equal((await reader.read()).done, true); assert.equal(native.status().activeTurns, 0);
});

test('an inline provider error is rendered in native preview rather than leaving an empty waiting state', async () => {
  const native = new NativeMock({ provider: { status: () => ({ mode: 'deepseek' }), config: () => ({ mode: 'deepseek' }), async* generate() { throw Error('DeepSeek API 返回 HTTP 401'); } } });
  const response = await native.handle('runInferenceTranscript', input());
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.ok(events.find(e => e.type === 'agent-inference').value[0].content.includes('HTTP 401')); assert.equal(native.status().activeTurns, 0);
});

test('explicit native patch requests contain only new steps, not duplicate user turns', async () => {
  const native = new NativeMock({ provider: { status: () => ({ mode: 'deepseek' }), config: () => ({}), async* generate() { yield '合成预览'; } } });
  const response = await native.handle('runInferenceTranscript', { ...input(), asPatchResponse: true });
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  const patches = events.filter(e => e.type.startsWith('patch-'));
  assert.equal(patches[0].type, 'patch-start'); assert.equal(patches.at(-1).type, 'patch-sync');
  assert.equal(patches.at(-1).data.s.length, 1); assert.equal(patches.at(-1).data.s[0].type, 'agent-inference');
});
