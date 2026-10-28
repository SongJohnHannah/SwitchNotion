// Pure selection logic. No page reads, model requests, persistence or runtime
// integration: real instruction content remains outside this module.
const { createHash } = require('node:crypto');
const fail = message => { throw Error('Notion 指令选择' + message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function id(value) {
  if (typeof value !== 'string' || !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value)) return null;
  const text = value.replaceAll('-', '').toLowerCase(); return [text.slice(0, 8), text.slice(8, 12), text.slice(12, 16), text.slice(16, 20), text.slice(20)].join('-');
}
function ids(values, label, limit = 250) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > limit || values.some(value => !id(value))) fail(label + '范围无效。');
  return [...new Set(values.map(id))];
}
function promptId(pageId) {
  if (!id(pageId)) fail('页面标识无效。');
  // Reviewed native 986339.yW -> 83388.gB uses MD5 bytes as a v4 UUID.
  const bytes = createHash('md5').update('prompt:' + id(pageId)).digest();
  bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
  return id(bytes.toString('hex'));
}
function explicitPages(content, spaceId) {
  spaceId = id(spaceId); if (!spaceId || !Array.isArray(content) || JSON.stringify(content).length > 500000) fail('输入或工作区无效。');
  const pages = new Map();
  for (const part of content) if (part?.type === 'text' && Array.isArray(part.text)) for (const span of part.text) {
    if (!Array.isArray(span) || typeof span[0] !== 'string' || span[1] !== undefined && !Array.isArray(span[1])) fail('引用文字格式无效。');
    for (const annotation of span[1] || []) {
      if (!Array.isArray(annotation) || annotation[0] !== 'p') continue;
      const pageId = id(annotation[1]), selectedSpace = annotation[2] === undefined ? spaceId : id(annotation[2]);
      if (!pageId || !selectedSpace) fail('页面引用标识无效。');
      pages.set(selectedSpace + ':' + pageId, { pageId, spaceId: selectedSpace }); if (pages.size > 32) fail('显式引用超过 32 个。');
    }
  }
  return [...pages.values()];
}
function defaultSkills(policy, groupIds) {
  if (!object(policy)) fail('工作区设置无效。');
  const members = new Set(ids(groupIds, '当前账号分组', 1000)), merged = new Map();
  const add = value => {
    if (!object(value) || !id(value.skill_page_id)) fail('默认技能标识无效。');
    for (const key of ['disable_automatic_use', 'use_automatically', 'show_in_editor', 'show_during_meetings', 'show_after_meetings'])
      if (value[key] !== undefined && typeof value[key] !== 'boolean') fail('默认技能开关无效。');
    const key = id(value.skill_page_id), prior = merged.get(key);
    if (!prior) { merged.set(key, { ...value, skill_page_id: key }); return; }
    const next = { skill_page_id: key };
    if (prior.disable_automatic_use !== undefined || value.disable_automatic_use !== undefined) next.disable_automatic_use = !!(prior.disable_automatic_use && value.disable_automatic_use);
    for (const flag of ['use_automatically', 'show_in_editor', 'show_during_meetings', 'show_after_meetings']) next[flag] = (prior[flag] ?? false) || (value[flag] ?? false);
    merged.set(key, next);
  };
  if (policy.workspace_default_skills !== undefined && (!Array.isArray(policy.workspace_default_skills) || policy.workspace_default_skills.length > 50)) fail('工作区默认技能范围无效。');
  (policy.workspace_default_skills || []).forEach(add);
  if (policy.group_default_skills !== undefined && (!Array.isArray(policy.group_default_skills) || policy.group_default_skills.length > 100)) fail('分组默认技能范围无效。');
  for (const group of policy.group_default_skills || []) {
    if (!object(group) || !id(group.group_id) || !Array.isArray(group.skills) || group.skills.length > 50) fail('分组默认技能格式无效。');
    if (members.has(id(group.group_id))) group.skills.forEach(add);
  }
  return [...merged.values()].slice(0, 50);
}
function automaticSkills(ai = {}, defaults = []) {
  if (!object(ai) || !Array.isArray(defaults)) fail('技能设置无效。');
  const overrides = new Set(ids(ai.overridden_workspace_default_skill_page_ids, '默认技能覆盖'));
  const installed = [...new Set([...ids(ai.installed_skill_page_ids, '已安装技能'), ...ids(ai.selected_skill_page_ids, '旧版自动技能'), ...ids(ai.rich_text_skills, '编辑技能')])];
  const current = defaults.filter(value => !overrides.has(id(value.skill_page_id))), disabled = new Set(current.filter(value => value.disable_automatic_use === true).map(value => id(value.skill_page_id)));
  const all = [...new Set([...current.map(value => id(value.skill_page_id)), ...installed])];
  if (all.length > 250 || all.some(value => !value) || ai.automatic_use_disabled_by_skill !== undefined && !object(ai.automatic_use_disabled_by_skill)) fail('自动技能范围或开关无效。');
  return all.filter(key => { const value = ai.automatic_use_disabled_by_skill?.[key]; if (value !== undefined && typeof value !== 'boolean') fail('自动技能开关无效。'); return !(value ?? disabled.has(key)); });
}
function selectInstructionSettings({ userId, spaceId, root, view, workspace, groupIds = [] }) {
  userId = id(userId); spaceId = id(spaceId);
  const editable = entry => entry && ['editor', 'owner'].includes(entry.role) && entry.value?.alive !== false;
  if (!userId || !spaceId || !editable(root) || id(root.value.id) !== userId || !editable(view) || id(view.value.space_id) !== spaceId ||
      view.value.parent_table !== 'user_root' || id(view.value.parent_id) !== userId || !id(view.value.id) ||
      !workspace || !['reader', 'commenter', 'editor', 'owner'].includes(workspace.role) || id(workspace.value?.id) !== spaceId || workspace.value.alive === false) fail('设置不属于当前账号或工作区。');
  const pointers = root.value.space_view_pointers;
  const linked = pointers === undefined ? ids(root.value.space_views, '旧版工作区目录', 1000).includes(id(view.value.id))
    : Array.isArray(pointers) && pointers.some(pointer => pointer?.table === 'space_view' && id(pointer.id) === id(view.value.id) && (pointer.spaceId === undefined || id(pointer.spaceId) === spaceId));
  if (!linked) fail('个人设置没有关联到当前账号目录。');
  const settings = view.value.settings || {}, policy = workspace.value.settings || {}, personalization = settings.agent_personalization_settings || {};
  if (!object(settings) || !object(policy) || !object(personalization) || personalization.context_page_id !== undefined && !id(personalization.context_page_id) ||
      policy.workspace_default_instructions_page_id !== undefined && !id(policy.workspace_default_instructions_page_id) ||
      policy.disable_agent_skills !== undefined && typeof policy.disable_agent_skills !== 'boolean') fail('指令页设置无效。');
  const disabled = policy.disable_agent_skills === true;
  return { userId, spaceId, spaceViewId: id(view.value.id), personalPageId: id(personalization.context_page_id),
    agentName: typeof personalization.name === 'string' ? personalization.name.slice(0, 100) : undefined,
    automaticSkillIds: disabled ? [] : automaticSkills(settings.ai_prompts || {}, defaultSkills(policy, groupIds)), skillsDisabled: disabled,
    workspaceDefaultInstructionId: id(policy.workspace_default_instructions_page_id) };
}
function classifyReference({ pageId, spaceId, page, prompt, skillsDisabled = false }) {
  pageId = id(pageId); spaceId = id(spaceId); const readable = entry => entry && ['reader', 'commenter', 'editor', 'owner'].includes(entry.role) && entry.value?.alive !== false;
  if (!pageId || !spaceId || !readable(page) || id(page.value.id) !== pageId || id(page.value.space_id) !== spaceId || !['page', 'meeting_note_page'].includes(page.value.type)) fail('引用页面不可读取或范围不匹配。');
  const skill = readable(prompt) && id(prompt.value.id) === promptId(pageId) && id(prompt.value.space_id) === spaceId &&
    prompt.value.parent_table === 'block' && id(prompt.value.parent_id) === pageId && prompt.value.prompt_type === 'skill';
  return { pageId, spaceId, kind: skill && !skillsDisabled ? 'skill_candidate' : 'page_reference', skillDisabled: !!skill && skillsDisabled };
}
module.exports = { promptId, explicitPages, defaultSkills, automaticSkills, selectInstructionSettings, classifyReference };
