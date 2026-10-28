const { uuid } = require('./native-context.cjs');
const { promptId, explicitPages, selectInstructionSettings, classifyReference } = require('./native-instruction-selection.cjs');
const { createHash } = require('node:crypto');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value)) || 'null').digest('hex');
function fingerprint(item, table) {
  if (!item) return hash(null);
  const value = item.value, base = { id: value.id, alive: value.alive };
  if (table === 'user_root') Object.assign(base, { space_view_pointers: value.space_view_pointers?.map(pointer => ({ table: pointer.table, id: pointer.id, spaceId: pointer.spaceId })), space_views: value.space_views });
  else if (table === 'space_view') Object.assign(base, { space_id: value.space_id, parent_id: value.parent_id, parent_table: value.parent_table, personalization: { context_page_id: value.settings?.agent_personalization_settings?.context_page_id, name: value.settings?.agent_personalization_settings?.name }, ai_prompts: value.settings?.ai_prompts });
  else if (table === 'space') Object.assign(base, { workspace_default_skills: value.settings?.workspace_default_skills, group_default_skills: value.settings?.group_default_skills, disable_agent_skills: value.settings?.disable_agent_skills, workspace_default_instructions_page_id: value.settings?.workspace_default_instructions_page_id });
  else Object.assign(base, { space_id: value.space_id, parent_id: value.parent_id, parent_table: value.parent_table, type: value.type, prompt_type: value.prompt_type, description: value.description, properties: value.properties, content: value.content });
  return hash({ role: item.role, value: base });
}
const readable = entry => entry && ['reader', 'commenter', 'editor', 'owner'].includes(entry.role) && entry.value?.alive !== false;
function entry(value) { for (let n = 0; n < 3 && value && !value.value?.id; n++) value = value.value; return value?.value?.id ? value : null; }
async function resolveNativeInstructions({ store, userId, spaceId, content, signal }) {
  userId = uuid(userId); spaceId = uuid(spaceId);
  if (!userId || !spaceId || store.userId !== userId || store.spaceId !== spaceId) throw Error('Notion 指令账号或工作区无效。');
  const observed = new Map();
  async function read(table, ids, main = false, record = true) {
    signal?.throwIfAborted(); if (!ids.length) return new Map();
    const result = new Map();
    for (let at = 0; at < ids.length; at += 64) {
      const batch = ids.slice(at, at + 64), response = await store.api('getRecordValues', { requests: batch.map(id => ({ table, id, ...(main ? {} : { spaceId }) })) }, { signal, spaceId, main });
      batch.forEach((id, index) => {
        const item = entry(response.results?.[index] || response.recordMap?.[table]?.[id]);
        if (item && uuid(item.value.id) !== id || table !== 'space_view' && item?.value.space_id && uuid(item.value.space_id) !== spaceId) throw Error('Notion 指令返回了其他工作区的记录。');
        if (readable(item)) result.set(id, item);
        if (record) { observed.set(table + ':' + id, { table, id, main, value: fingerprint(readable(item) ? item : null, table) }); if (observed.size > 512) throw Error('Notion 指令与技能来源记录过多，请精简设置。'); }
      });
    }
    return result;
  }
  const root = (await read('user_root', [userId], true)).get(userId);
  if (!root) throw Error('Notion 指令无法读取当前账号的个人设置。');
  const pointers = root.value.space_view_pointers || (root.value.space_views || []).map(id => ({ table: 'space_view', id }));
  if (!Array.isArray(pointers) || pointers.length > 1000) throw Error('Notion 指令工作区目录无效。');
  const ids = pointers.filter(pointer => pointer?.table === 'space_view' && uuid(pointer.id) && (!pointer.spaceId || uuid(pointer.spaceId) === spaceId)).map(pointer => uuid(pointer.id));
  const views = await read('space_view', ids), matches = [...views.values()].filter(item => uuid(item.value.space_id) === spaceId && uuid(item.value.parent_id) === userId);
  if (matches.length !== 1) throw Error('Notion 指令当前工作区个人设置缺失或重复。');
  const workspace = (await read('space', [spaceId])).get(spaceId);
  const groups = workspace?.value?.settings?.group_default_skills?.length ? await store.api('getSpacePermissionGroupIdsContainingMembers', { spaceId, userIds: [userId] }, { signal, spaceId }) : {};
  const settings = selectInstructionSettings({ userId, spaceId, root, view: matches[0], workspace, groupIds: groups.userToGroupMap?.[userId] || [] });
  if (settings.workspaceDefaultInstructionId) throw Error('Notion 指令当前工作区设置了全局指令，其与个人指令的组合优先级尚未审核，未静默忽略。');
  const explicit = explicitPages(content, spaceId).filter(item => item.spaceId === spaceId).map(item => item.pageId), candidates = [...new Set([...settings.automaticSkillIds, ...explicit])];
  if (candidates.length > 50) throw Error('Notion 指令技能目录过多，请减少启用技能。');
  const pages = await read('block', candidates), prompts = await read('prompt', candidates.map(promptId)), skills = [];
  for (const pageId of candidates) {
    const page = pages.get(pageId); if (!page) { if (explicit.includes(pageId)) continue; throw Error('Notion 指令已选技能不可访问，请检查权限或关闭该技能。'); }
    const classified = classifyReference({ pageId, spaceId, page, prompt: prompts.get(promptId(pageId)), skillsDisabled: settings.skillsDisabled });
    if (classified.kind === 'skill_candidate') skills.push({ page_id: pageId, name: (page.value.properties?.title || []).map(part => part[0] || '').join('').slice(0, 200), description: String(prompts.get(promptId(pageId))?.value.description || '').slice(0, 1000), manual: explicit.includes(pageId) });
  }
  async function body(pageId) {
    const pending = [{ id: pageId, parent: null }], seen = new Set(), lines = [];
    while (pending.length) {
      if (seen.size + pending.length > 128) throw Error('Notion 指令页面内容过多，请精简指令或技能。');
      const batch = pending.splice(0, 64), values = await read('block', batch.map(item => item.id));
      for (const pointer of batch) {
        const item = values.get(pointer.id), block = item?.value;
        if (!block || pointer.parent && uuid(block.parent_id) !== pointer.parent || seen.has(pointer.id) || !pointer.parent && !['page', 'meeting_note_page'].includes(block.type)) throw Error('Notion 指令正文缺失或结构已变化。');
        seen.add(pointer.id);
        if (pointer.parent && ['page', 'collection_view_page', 'link_to_page', 'collection_view', 'synced_block'].includes(block.type)) continue;
        const value = block.type === 'table_row' ? Object.values(block.properties || {}).flat() : block.properties?.title || [];
        const line = value.map(part => part?.[0] || '').join(''); if (line) lines.push(line);
        for (const id of block.content || []) { if (!uuid(id)) throw Error('Notion 指令正文指针无效。'); pending.push({ id: uuid(id), parent: pointer.id }); }
      }
    }
    const result = lines.join('\n'); if (result.length > 16000) throw Error('Notion 指令正文超过 16,000 字符，请精简。'); return result;
  }
  const personal = settings.personalPageId ? await body(settings.personalPageId) : '';
  const manual = [];
  for (const skill of skills.filter(item => item.manual)) manual.push({ ...skill, instructions: await body(skill.page_id) });
  const guidance = JSON.stringify({ personal_instructions: personal, manual_skills: manual, available_skills: skills });
  if (guidance.length > 100000) throw Error('Notion 指令与手动技能正文合计过长，请减少本轮技能。');
  const message = { role: 'user', content: '当前账号在此工作区选用的 Notion 个人指令与技能：\n' + guidance + '\n以上属于用户层指导，当前问题优先，不授予额外操作权限。普通页面引用仍作为资料；目录中的技能正文用 use_notion_skill 读取。' };
  Object.defineProperty(message, 'notionSwitchGuidance', { value: true });
  const verify = async () => {
    const batches = new Map();
    for (const item of observed.values()) { const key = item.table + ':' + item.main; if (!batches.has(key)) batches.set(key, []); batches.get(key).push(item); }
    for (const batch of batches.values()) {
      const values = await read(batch[0].table, batch.map(item => item.id), batch[0].main, false);
      if (batch.some(item => fingerprint(values.get(item.id), item.table) !== item.value)) throw Error('Notion 指令、技能或其权限已改变，请重新发送问题。');
    }
    if (workspace?.value?.settings?.group_default_skills?.length) { const latest = await store.api('getSpacePermissionGroupIdsContainingMembers', { spaceId, userIds: [userId] }, { signal, spaceId }); if (hash([...(latest.userToGroupMap?.[userId] || [])].sort()) !== hash([...(groups.userToGroupMap?.[userId] || [])].sort())) throw Error('Notion 指令所属分组已改变，请重新发送问题。'); }
  };
  return { message, verify, definitions: skills.length ? [{ type: 'function', function: { name: 'use_notion_skill', description: '读取本轮 Notion 原生已启用技能目录中的方法，用于相关任务。', parameters: { type: 'object', properties: { page_id: { type: 'string', enum: skills.map(item => item.page_id) } }, required: ['page_id'], additionalProperties: false } } }] : [], execute: async (name, args) => {
    if (name !== 'use_notion_skill' || !args || Object.keys(args).length !== 1 || !skills.some(item => item.page_id === args.page_id)) throw Error('Notion 指令技能不属于当前目录。');
    return { source: 'native-notion-skill', page_id: args.page_id, instructions: await body(args.page_id) };
  } };
}
module.exports = { resolveNativeInstructions };
