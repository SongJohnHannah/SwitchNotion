import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { inlineDocumentRoute, id, USER, SPACE, THREAD } from './helpers/inline-document-route.mjs';
const { NativeWriter } = createRequire(import.meta.url)('../src/native-writer.cjs');
const PAGE = id(4), ANCHOR = id(5), PREVIOUS = id(6), NEXT = id(7);

function fixture(t, options = {}) {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'writer-test-'));
  const blocks = new Map([
    [PAGE, { id: PAGE, type: 'page', space_id: SPACE, alive: true, content: [PREVIOUS, ANCHOR, NEXT] }],
    [PREVIOUS, { id: PREVIOUS, type: 'text', space_id: SPACE, parent_table: 'block', parent_id: PAGE, properties: { title: [['合成项目927，发布前先校对。']] }, alive: true }],
    [ANCHOR, { id: ANCHOR, type: 'text', space_id: SPACE, parent_table: 'block', parent_id: PAGE, properties: { title: [['']] }, alive: true }],
    [NEXT, { id: NEXT, type: 'page', space_id: SPACE, parent_table: 'block', parent_id: PAGE, properties: { title: [['不可展开的后续子页面']] }, alive: true }]
  ]);
  const reads = [], generations = [], writes = [];
  const store = { userId: USER, spaceId: SPACE, async records(ids) {
    reads.push(...ids); return new Map(ids.filter(value => blocks.has(value)).map(value => [value, { role: options.role || 'editor', value: structuredClone(blocks.get(value)) }]));
  }, async api(endpoint, payload) {
    if (endpoint === 'getRecordValues') return { results: payload.requests.map(request => blocks.has(request.id) ? {
      role: options.role || 'editor', value: structuredClone(blocks.get(request.id))
    } : { role: 'none' }) };
    assert.equal(endpoint, 'saveTransactionsFanout'); writes.push(payload);
    if (!options.dropWrite && !(options.dropUndoWrite && writes.length > 1)) for (const { operations } of payload.transactions) for (const operation of operations) {
      const { pointer, path: keys, command, args } = operation;
      if (command === 'set' && !keys.length) blocks.set(pointer.id, structuredClone(args));
      else if (command === 'set') { assert.deepEqual(keys, ['properties', 'title']); blocks.get(pointer.id).properties.title = structuredClone(args); }
      else if (command === 'update') Object.assign(blocks.get(pointer.id), args);
      else if (command === 'listAfter') { const content = blocks.get(pointer.id).content; content.splice(args.after ? content.indexOf(args.after) + 1 : 0, 0, args.id); }
      else if (command === 'listRemove') { const content = blocks.get(pointer.id).content; const at = content.indexOf(args.id); if (at >= 0) content.splice(at, 1); }
      else assert.fail('Unexpected native writer operation');
    }
    if (options.loseResponse || options.loseUndoResponse && writes.length > 1) throw Error('response lost');
    return {};
  } };
  const provider = { config: () => ({ mode: 'deepseek' }), async* generate(args) {
    generations.push(args); assert.equal(args.tools, undefined);
    if (options.generate) return yield* options.generate(args, blocks);
    if (args.messages[0].content.includes('只返回 JSON')) {
      const source = JSON.parse(args.messages[1].content);
      yield JSON.stringify(args.messages[0].content.includes('edits') ? { edits: source.selected.map(range => ({ id: range.id, text: '合成续写927，准备发布。' })) } : { text: '合成续写927，准备发布。' });
      return;
    }
    yield '合成续写927'; yield '，准备发布。';
  } };
  const route = inlineDocumentRoute(root, { provider });
  const source = fs.readFileSync(new URL('../src/desktop-hook.cjs', import.meta.url), 'utf8');
  route.context.endpoints = vm.runInNewContext(source.match(/const endpoints = (new Set\([^\n]+\));/)[1]);
  const makeWriter = () => new NativeWriter({ root, provider, storeFactory: () => store, hasRecord: () => !!options.collision });
  route.context.nativeWriter = makeWriter();
  const input = () => ({ type: 'personal_agent', threadId: THREAD, spaceId: SPACE, clientMessageId: id(8), content: [{ type: 'text', text: [['继续']] }],
    prebuiltPromptType: 'continue_writing', surface: 'rich_text_menu', threadContext: { currentBlockId: PAGE, selectionPageId: PAGE,
      selection: { type: 'text', text: '', value: { start: { pointer: { table: 'block', id: ANCHOR, spaceId: SPACE }, index: 0 }, end: { pointer: { table: 'block', id: ANCHOR, spaceId: SPACE }, index: 0 } } } } });
  const run = async (payload = input(), user = USER) => { const response = await route.call('runWriter', payload, user); return { status: response.status, value: await response.json() }; };
  const undo = async (result, edits = {}, user = USER) => {
    const response = await route.call('undoAgentServiceTurn', { threadId: THREAD, spaceId: SPACE, sessionIdleEventId: result.sessionIdleEventId, ...edits }, user);
    return { status: response.status, value: await response.json() };
  };
  t.after(() => { route.context.nativeWriter.close(); route.close(); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, blocks, generations, writes, reads, provider, store, route, input, run, undo,
    get writer() { return route.context.nativeWriter; }, restore() { route.context.nativeWriter.close(); route.context.nativeWriter = makeWriter(); } };
}

test('Continue runWriter is intercepted instead of falling through to the credit-gated upstream', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-writer-route-'));
  const f = inlineDocumentRoute(root);
  t.after(() => { f.close(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const source = fs.readFileSync(new URL('../src/desktop-hook.cjs', import.meta.url), 'utf8');
  f.context.endpoints = vm.runInNewContext(source.match(/const endpoints = (new Set\([^\n]+\));/)[1]);
  await f.call('runWriter', {});
  assert.deepEqual(f.forwarded, []);
});

test('native Continue reads nearby context, calls the model, saves at the cursor and returns the native JSON record map', async t => {
  const f = fixture(t), result = await f.run();
  assert.equal(result.value.status, 'edited'); assert.equal(result.value.acknowledgment, '续写已保存。');
  assert.deepEqual(f.blocks.get(ANCHOR).properties.title, [['合成续写927，准备发布。']]);
  assert.equal(result.value.recordMap.block[ANCHOR].value.value.id, ANCHOR);
  assert.equal(f.generations.length, 1); assert.equal(f.writes.length, 1); assert.equal(f.writer.active, 0);
  assert.match(JSON.stringify(f.generations[0].messages), /发布前先校对/); assert.ok(!f.reads.includes(NEXT));
  const transcript = await (await f.route.call('getThreadTranscript', { threadId: THREAD, spaceId: SPACE })).json();
  assert.equal(transcript.session.status, 'idle'); assert.ok(transcript.patches.some(p => p.entity.kind === 'assistant_message' && p.entity.content[0].text.includes('927')));
  assert.deepEqual(await (await f.route.call('getThreadSpaceId', { threadId: THREAD })).json(), { spaceId: SPACE });
  assert.equal((await f.route.call('getThreadSpaceId', { threadId: THREAD }, id(90))).status, 403);
  assert.deepEqual(f.route.forwarded, []);
});

test('cursor indices use graphemes and preserve existing rich-text annotations and suffix', async t => {
  const f = fixture(t); f.blocks.get(ANCHOR).properties.title = [['👩‍💻开头', [['b']]], ['后文', [['i']]]];
  const input = f.input(); input.threadContext.selection.value.start.index = input.threadContext.selection.value.end.index = 3;
  assert.equal((await f.run(input)).value.status, 'edited');
  assert.deepEqual(f.blocks.get(ANCHOR).properties.title, [['👩‍💻开头', [['b']]], ['合成续写927，准备发布。'], ['后文', [['i']]]]);
});

test('block selections append one sibling after the last selected paragraph and preserve following content', async t => {
  const f = fixture(t), input = f.input();
  input.threadContext.selection = { type: 'blocks', text: '', value: [{ table: 'block', id: ANCHOR, spaceId: SPACE }] };
  const result = await f.run(input); assert.equal(result.value.status, 'edited');
  const content = f.blocks.get(PAGE).content; assert.equal(content.length, 4); assert.deepEqual(content.filter(value => value !== content[2]), [PREVIOUS, ANCHOR, NEXT]);
  assert.equal(f.blocks.get(content[2]).properties.title[0][0], '合成续写927，准备发布。'); assert.equal(f.writes.length, 1);
});

test('duplicate clicks, result checks and restarting never generate or submit the same edit twice', async t => {
  const f = fixture(t), input = f.input();
  const results = await Promise.all([f.run(input), f.run(input)]); assert.ok(results.every(value => value.value.status === 'edited'));
  await f.run(input); f.restore(); assert.equal((await f.run(input)).value.status, 'edited');
  assert.equal(f.generations.length, 1); assert.equal(f.writes.length, 1);
  const other = structuredClone(input); other.content[0].text = [['继续写']]; assert.equal((await f.run(other)).status, 409);
});

test('a response lost after commit is reconciled after restarting without a duplicate write', async t => {
  const f = fixture(t, { loseResponse: true }), input = f.input();
  assert.equal((await f.run(input)).value.status, 'pending'); f.restore();
  assert.equal((await f.run(input)).value.status, 'edited'); assert.equal(f.writes.length, 1); assert.equal(f.generations.length, 1);
});

test('an uncertain uncommitted request is checked without resending it', async t => {
  const f = fixture(t, { loseResponse: true, dropWrite: true }), input = f.input();
  assert.equal((await f.run(input)).value.status, 'pending');
  assert.match((await f.run(input)).value.acknowledgment, /不会重复写入/); assert.equal(f.writes.length, 1);
});

test('source changes and read-only roles prevent submission', async t => {
  const f = fixture(t, { generate: async function* (args, blocks) { yield '已生成'; blocks.get(ANCHOR).properties.title = [['用户刚修改的内容']]; } });
  const result = await f.run(); assert.equal(result.value.status, 'no_edit'); assert.match(result.value.acknowledgment, /发生变化/); assert.equal(f.writes.length, 0);
  const r = fixture(t, { role: 'reader' }); assert.equal((await r.run()).value.status, 'no_edit'); assert.equal(r.generations.length, 0); assert.equal(r.writes.length, 0);
});

test('account/workspace isolation, foreign selections and existing thread collisions fail before another model call', async t => {
  const f = fixture(t); await f.run();
  assert.equal((await f.run(f.input(), id(90))).status, 403);
  const other = f.input(); other.spaceId = id(91); other.threadContext.selection.value.end.pointer.spaceId = id(91); other.threadContext.selection.value.start.pointer.spaceId = id(91);
  assert.equal((await f.run(other)).status, 403);
  const c = fixture(t, { collision: true }); assert.equal((await c.run()).status, 409); assert.equal(c.generations.length, 0);
  const input = c.input(); input.threadContext.selection.value.end.pointer.spaceId = id(99);
  assert.equal((await c.run(input)).value.status, 'no_edit'); assert.equal(c.writes.length, 0);
});

test('provider failures, unsupported prompts and absent cursor positions produce visible native acknowledgment', async t => {
  const f = fixture(t, { generate: async function* () { throw Error('DeepSeek API 返回 HTTP 401'); } });
  assert.match((await f.run()).value.acknowledgment, /HTTP 401/); assert.equal(f.writes.length, 0);
  const r = fixture(t), input = r.input(); input.prebuiltPromptType = 'generate_image_prompt';
  assert.match((await r.run(input)).value.acknowledgment, /预设指令尚未接入/);
  delete input.threadContext.selection; input.prebuiltPromptType = 'continue_writing';
  assert.match((await r.run(input)).value.acknowledgment, /没有取得光标/); assert.equal(r.generations.length, 0);
});

test('stopping the native writer cancels generation before a page transaction', async t => {
  let began;
  const ready = new Promise(resolve => { began = resolve; });
  const f = fixture(t, { generate: async function* ({ signal }) { began(); yield '半句'; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted(); } });
  const running = f.run(); await ready;
  await f.route.call('stopWorkflowAutomationRunThread', { threadId: THREAD, spaceId: SPACE });
  const result = await running; assert.match(result.value.acknowledgment, /已停止/); assert.equal(f.writes.length, 0); assert.equal(f.writer.active, 0);
});

test('native stop event batches cancel the writer and unsupported model choices cannot be silently ignored', async t => {
  let began; const ready = new Promise(resolve => { began = resolve; });
  const f = fixture(t, { generate: async function* ({ signal }) { began(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted(); } });
  const running = f.run(); await ready;
  await f.route.call('sendEventToAgentThread', { threadId: THREAD, spaceId: SPACE, events: [{ type: 'session.interrupt' }] });
  assert.match((await running).value.acknowledgment, /已停止/); assert.equal(f.writes.length, 0);
  const r = fixture(t), input = r.input(); input.modelSelection = { type: 'explicit', model: 'unrecognized-model' };
  assert.match((await r.run(input)).value.acknowledgment, /模型选择无效/); assert.equal(r.generations.length, 0);
});

test('stale selection previews and extra attachments are rejected before model generation', async t => {
  const f = fixture(t), input = f.input(); f.blocks.get(ANCHOR).properties.title = [['当前正文']];
  input.threadContext.selection.value.end.index = 4; input.threadContext.selection.text = '过期正文';
  assert.match((await f.run(input)).value.acknowledgment, /选区文字已变化/);
  const attachment = f.input(); attachment.content.push({ type: 'file', file_id: id(99) });
  assert.equal((await f.run(attachment)).value.status, 'no_edit'); assert.equal(f.generations.length, 0); assert.equal(f.writes.length, 0);
});

for (const prompt of ['improve_writing', 'rewrite', 'translate', 'summarize', undefined]) test(`native Writer ${prompt || 'custom edit'} replaces its selected text instead of rejecting the instruction`, async t => {
  const f = fixture(t), input = f.input(); f.blocks.get(ANCHOR).properties.title = [['原文']];
  input.prebuiltPromptType = prompt; input.content[0].text = [[prompt === 'translate' ? '翻译成英语' : prompt ? '修改选中文字' : '改写成适合公告的简洁表达']];
  input.threadContext.selection.text = '原文'; input.threadContext.selection.value.end.index = 2;
  const result = await f.run(input);
  assert.equal(result.value.status, 'edited'); assert.equal(f.writes.length, 1);
  assert.equal(f.blocks.get(ANCHOR).properties.title.map(span => span[0]).join(''), '合成续写927，准备发布。');
});

test('the native undoAgentServiceTurn request restores the original paragraph', async t => {
  const f = fixture(t), result = await f.run();
  const response = await f.route.call('undoAgentServiceTurn', { threadId: THREAD, spaceId: SPACE, sessionIdleEventId: result.value.sessionIdleEventId });
  assert.equal(response.status, 200); assert.deepEqual(f.blocks.get(ANCHOR).properties.title, [['']]);
  assert.equal(result.value.undoReady, true); assert.equal(f.generations.length, 1);
});

test('editing part of a formatted paragraph preserves prefix, suffix, links and block properties, and undo restores original runs', async t => {
  const original = [['前'], ['坏文', [['b']]], ['链接', [['a', 'https://example.test/']]], ['后', [['i']]]];
  const f = fixture(t, { generate: async function* ({ messages }) {
    const source = JSON.parse(messages[1].content); assert.equal(source.selected[0].runs.length, 2);
    yield JSON.stringify({ edits: [{ id: ANCHOR, runs: [{ source: 0, text: '好文' }, { source: 1, text: '新链接' }] }] });
  } });
  Object.assign(f.blocks.get(ANCHOR), { type: 'to_do', properties: { title: structuredClone(original), checked: [['Yes']] }, format: { block_color: 'blue' } });
  const input = f.input(); input.prebuiltPromptType = 'improve_writing'; input.threadContext.selection.text = '坏文链接';
  input.threadContext.selection.value.start.index = 1; input.threadContext.selection.value.end.index = 5;
  const result = await f.run(input); assert.equal(result.value.status, 'edited');
  assert.deepEqual(f.blocks.get(ANCHOR).properties.title, [['前'], ['好文', [['b']]], ['新链接', [['a', 'https://example.test/']]], ['后', [['i']]]]);
  assert.deepEqual(f.blocks.get(ANCHOR).properties.checked, [['Yes']]); assert.equal(f.blocks.get(ANCHOR).type, 'to_do');
  assert.equal((await f.undo(result.value)).status, 200); assert.deepEqual(f.blocks.get(ANCHOR).properties.title, original);
});

test('cross-paragraph rewrite updates every selected range while retaining unselected prefix and suffix', async t => {
  const f = fixture(t, { generate: async function* ({ messages }) {
    const source = JSON.parse(messages[1].content);
    yield JSON.stringify({ edits: source.selected.map((range, index) => ({ id: range.id, text: '改' + index })) });
  } });
  f.blocks.get(PREVIOUS).properties.title = [['前原']]; f.blocks.get(ANCHOR).properties.title = [['文后']];
  const input = f.input(); input.prebuiltPromptType = 'rewrite'; input.threadContext.selection.text = '原\n文';
  input.threadContext.selection.value.start = { pointer: { table: 'block', id: PREVIOUS, spaceId: SPACE }, index: 1 };
  input.threadContext.selection.value.end.index = 1;
  const result = await f.run(input); assert.equal(result.value.status, 'edited');
  assert.equal(f.blocks.get(PREVIOUS).properties.title.map(span => span[0]).join(''), '前改0');
  assert.equal(f.blocks.get(ANCHOR).properties.title.map(span => span[0]).join(''), '改1后');
  assert.equal((await f.undo(result.value)).status, 200); assert.deepEqual(f.blocks.get(PREVIOUS).properties.title, [['前原']]); assert.deepEqual(f.blocks.get(ANCHOR).properties.title, [['文后']]);
});

test('a multi-paragraph summary replaces the selected range and native undo restores archived paragraphs and their order', async t => {
  const f = fixture(t); f.blocks.get(PREVIOUS).properties.title = [['前原']]; f.blocks.get(ANCHOR).properties.title = [['文后']];
  const input = f.input(); input.prebuiltPromptType = 'summarize'; input.threadContext.selection.text = '原\n文';
  input.threadContext.selection.value.start = { pointer: { table: 'block', id: PREVIOUS, spaceId: SPACE }, index: 1 };
  input.threadContext.selection.value.end.index = 1;
  const result = await f.run(input); assert.equal(result.value.status, 'edited');
  assert.equal(f.blocks.get(PREVIOUS).properties.title.map(span => span[0]).join(''), '前合成续写927，准备发布。后');
  assert.equal(f.blocks.get(ANCHOR).alive, false); assert.deepEqual(f.blocks.get(PAGE).content, [PREVIOUS, NEXT]);
  assert.equal((await f.undo(result.value)).status, 200);
  assert.equal(f.blocks.get(ANCHOR).alive, true); assert.deepEqual(f.blocks.get(PAGE).content, [PREVIOUS, ANCHOR, NEXT]);
  assert.deepEqual(f.blocks.get(PREVIOUS).properties.title, [['前原']]); assert.deepEqual(f.blocks.get(ANCHOR).properties.title, [['文后']]);
});

test('add_summary appends without replacing originals and undo removes only the generated paragraph', async t => {
  const f = fixture(t); f.blocks.get(ANCHOR).properties.title = [['原文']];
  const input = f.input(); input.prebuiltPromptType = 'add_summary'; input.threadContext.selection = { type: 'blocks', text: '原文', value: [{ table: 'block', id: ANCHOR, spaceId: SPACE }] };
  const result = await f.run(input), created = f.blocks.get(PAGE).content[2];
  assert.equal(result.value.undoReady, true); assert.deepEqual(f.blocks.get(ANCHOR).properties.title, [['原文']]);
  assert.notEqual(created, NEXT); assert.equal((await f.undo(result.value)).status, 200);
  assert.deepEqual(f.blocks.get(PAGE).content, [PREVIOUS, ANCHOR, NEXT]); assert.equal(f.blocks.get(created).alive, false);
});

test('later manual edits prevent undo while edits to unrelated paragraphs are preserved', async t => {
  const f = fixture(t), result = await f.run(); f.blocks.get(ANCHOR).properties.title = [['用户后续输入']];
  assert.equal((await f.undo(result.value)).status, 409); assert.equal(f.writes.length, 1); assert.deepEqual(f.blocks.get(ANCHOR).properties.title, [['用户后续输入']]);
  const r = fixture(t), accepted = await r.run(); r.blocks.get(PREVIOUS).properties.title = [['其他段落的新内容']];
  assert.equal((await r.undo(accepted.value)).status, 200); assert.deepEqual(r.blocks.get(PREVIOUS).properties.title, [['其他段落的新内容']]);
});

test('native undo binds account, workspace and terminal event, survives restarting and is idempotent under concurrent clicks', async t => {
  const f = fixture(t), input = f.input(), result = await f.run(input);
  assert.equal((await f.run(input)).value.sessionIdleEventId, result.value.sessionIdleEventId);
  assert.equal((await f.undo(result.value, {}, id(90))).status, 403);
  assert.equal((await f.undo(result.value, { spaceId: id(90) })).status, 403);
  assert.equal((await f.undo(result.value, { sessionIdleEventId: id(90) })).status, 409);
  f.restore(); const responses = await Promise.all([f.undo(result.value), f.undo(result.value)]);
  assert.ok(responses.every(value => value.status === 200)); assert.equal(f.writes.length, 2);
  f.restore(); assert.equal((await f.undo(result.value)).status, 200); assert.equal(f.writes.length, 2);
  assert.equal((await f.run(input)).value.status, 'no_edit'); assert.equal(f.generations.length, 1);
});

test('a lost undo response is reconciled after restart without resubmitting the inverse transaction', async t => {
  const f = fixture(t, { loseUndoResponse: true }), result = await f.run();
  assert.equal((await f.undo(result.value)).status, 409); assert.deepEqual(f.blocks.get(ANCHOR).properties.title, [['']]);
  f.restore(); assert.equal((await f.undo(result.value)).status, 200); assert.equal(f.writes.length, 2); assert.equal(f.generations.length, 1);
});

test('an undo whose delivery is unknown is never repeated if its changes cannot be verified', async t => {
  const f = fixture(t, { loseUndoResponse: true, dropUndoWrite: true }), result = await f.run();
  assert.equal((await f.undo(result.value)).status, 409); f.restore();
  assert.equal((await f.undo(result.value)).status, 409); assert.equal(f.writes.length, 2);
  assert.match((await f.run()).value.acknowledgment, /撤销结果待核对/);
});

test('malformed/foreign output and changes to inline mentions cannot alter the page', async t => {
  for (const output of ['bad json', JSON.stringify({ edits: [{ id: NEXT, text: '不应修改' }] }), JSON.stringify({ edits: [{ id: ANCHOR, runs: [{ source: 0, text: '破坏提及' }] }] })]) {
    const f = fixture(t, { generate: async function* () { yield output; } }), input = f.input();
    f.blocks.get(ANCHOR).properties.title = [['‣', [['p', NEXT]]]];
    input.prebuiltPromptType = 'improve_writing'; input.threadContext.selection.text = '‣'; input.threadContext.selection.value.end.index = 1;
    assert.equal((await f.run(input)).value.status, 'no_edit'); assert.equal(f.writes.length, 0);
  }
});

test('clarifications are displayed without applying text and custom writing can insert at a collapsed cursor', async t => {
  const f = fixture(t, { generate: async function* () { yield JSON.stringify({ clarification: '请指定翻译的目标语言。' }); } }), input = f.input();
  f.blocks.get(ANCHOR).properties.title = [['原文']]; input.prebuiltPromptType = 'translate'; input.threadContext.selection.text = '原文'; input.threadContext.selection.value.end.index = 2;
  assert.match((await f.run(input)).value.acknowledgment, /目标语言/); assert.equal(f.writes.length, 0);
  const r = fixture(t), custom = r.input(); delete custom.prebuiltPromptType; custom.content[0].text = [['写一句简短的发布通知']];
  assert.equal((await r.run(custom)).value.status, 'edited');
});

test('a partial summary retains uniform selection style and leaves outer text intact', async t => {
  const f = fixture(t), original = [['前'], ['两句原文', [['b']]], ['后', [['i']]]];
  f.blocks.get(ANCHOR).properties.title = structuredClone(original);
  const input = f.input(); input.prebuiltPromptType = 'summarize'; input.threadContext.selection.text = '两句原文';
  input.threadContext.selection.value.start.index = 1; input.threadContext.selection.value.end.index = 5;
  const result = await f.run(input);
  assert.deepEqual(f.blocks.get(ANCHOR).properties.title, [['前'], ['合成续写927，准备发布。', [['b']]], ['后', [['i']]]]);
  assert.equal((await f.undo(result.value)).status, 200); assert.deepEqual(f.blocks.get(ANCHOR).properties.title, original);
});

test('legacy Continue records remain readable and idempotent without advertising unavailable old undo snapshots', async t => {
  const f = fixture(t), input = f.input(); await f.run(input);
  const file = path.join(f.root, 'writer-conversations.local.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8')), job = saved.jobs[0];
  job.plan = { blockId: ANCHOR, type: 'text', anchorParentId: PAGE, title: f.blocks.get(ANCHOR).properties.title };
  delete job.appliedRecords; delete job.undoToken;
  fs.writeFileSync(file, JSON.stringify(saved)); f.restore();
  const result = await f.run(input); assert.equal(result.value.status, 'edited'); assert.equal(result.value.undoReady, false);
  assert.equal(f.generations.length, 1); assert.equal(f.writes.length, 1);
});

test('a clarification returned during Continue is not inserted as JSON into the page', async t => {
  const f = fixture(t, { generate: async function* () { yield JSON.stringify({ clarification: '请补充续写的主题。' }); } });
  assert.match((await f.run()).value.acknowledgment, /请补充/); assert.equal(f.writes.length, 0);
});

test('summary and undo normalize omitted native alive defaults', async t => {
  const f = fixture(t); delete f.blocks.get(ANCHOR).alive; f.blocks.get(ANCHOR).properties.title = [['第二段']];
  const input = f.input(); input.prebuiltPromptType = 'summarize';
  input.threadContext.selection = { type: 'blocks', text: '', value: [PREVIOUS, ANCHOR].map(id => ({ table: 'block', id, spaceId: SPACE })) };
  const result = await f.run(input); assert.equal(result.value.status, 'edited');
  assert.equal((await f.undo(result.value)).status, 200); assert.notEqual(f.blocks.get(ANCHOR).alive, false);
});

test('Continue counts the complete immediate prefix against the source budget before calling the model', async t => {
  const f = fixture(t), input = f.input(); f.blocks.get(ANCHOR).properties.title = [['甲'.repeat(35000)]];
  input.threadContext.selection.value.end.index = 35000;
  assert.equal((await f.run(input)).value.status, 'no_edit'); assert.equal(f.generations.length, 0); assert.equal(f.writes.length, 0);
});
