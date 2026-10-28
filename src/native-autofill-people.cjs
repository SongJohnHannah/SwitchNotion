const { uuid } = require('./native-context.cjs');
const fail = message => { throw Error('Notion Autofill ' + message); };
const normalized = text => text.normalize('NFKC').trim().toLowerCase();
const selfNames = new Set(['我', '本人', '当前用户', 'me', 'myself']);
async function loadPeople(store, signal) {
  if (typeof store.workspace?.listPeople !== 'function') fail('当前工作区连接不支持人员查询。');
  const users = new Map(), cursors = new Set(); let cursor;
  for (let page = 0; page < 20; page++) {
    signal?.throwIfAborted();
    const result = await store.workspace.listPeople({ spaceId: store.spaceId, startCursor: cursor, signal });
    if (uuid(result.workspace_id) !== store.spaceId || !Array.isArray(result.results) || result.results.some(value => !uuid(value.id) || typeof value.name !== 'string')) fail('人员列表不属于当前工作区或格式无效。');
    for (const user of result.results) users.set(uuid(user.id), { id: uuid(user.id), name: user.name });
    if (result.has_more === false) return { users: [...users.values()], complete: true };
    if (result.has_more !== true || typeof result.next_cursor !== 'string' || !result.next_cursor || cursors.has(result.next_cursor)) fail('人员列表分页未取得进展。');
    cursor = result.next_cursor; cursors.add(cursor);
  }
  return { users: [...users.values()], complete: false };
}
function matchedPeople(directory, query) {
  const exact = directory.users.filter(user => normalized(user.name) === normalized(query));
  return exact.length ? exact : directory.users.filter(user => normalized(user.name).includes(normalized(query)));
}
function instructionMentionText(value, allowed) {
  return (value || []).map(span => {
    const users = (Array.isArray(span?.[1]) ? span[1] : []).filter(annotation => annotation?.[0] === 'u');
    if (!users.length) return typeof span?.[0] === 'string' ? span[0] : '';
    if (users.length !== 1 || !uuid(users[0][1])) fail('指令中的人员提及格式无效，未忽略或猜测用户。');
    const id = uuid(users[0][1]); allowed?.add(id); return '@user(' + id + ')';
  }).join('');
}
function seedPeople(store, row, instructions) {
  const allowed = new Set([store.userId]);
  for (const value of Object.values(row.api?.properties || {})) if (Array.isArray(value)) for (const id of value) if (uuid(id)) allowed.add(uuid(id));
  for (const match of row.text.matchAll(/\b(?:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|[a-f\d]{32})\b/ig)) allowed.add(uuid(match[0]));
  for (const record of row.records) for (const value of Object.values(record.properties || {})) if (Array.isArray(value)) for (const span of value)
    for (const annotation of Array.isArray(span?.[1]) ? span[1] : []) if (annotation?.[0] === 'u' && uuid(annotation[1])) allowed.add(uuid(annotation[1]));
  instructionMentionText(instructions, allowed);
  row.allowedPeople = allowed; row.peopleQueries = new Map(); row.blockedPersonFields = new Set();
  const root = row.records.find(value => value.id === row.pageId);
  row.creatorId = root.created_by_table === 'notion_user' ? uuid(root.created_by_id) : null;
  row.defaultCreatorId = ['notion_user', 'bot'].includes(root.created_by_table) ? uuid(root.created_by_id) : null;
  if (row.creatorId) allowed.add(row.creatorId);
}
function peopleService(store, snapshot, row, signal) {
  const fieldIds = snapshot.fields.filter(field => field.type === 'person').map(field => field.id);
  if (!fieldIds.length) return;
  let directory, fatalError;
  return {
    definitions: [{ type: 'function', function: { name: 'find_autofill_people', description: '按姓名查找当前工作区可核对的人员。只有唯一匹配且完整检索时才返回可用 UUID；同名/歧义/不完整时保留字段，不猜测。查询“我”可取得当前登录用户。只返回姓名与 ID，不返回邮箱。',
      parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 120 }, property_id: { type: 'string', enum: fieldIds, description: '本次要填写的人员字段 ID。' } }, required: ['query', 'property_id'], additionalProperties: false } } }],
    async execute(name, args) {
      if (name !== 'find_autofill_people' || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['query', 'property_id'].includes(key)) || !fieldIds.includes(args.property_id) || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 120) fail('人员查找参数无效。');
      signal?.throwIfAborted();
      if (selfNames.has(normalized(args.query))) { row.blockedPersonFields.delete(args.property_id); return { results: [{ id: store.userId, name: '当前登录用户' }], complete: true, ambiguous: false }; }
      try {
        directory ||= await loadPeople(store, signal);
        const matches = matchedPeople(directory, args.query), unique = directory.complete && matches.length === 1;
        if (unique) { row.blockedPersonFields.delete(args.property_id); row.allowedPeople.add(matches[0].id); row.peopleQueries.set(args.query, matches[0].id); }
        else row.blockedPersonFields.add(args.property_id);
        return { results: unique ? matches : matches.slice(0, 25).map(user => ({ name: user.name })), complete: directory.complete, ambiguous: matches.length > 1,
          match_count: matches.length, ...(!unique ? { note: '没有唯一且完整核对的人员 UUID；请保留原字段，不按姓名猜测。' } : {}) };
      } catch (error) { fatalError = error; throw error; }
    },
    check() { if (fatalError) fail('工作区人员查询未完成，未生成或写回不可靠的人员结果。'); }
  };
}
function checkPersonValue(field, row, value) {
  if (!Array.isArray(value) || value.length > field.limit || value.some(id => !uuid(id)) || new Set(value.map(uuid)).size !== value.length) fail('人员字段必须为不重复的用户 UUID 数组，且遵守人数限制。');
  if (!value.length && field.default_created_by) fail('此人员字段按创建者显示默认值，不能把 API 空数组当作已清空；请保留或先调整字段默认设置。');
  if (row.blockedPersonFields?.has(field.id)) fail('该人员字段的姓名尚未唯一确认，未替换或清空原值。');
  if (value.some(id => !row.allowedPeople?.has(uuid(id)))) fail('人员 UUID 未由本行资料或唯一姓名查询确认，未猜测人员进行写入。');
}
async function verifyPeople(store, plan, signal) {
  const ids = [...new Set(plan.api.fields.filter(field => field.type === 'people').flatMap(field => plan.api.properties[field.name] || []))];
  if (!ids.length || ids.every(id => id === store.userId) && !(plan.api.peopleQueries || []).some(query => ids.includes(query.id))) return;
  const directory = await loadPeople(store, signal), known = new Set(directory.users.map(user => user.id));
  if (ids.some(id => id !== store.userId && !known.has(id))) fail('所选人员已不可在当前工作区确认，未写入。');
  for (const query of plan.api.peopleQueries || []) {
    if (!ids.includes(query.id)) continue;
    const matches = matchedPeople(directory, query.query);
    if (!directory.complete || matches.length !== 1 || matches[0].id !== query.id) fail('姓名匹配或成员列表已改变，未提交旧人员结果。');
  }
}
module.exports = { seedPeople, peopleService, checkPersonValue, verifyPeople, instructionMentionText };
