const { createHash } = require('node:crypto');
const { CollectionNotion } = require('../collection/notion.cjs');
const { destination } = require('../collection/model.cjs');
const { uuid } = require('../native-context.cjs');

// Choosing a configured connection does not grant access. Mac can populate
// its selector without waiting for every other connection's network probe;
// search and writes still use the original identity and permission checks.
class MacCollectionNotion extends CollectionNotion {
  async workspaces(signal) {
    signal?.throwIfAborted();
    const workspaces = [], unavailable = [];
    let discover = false;
    for (const profile of this.router.profiles()) {
      try {
        const cfg = this.router.client(profile).config();
        if (!cfg.enabled || !cfg.key) {
          unavailable.push({ workspace_id: profile?.workspaceId || null, error: 'Notion 连接未启用或未填写本地密钥。' });
          continue;
        }
        const id = uuid(profile?.workspaceId || cfg.workspaceId);
        if (!id) { discover = true; continue; }
        const identity = this.router.identities.get(createHash('sha256').update(cfg.key).digest('hex'));
        const verified = identity?.id === id && identity.expiresAt > Date.now();
        const name = profile?.name?.trim() || (verified && identity.name) || 'Notion 工作区';
        workspaces.push({ id, name: name + (verified ? '' : '（待联网核验）'), readOnly: cfg.readOnly, verified });
      } catch {
        unavailable.push({ workspace_id: profile?.workspaceId || null, error: 'Notion 本机连接配置无效，请在“管理连接”中检查。' });
      }
    }
    if (!workspaces.length && discover) {
      const result = await this.router.prepare(signal);
      workspaces.push(...result.workspaces.map(w => ({ id: w.id, name: w.name, readOnly: w.cfg.readOnly, verified: true })));
      unavailable.push(...result.unavailable);
    }
    if (!workspaces.length) throw Error(unavailable[0]?.error || '请先在“管理连接”中添加 Notion 工作区连接。');
    return { workspaces, unavailable, autoSelectWorkspaceId: workspaces.find(w => w.verified && !w.readOnly)?.id || '',
      selectionHint: '选择已配置的工作区后，再联网核对并搜索保存位置；待核验不代表连接已通过。' };
  }
  scoped(workspaceId) {
    const id = uuid(workspaceId);
    if (!id) throw Error('请选择有效的 Notion 工作区。');
    const owner = this.router, scoped = Object.create(this);
    scoped.router = { prepare: async signal => {
      const result = await owner.prepare(signal, id);
      if (!result.workspaces.some(w => w.id === id)) {
        const problem = result.unavailable.find(w => !w.workspace_id || uuid(w.workspace_id) === id);
        if (problem) throw Error(problem.error);
      }
      return result;
    } };
    return scoped;
  }
  async connect(target, signal, scope) {
    const picked = destination(target);
    if (!picked) throw Error('请选择 Notion 保存位置。');
    return super.connect.call(this.scoped(picked.workspaceId), picked, signal, scope);
  }
  async search(workspaceId, query, cursors, signal) {
    return super.search.call(this.scoped(workspaceId), uuid(workspaceId), query, cursors, signal);
  }
}
module.exports = { MacCollectionNotion };
