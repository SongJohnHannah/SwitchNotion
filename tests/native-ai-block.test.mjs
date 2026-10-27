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
