const { uuid } = require('./native-context.cjs');
const readNames = new Set(['list_workspaces', 'search_pages', 'read_page', 'read_page_info', 'read_block', 'read_block_children',
  'search_databases', 'read_database', 'query_database', 'read_database_entry', 'read_database_entry_property', 'list_comments', 'list_database_views']);
function researchWorkspace(workspace, { spaceId, config, onSource = () => {} }) {
  if (!config.notion) return;
  if (!workspace?.open) throw Error('Notion 研究来源尚未配置工作区连接。');
  return { open: async (options = {}) => {
    const readScope = { workspaceId: spaceId, ...(config.rootIds.length ? { rootIds: config.rootIds } : {}) };
    const session = await workspace.open({ ...options, readScope, nativeContext: { ...options.nativeContext, workspace_id: spaceId } });
    if (!session || uuid(session.context?.current_workspace_id) !== spaceId) throw Error('Notion 研究来源工作区未匹配。');
    if (config.rootIds.length) {
      const proof = session.context?.read_scope;
      if (!proof || proof.read_only !== true || uuid(proof.workspace_id) !== spaceId || !Array.isArray(proof.root_ids) ||
          new Set(proof.root_ids.map(uuid)).size !== config.rootIds.length || config.rootIds.some(id => !proof.root_ids.map(uuid).includes(id))) throw Error('Notion 此读取适配器尚未核对页面或数据库范围，未扩大到整个工作区。');
    }
    const aliases = new Map(config.collections.map(value => [value.pageId, value.collectionId]));
    for (const value of config.collections) {
      const metadata = await session.execute('read_database', { data_source_id: value.collectionId, workspace_id: spaceId });
      if (uuid(metadata.data_source_id) !== value.collectionId || uuid(metadata.parent?.database_id) !== value.pageId) throw Error('Notion 所选数据库与数据源关联不匹配，未读取其他数据源。');
    }
    const definitions = (session.definitions || []).filter(value => readNames.has(value.function.name));
    return { definitions, context: session.context, execute: async (name, args = {}) => {
      if (!readNames.has(name) || !definitions.some(value => value.function.name === name)) throw Error('Notion 研究模式拒绝写入或未启用的工具。');
      if (args.workspace_id !== undefined && args.workspace_id !== 'current' && uuid(args.workspace_id) !== spaceId) throw Error('Notion 研究模式不能扩大到其他工作区。');
      let input = { ...args, ...(name === 'list_workspaces' ? {} : { workspace_id: spaceId }) };
      if (name === 'read_database' && aliases.has(uuid(input.database_id))) { input.data_source_id = aliases.get(uuid(input.database_id)); delete input.database_id; }
      const result = await session.execute(name, input);
      for (const row of [result, ...(result.results || [])]) {
        if (row.workspace_id !== undefined && uuid(row.workspace_id) !== spaceId) throw Error('Notion 研究返回了其他工作区的资料，已停止使用。');
        if (row.url) onSource({ ...row, kind: /^search_/.test(name) ? 'snippet' : 'notion', body_available: ['read_page', 'read_block', 'read_database_entry', 'read_database_entry_property'].includes(name) });
      }
      return result;
    } };
  } };
}
module.exports = { researchWorkspace, readNames };
