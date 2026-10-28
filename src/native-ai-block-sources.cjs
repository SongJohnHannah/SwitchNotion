const { createInlineReferenceReader } = require('./inline-references.cjs');
const { researchWorkspace } = require('./research-scope.cjs');

async function readForeignSource(workspace, source, signal, beforeRead) {
  if (!workspace?.open) throw Error('AI block 跨工作区来源需要该工作区已有的 API 连接。');
  const tracked = { open: async options => {
    const session = await workspace.open(options);
    return { ...session, execute: (name, args) => { beforeRead(signal); return session.execute(name, args); } };
  } };
  const config = { notion: true, rootIds: [source.collectionId || source.pageId], collections: source.type === 'collection' ? [{ pageId: source.pageId, collectionId: source.collectionId }] : [] };
  const scoped = researchWorkspace(tracked, { spaceId: source.spaceId, config });
  const reader = createInlineReferenceReader({ workspace: scoped, maxCalls: 1024, maxBlocks: 800, maxCharacters: 160000,
    databaseReferences: source.type === 'collection' ? [source.pageId] : [], includeDatabaseBodies: true });
  const value = await reader({ pointers: [{ table: 'block', id: source.pageId, spaceId: source.spaceId }], spaceId: source.spaceId, signal });
  const selected = value.references[0];
  if (source.type === 'collection' ? selected.kind !== 'database' : selected.kind !== 'page') throw Error('AI block 跨工作区来源类型与明确选择的页面或数据库不匹配。');
  return { ...selected, type: source.type === 'collection' ? 'database' : 'page', workspace_id: source.spaceId,
    scope: { explicit_selection: true, expand_child_pages: false, attachment_bodies: false },
    note: '只读取明确选择的页面或数据源及记录自身正文；未展开子页面、关联页面或附件正文。文件名称及链接不代表已经解析附件。' };
}
module.exports = { readForeignSource };
