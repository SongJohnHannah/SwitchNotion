import { createRequire } from 'node:module';
import { autofillViewFixture } from './native-autofill-view.mjs';
import { autofillId } from './native-autofill.mjs';
const { NativeMeetingStore } = createRequire(import.meta.url)('../../src/meeting-summary-store.cjs');
export function aiBlockDatabaseFixture() {
  const f = autofillViewFixture(), pageId = autofillId(50), aiId = autofillId(51), excludedId = autofillId(52), mediaId = autofillId(53);
  const put = (id, value) => f.records.set('block:' + id, { id, alive: true, version: 1, space_id: f.ids.space, ...value });
  put(pageId, { type: 'page', content: [aiId, excludedId], properties: { title: [['AI block 测试页']] } });
  put(aiId, { type: 'ai_block', parent_table: 'block', parent_id: pageId, content: [], format: { ai_block_configuration_menu: {
    version: 3, type: 'custom', context: [{ type: 'collection', pageId: f.ids.parent, collectionId: f.ids.collection }],
    searchScopes: [], autofillInstructions: [['总结明确选择的数据库，包括分类和正文。']]
  } } });
  put(excludedId, { type: 'text', parent_table: 'block', parent_id: pageId, properties: { title: [['unselected-current-page-must-not-read']] } });
  put(mediaId, { type: 'pdf', parent_table: 'block', parent_id: f.ids.first, properties: { source: [['https://example.invalid/synthetic.pdf']] } });
  f.get('block', f.ids.first).content.push(mediaId);
  f.get('block', f.ids.unselected).properties.title = [['第三条市场资料']];
  f.setQuery(() => ({ result: { reducerResults: { results: { type: 'results', hasMore: false,
    blockIds: [f.ids.first, f.ids.second, f.ids.unselected].filter(id => f.get('block', id)?.alive !== false) } } } }));
  const store = new NativeMeetingStore({ api: f.native.api, spaceId: f.ids.space, userId: f.ids.user });
  const requests = [], provider = { config: () => ({ mode: 'deepseek' }), async* generate(args) {
    requests.push(args); yield '数据库合成摘要';
  } };
  const input = { blockPointer: { table: 'block', id: aiId, spaceId: f.ids.space }, parentPagePointer: { table: 'block', id: pageId, spaceId: f.ids.space } };
  return { ...f, pageId, aiId, excludedId, mediaId, store, provider, requests, input };
}
