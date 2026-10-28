import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { generateAiBlock } = createRequire(import.meta.url)('../src/native-ai-block.cjs');
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', PAGE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', AI = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', BODY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', OTHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
function fixture(type = 'summarizeThisPage') {
  const blocks = new Map([
    [PAGE, { id: PAGE, type: 'page', properties: { title: [['项目页面']] }, content: [BODY, AI, OTHER] }],
    [BODY, { id: BODY, type: 'text', parent_id: PAGE, properties: { title: [['项目将在周五发布。']] } }],
    [AI, { id: AI, type: 'ai_block', parent_id: PAGE, format: { ai_block_configuration_menu: { type, context: [{ type: 'currentPage', pageId: PAGE }], searchScopes: [], ...(type === 'custom' ? { autofillInstructions: [['生成标题']] } : {}) } }, content: [] }],
    [OTHER, { id: OTHER, type: 'page', parent_id: PAGE, properties: { title: [['子页面']] }, content: ['ffffffff-ffff-4fff-8fff-ffffffffffff'] }]
  ]);
  const store = { spaceId: SPACE, async records(ids) { return new Map(ids.filter(id => blocks.has(id)).map(id => [id, { role: 'editor', value: blocks.get(id) }])); } };
  let messages;
  const provider = { config: () => ({}), async* generate(args) { messages = args.messages; yield '结果'; yield '完成'; } };
  const input = { blockPointer: { table: 'block', id: AI, spaceId: SPACE }, parentPagePointer: { table: 'block', id: PAGE, spaceId: SPACE } };
  return { blocks, store, provider, input, messages: () => messages };
}
for (const type of ['summarizeThisPage', 'extractKeyPointsFromThisPage', 'custom']) test(`AI block ${type} generates current-page Markdown without reading child pages`, async () => {
  const f = fixture(type), response = await generateAiBlock(f);
  assert.match(response.headers.get('content-type'), /ndjson/);
  assert.deepEqual(JSON.parse((await response.text()).trim()), { markdownString: '结果完成' });
  const prompt = f.messages().at(-1).content;
  assert.match(prompt, /项目将在周五发布/); assert.match(prompt, type === 'custom' ? /生成标题/ : type === 'summarizeThisPage' ? /总结/ : /关键要点/);
  assert.ok(!prompt.includes('ffffffff-ffff-4fff-8fff-ffffffffffff'));
});
test('AI block rejects unsupported context, unrelated pages, incomplete data and generation failures', async () => {
  const a = fixture(); a.blocks.get(AI).format.ai_block_configuration_menu.searchScopes = [{ type: 'notion' }]; await assert.rejects(generateAiBlock(a), /当前页面/);
  const a2 = fixture('custom'); delete a2.blocks.get(AI).format.ai_block_configuration_menu.context; assert.equal((await generateAiBlock(a2)).status, 200);
  const a3 = fixture('custom'); a3.blocks.get(AI).format.ai_block_configuration_menu.searchScope = { type: 'notion' }; await assert.rejects(generateAiBlock(a3), /当前页面/);
  const b = fixture(); b.blocks.get(AI).parent_id = OTHER; await assert.rejects(generateAiBlock(b), /不属于/);
  const c = fixture(); c.blocks.delete(BODY); await assert.rejects(generateAiBlock(c), /不完整/);
  const d = fixture(); d.provider.generate = async function* () { yield 'partial'; throw Error('provider failure'); }; await assert.rejects(generateAiBlock(d), /provider failure/);
});

test('AI block reads only explicitly selected pages, deduplicates sources and preserves their order', async () => {
  const f = fixture('custom'), config = f.blocks.get(AI).format.ai_block_configuration_menu;
  config.context = [{ type: 'page', pageId: OTHER }, { type: 'page', pageId: OTHER }];
  const child = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  f.blocks.set(child, { id: child, type: 'text', parent_id: OTHER, properties: { title: [['指定资料：负责人小林，预算 927。']] } });
  const requested = [], records = f.store.records;
  f.store.records = async (ids, signal) => { requested.push(...ids); return records(ids, signal); };
  const response = await generateAiBlock(f);
  assert.equal(response.status, 200);
  const prompt = JSON.stringify(f.messages());
  assert.match(prompt, /指定资料：负责人小林，预算 927/);
  assert.ok(!prompt.includes('项目将在周五发布'));
  assert.ok(!requested.includes(BODY), 'unselected current-page content must not be read');
  assert.equal(prompt.match(/指定资料：负责人小林/g)?.length, 1);
});

test('AI block combines current page and an explicit page without expanding their child pages', async () => {
  const f = fixture('custom');
  f.blocks.get(AI).format.ai_block_configuration_menu.context.push({ type: 'page', pageId: OTHER });
  f.blocks.get(OTHER).content = [];
  await generateAiBlock(f);
  const prompt = JSON.stringify(f.messages());
  assert.match(prompt, /项目将在周五发布/);
  assert.match(prompt, new RegExp(OTHER));
  assert.ok(prompt.indexOf(PAGE) < prompt.lastIndexOf(OTHER));
});

test('AI block does not generate with inaccessible or unsupported selected sources', async () => {
  for (const context of [[{ type: 'page', pageId: BODY }], [{ type: 'collection', pageId: OTHER, collectionId: PAGE }],
    [{ type: 'page', pageId: 'invalid' }], [{ type: 'currentPage', pageId: OTHER }]]) {
    const f = fixture('custom'); f.blocks.get(AI).format.ai_block_configuration_menu.context = context;
    await assert.rejects(generateAiBlock(f));
    assert.equal(f.messages(), undefined);
  }
  const f = fixture('custom'); f.blocks.get(AI).format.ai_block_configuration_menu.context = [{ type: 'page', pageId: OTHER }];
  f.blocks.delete(OTHER); await assert.rejects(generateAiBlock(f), /读取|完整|来源/);
  assert.equal(f.messages(), undefined);
});

test('AI block rejects a source or selected-context change during generation', async () => {
  for (const change of [f => { f.blocks.get(BODY).properties.title = [['生成期间修改']]; },
    f => { f.blocks.get(AI).format.ai_block_configuration_menu.context = []; }]) {
    const f = fixture('custom');
    f.provider.generate = async function* () { yield '尚未提交的结果'; change(f); };
    await assert.rejects(generateAiBlock(f), /变化|修改/);
  }
});

test('AI block aborts a selected-page read before invoking the model', async () => {
  const f = fixture('custom'), controller = new AbortController();
  f.blocks.get(AI).format.ai_block_configuration_menu.context = [{ type: 'page', pageId: OTHER }];
  f.blocks.get(OTHER).content = [];
  const records = f.store.records;
  f.store.records = async (ids, signal) => { if (ids.includes(OTHER)) controller.abort(); return records(ids, signal); };
  await assert.rejects(generateAiBlock({ ...f, signal: controller.signal }), /abort/i);
  assert.equal(f.messages(), undefined);
});
