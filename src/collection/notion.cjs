const fs = require('node:fs');
const path = require('node:path');
const { NotionRouter } = require('../notion-routing.cjs');
const { hash, destination, mediaKinds } = require('./model.cjs');
const { matchesBlockContent } = require('../notion-blocks.cjs');
const { canonical } = require('../notion-mutations.cjs');
const textSpans = (text, href) => {
  const result = []; const value = String(text || '');
  for (let i = 0; i < value.length; i += 2000) result.push({ type: 'text', text: { content: value.slice(i, i + 2000), ...(href && href.length <= 2000 ? { link: { url: href } } : {}) } });
  return result;
};
const paragraph = text => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: textSpans(text) } });
function textBlocks(node) {
  if (node.kind === 'divider') return [{ object: 'block', type: 'divider', divider: {} }];
  const type = node.kind === 'heading' ? 'heading_' + (node.level || 2) : node.kind === 'quote' ? 'quote' : node.kind === 'list' ? 'bulleted_list_item' : node.kind === 'code' ? 'code' : 'paragraph';
  const spans = node.spans?.length ? node.spans.flatMap(s => textSpans(s.text, s.href)) : textSpans(node.text);
  if (!spans.length) return [];
  const blocks = []; let group = [], bytes = 0;
  const flush = () => { if (group.length) blocks.push({ object: 'block', type, [type]: { rich_text: group, ...(type === 'code' ? { language: 'plain text' } : {}) } }); group = []; bytes = 0; };
  for (const span of spans) { const size = Buffer.byteLength(JSON.stringify(span)); if (group.length && (group.length >= 80 || bytes + size > 240000)) flush(); group.push(span); bytes += size; }
  flush();
  return blocks;
}
function renderDocument(document, nodes, resources, analyses = {}, warnings = []) {
  const result = [paragraph('来源：' + document.url), ...(document.author ? [paragraph('作者：' + document.author)] : [])];
  const positions = {}, slots = {};
  for (const [index, node] of nodes.entries()) {
    positions[node.id] = result.length;
    if (!mediaKinds.has(node.kind)) { result.push(...textBlocks(node)); slots[node.id] = { start: positions[node.id], count: result.length - positions[node.id] }; continue; }
    const resource = resources[node.id];
    if (resource?.error || !resource?.uploads?.length || resource.uploads.some(u => !u.uploaded)) {
      result.push(paragraph(`【${node.kind === 'image' ? '图片' : node.kind === 'video' ? '视频' : '音频'} ${index + 1} 待补全】${resource?.error || '尚未下载或上传'}${node.caption ? ' · ' + node.caption : ''}`)); slots[node.id] = { start: positions[node.id], count: 1, placeholder: true }; continue;
    }
    for (const [part, upload] of resource.uploads.entries()) result.push({ object: 'block', type: node.kind,
      [node.kind]: { type: 'file_upload', file_upload: { id: upload.id }, caption: textSpans((node.caption || '') + (resource.uploads.length > 1 ? ` · ${part + 1}/${resource.uploads.length}` : '')) } });
    slots[node.id] = { start: positions[node.id], count: result.length - positions[node.id], placeholder: false };
  }
  if (warnings.length) result.push(...textBlocks({ kind: 'heading', text: '完整性说明', level: 2 }), ...warnings.flatMap(text => textBlocks({ kind: 'paragraph', text })));
  const appendix = nodes.filter(node => analyses[node.id]?.transcript || analyses[node.id]?.vision || analyses[node.id]?.errors?.length);
  if (appendix.length) result.push({ object: 'block', type: 'divider', divider: {} }, ...textBlocks({ kind: 'heading', text: '逐字稿与识别结果', level: 1 }));
  for (const node of appendix) {
    const item = analyses[node.id]; result.push(...textBlocks({ kind: 'heading', text: `素材 ${nodes.indexOf(node) + 1}${node.caption ? ' · ' + node.caption : ''}`, level: 2 }));
    for (const [key, title] of [['transcript', '语音逐字稿'], ['vision', 'DeepSeek 图片与画面分析']]) if (item[key]) {
      result.push(...textBlocks({ kind: 'heading', text: title, level: 3 }), ...textBlocks({ kind: 'paragraph', text: item[key].text || item[key].note || '没有识别结果。' }));
      if (item[key].text && item[key].note) result.push(paragraph(item[key].note));
    }
    for (const error of item.errors || []) result.push(paragraph('识别待完成：' + error));
  }
  return { blocks: result, positions, slots };
}
function batches(blocks) {
  const result = []; let current = [], size = 0;
  for (const block of blocks) { const bytes = Buffer.byteLength(JSON.stringify(block));
    if (current.length && (current.length >= 80 || size + bytes > 350000)) { result.push(current); current = []; size = 0; }
    current.push(block); size += bytes;
  }
  if (current.length) result.push(current); return result;
}
const mimeFor = file => ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aac': 'audio/aac', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.flac': 'audio/flac' }[path.extname(file).toLowerCase()] || 'application/octet-stream');
class CollectionNotion {
  constructor({ root, router = new NotionRouter({ root }), fetchImpl = fetch } = {}) { Object.assign(this, { root, router, fetchImpl }); }
  async workspaces(signal) { const { workspaces, unavailable } = await this.router.prepare(signal); return { workspaces: workspaces.map(w => ({ id: w.id, name: w.name, readOnly: w.cfg.readOnly })), unavailable }; }
  async connect(target, signal, scope = 'collection-search') {
    const picked = destination(target), { workspaces } = await this.router.prepare(signal), workspace = workspaces.find(w => w.id === picked.workspaceId);
    if (!workspace || workspace.cfg.readOnly) throw Error('目标工作区未连接或连接为只读，请在 Switch Notion 配置中检查。');
    return { ...workspace, session: workspace.client.open({ operationScope: scope, signal, config: workspace.cfg }), target: picked, signal };
  }
  async search(workspaceId, query = '', cursors = {}, signal) {
    if (typeof query !== 'string' || query.length > 200) throw Error('搜索词过长。');
    const { workspaces } = await this.router.prepare(signal), w = workspaces.find(w => w.id === workspaceId);
    if (!w) throw Error('请先选择已连接的 Notion 工作区。');
    const session = w.client.open({ operationScope: 'collection-destination-search', signal, config: w.cfg });
    if (/^https?:\/\/(?:(?:www|app)\.)?notion\.(?:so|com|site)\//i.test(query) || /^[a-f\d-]{32,36}$/i.test(query)) {
      const { pageId } = require('../notion-tools.cjs'); const id = pageId(query);
      try { const page = await session.execute('read_page_info', { page_id: id });
        return { results: [{ workspaceId: w.id, workspaceName: w.name, kind: 'page', id, label: page.title || '未命名' }], cursors: {}, hasMore: false };
      } catch (error) { if (error.status !== 404 && error.status !== 400) throw error; }
      const db = await session.execute('read_database', { database_id: id });
      return { results: (db.data_sources || []).map(source => ({ workspaceId: w.id, workspaceName: w.name, kind: 'database', id,
        dataSourceId: source.data_source_id, label: source.title || db.title || '未命名' })), cursors: {}, hasMore: false };
    }
    const results = [], next = {};
    for (const kind of ['page', 'database']) {
      if (cursors[kind] === null) continue;
      const response = await session.execute(kind === 'page' ? 'search_pages' : 'search_databases', { query, ...(kind === 'page' ? { scope: 'title' } : {}), ...(cursors[kind] ? { start_cursor: cursors[kind] } : {}) });
      results.push(...response.results.map(item => ({ workspaceId: w.id, workspaceName: w.name, kind,
        id: kind === 'page' ? item.page_id : item.database_id || item.data_source_id, label: item.title || '未命名', ...(kind === 'database' ? { dataSourceId: item.data_source_id } : {}) })));
      next[kind] = response.has_more ? response.next_cursor : null;
    }
    return { results, cursors: next, hasMore: Object.values(next).some(Boolean) };
  }
  async verifyTarget(target, signal) {
    const c = await this.connect(target, signal);
    if (target.kind === 'page') await c.session.execute('read_page_info', { page_id: target.id });
    else { const schema = await c.session.execute('read_database', target.dataSourceId ? { data_source_id: target.dataSourceId } : { database_id: target.id });
      if (!target.dataSourceId && schema.data_source_ids?.length !== 1) throw Error('此数据库包含多个数据源，请通过搜索结果选择具体的数据源。'); }
    const me = await c.client.request(c.cfg, 'GET', 'users/me', null, signal);
    const limit = me.bot?.workspace_limits?.max_file_upload_size_in_bytes;
    return { limit: Number.isSafeInteger(limit) && limit > 0 ? limit : 5 * 1024 ** 2 };
  }
  async createLibrary(workspaceId, parentId, signal) {
    const c = await this.connect({ workspaceId, id: parentId, kind: 'page', label: '资料收集父页面' }, signal, 'collection-library:' + workspaceId + ':' + parentId);
    await c.session.execute('read_page_info', { page_id: parentId });
    const columns = [{ name: '标题', type: 'title' }, { name: '来源链接', type: 'url' },
      { name: '内容类型', type: 'multi_select', options: ['视频', '音频', '图片', '文章'] }, { name: '来源网站', type: 'rich_text' },
      { name: '收集时间', type: 'date' }, { name: '处理状态', type: 'select', options: ['已保存', '待补全'] }, { name: '标签', type: 'multi_select', options: [] }];
    let cursor;
    do {
      const found = await c.session.execute('search_databases', { query: '资料收集', ...(cursor ? { start_cursor: cursor } : {}) });
      for (const item of found.results.filter(item => item.title === '资料收集' && item.database_id)) {
        const database = await c.client.request(c.cfg, 'GET', 'databases/' + item.database_id, null, signal);
        if (database.parent?.page_id === parentId) return { workspaceId, workspaceName: c.name, kind: 'database', id: item.database_id, dataSourceId: item.data_source_id, label: '资料收集', url: item.url, existing: true };
      }
      cursor = found.has_more ? found.next_cursor : null;
    } while (cursor);
    const created = await c.session.execute('create_database', { parent_page_id: parentId, title: '资料收集', columns, is_inline: false });
    if (!created.verified || !created.data_source_id) throw Error('资料收集数据库创建结果尚未核验，请检查页面后继续。');
    return { workspaceId, workspaceName: c.name, kind: 'database', id: created.database_id, dataSourceId: created.data_source_id, label: '资料收集', url: created.url };
  }
  async createPage(job, save, signal) {
    const c = await this.connect(job.options.destination, signal, 'collection:' + job.id);
    if (job.page) { await c.session.execute('read_page_info', { page_id: job.page.id }); return job.page; }
    const recovered = await this.recoverCreatedPage(c, job, save);
    if (recovered) return recovered;
    let result;
    if (c.target.kind === 'page') result = await c.session.execute('create_page', { parent_page_id: c.target.id, title: job.document.title });
    else {
      let schema = await c.session.execute('read_database', c.target.dataSourceId ? { data_source_id: c.target.dataSourceId } : { database_id: c.target.id });
      if (schema.data_sources) schema = schema.data_sources[0];
      const fields = schema.properties;
      const title = Array.isArray(fields) ? fields.find(p => p.type === 'title')?.name : Object.entries(fields || {}).find(([, p]) => p.type === 'title')?.[0];
      if (!title) throw Error('数据库未返回可写的标题字段。');
      const properties = { [title]: job.document.title };
      const set = (name, type, value) => { if (fields[name]?.type === type) properties[name] = value; };
      set('来源链接', 'url', job.document.url.length <= 2000 ? job.document.url : null);
      set('来源网站', 'rich_text', new URL(job.document.url).hostname);
      set('收集时间', 'date', { start: new Date(Math.floor(Date.parse(job.createdAt || new Date().toISOString()) / 60000) * 60000).toISOString() });
      const types = [...new Set(nodesFor(job).map(node => ({ image: '图片', video: '视频', audio: '音频' }[node.kind] || '文章')))];
      if (fields['内容类型']?.type === 'multi_select' && types.every(t => fields['内容类型'].multi_select?.options?.some(o => o.name === t))) properties['内容类型'] = types;
      const state = job.document.incomplete || Object.values(job.resources).some(r => r.error) || Object.values(job.analyses).some(a => a.errors?.length) ? '待补全' : '已保存';
      if (fields['处理状态']?.type === 'select' && fields['处理状态'].select?.options?.some(o => o.name === state)) { properties['处理状态'] = state; job.managedStatus = state; }
      result = await c.session.execute('create_database_entry', { data_source_id: schema.data_source_id || c.target.dataSourceId, properties });
    }
    if (!result.verified) throw Error('Notion 页面创建结果尚未核验，已停止后续写入。');
    job.page = { id: result.page_id, url: result.url }; save(); return job.page;
  }
  async recoverCreatedPage(c, job, save) {
    if (!this.root) return null;
    const directory = path.join(this.root, 'write-journal');
    if (!fs.existsSync(directory)) return null;
    const records = fs.readdirSync(directory).filter(name => /^content-[a-f\d]{64}\.json$/.test(name)).map(name => {
      try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); } catch { return null; }
    }).filter(record => record?.workspace_id === c.target.workspaceId && record.operation_scope === 'collection:' + job.id && ['create_page', 'create_database_entry'].includes(record.name));
    if (!records.length) return null;
    if (records.length !== 1) throw Error('此任务存在多个页面创建记录，需要先检查已有页面，未再次创建。');
    const record = records[0], id = record.response?.id || record.result?.page_id;
    if (!id) throw Error('此前页面创建结果未确定，未重复创建，请检查本地写入记录与目标数据库。');
    const page = await c.client.request(c.cfg, 'GET', 'pages/' + id, null, c.signal), expected = record.request?.body;
    const plain = spans => (spans || []).map(span => span.plain_text ?? span.text?.content ?? '').join('');
    const comparable = (property, name) => {
      const type = property.type || Object.keys(property).find(key => !['id', 'name'].includes(key)), value = property[type];
      if (['title', 'rich_text'].includes(type)) return plain(value);
      if (['select', 'status'].includes(type)) return value?.name ?? null;
      if (type === 'multi_select') return (value || []).map(option => option.name).sort();
      if (type === 'date' && value) {
        const instant = text => text && /(?:Z|[+-]\d{2}:\d{2})$/.test(text) && Number.isFinite(Date.parse(text)) ? (name === '收集时间' ? Math.floor(Date.parse(text) / 60000) : Date.parse(text)) : text;
        return { start: instant(value.start), end: instant(value.end) || null, time_zone: value.time_zone || null };
      }
      return value ?? null;
    };
    const parent = expected?.parent, parentId = parent?.page_id || parent?.data_source_id;
    const parentMatches = parentId && (page.parent?.page_id === parentId || page.parent?.data_source_id === parentId);
    const fieldsMatch = expected?.properties && Object.entries(expected.properties).every(([name, property]) => page.properties?.[name] && JSON.stringify(comparable(page.properties[name], name)) === JSON.stringify(comparable(property, name)));
    if (!parentMatches || !fieldsMatch || page.archived || page.in_trash) throw Error('已创建页面的读回内容与本次任务不一致，未重复创建或覆盖。');
    job.page = { id, url: page.url || 'https://www.notion.so/' + id.replaceAll('-', '') }; job.creationRecovered = true; save(); return job.page;
  }
  async upload(file, job, state, save, signal) {
    const c = await this.connect(job.options.destination, signal, 'collection:' + job.id);
    const request = async (method, endpoint, body) => {
      const form = body instanceof FormData;
      const response = await this.fetchImpl('https://api.notion.com/v1/' + endpoint, { method, signal, redirect: 'error',
        headers: { authorization: 'Bearer ' + c.cfg.key, 'Notion-Version': '2026-03-11', ...(!form && body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: form ? body : JSON.stringify(body) } : {}) });
      if (!response.ok) { await response.body?.cancel(); throw Error(`Notion 附件上传返回 HTTP ${response.status}，本地文件已保留。`); }
      return response.json();
    };
    if (state.id) {
      const current = await request('GET', 'file_uploads/' + state.id);
      if (current.status === 'uploaded') { state.uploaded = true; save(); return state; }
      if (current.status === 'expired' || current.status === 'failed') { delete state.id; delete state.parts; }
    }
    const bytes = fs.statSync(file.path).size, partSize = 10 * 1024 ** 2, multipart = bytes > 20 * 1024 ** 2;
    if (!state.id) {
      const created = await request('POST', 'file_uploads', { mode: multipart ? 'multi_part' : 'single_part', filename: path.basename(file.path), content_type: mimeFor(file.path), ...(multipart ? { number_of_parts: Math.ceil(bytes / partSize) } : {}) });
      state.id = created.id; state.parts = []; state.uploaded = false; save();
    }
    const handle = fs.openSync(file.path, 'r');
    try {
      for (let offset = 0, part = 1; offset < bytes; offset += multipart ? partSize : bytes, part++) {
        if (state.parts?.includes(part)) continue;
        signal?.throwIfAborted(); const buffer = Buffer.alloc(Math.min(multipart ? partSize : bytes, bytes - offset)); fs.readSync(handle, buffer, 0, buffer.length, offset);
        const form = new FormData(); form.set('file', new Blob([buffer], { type: mimeFor(file.path) }), path.basename(file.path));
        if (multipart) form.set('part_number', String(part));
        await request('POST', 'file_uploads/' + state.id + '/send', form);
        state.parts ||= []; state.parts.push(part); save();
      }
      if (multipart) await request('POST', 'file_uploads/' + state.id + '/complete', {});
    } finally { fs.closeSync(handle); }
    const checked = await request('GET', 'file_uploads/' + state.id);
    if (checked.status !== 'uploaded') throw Error('Notion 附件尚未完成上传，请稍后重试。');
    state.uploaded = true; save(); return state;
  }
  async write(job, nodes, save, signal) {
    await this.createPage(job, save, signal);
    const plan = renderDocument(job.document, nodes, job.resources, job.analyses, job.warnings);
    const fingerprint = hash(JSON.stringify(plan.blocks));
    if (job.writeFingerprint && job.writeFingerprint !== fingerprint && job.sourceSlots) return this.repair(job, nodes, plan, save, signal);
    job.writeGroups ||= batches(plan.blocks); const groups = job.writeGroups;
    job.writeFingerprint ||= fingerprint;
    if (hash(JSON.stringify(groups.flat())) !== job.writeFingerprint) throw Error('本地写入计划与正文不一致，未继续追加。');
    if (!job.writeSlots) {
      const sourceEnd = Math.max(0, ...Object.values(plan.slots).map(slot => slot.start + slot.count));
      if (job.writeFingerprint !== fingerprint && hash(JSON.stringify(groups.flat().slice(0, sourceEnd))) !== hash(JSON.stringify(plan.blocks.slice(0, sourceEnd)))) throw Error('上次正文尚未核验且素材发生变化，未自动重排。');
      job.writeSlots = structuredClone(plan.slots);
    }
    job.writeAnalyses ||= job.writeFingerprint === fingerprint ? structuredClone(job.analyses) : {}; job.written ||= []; save();
    for (let i = 0; i < groups.length; i++) {
      if (job.written[i]) continue;
      job.message = `正在保存并核验正文：第 ${i + 1} / ${groups.length} 批`; save();
      const c = await this.connect(job.options.destination, signal, 'collection:' + job.id + ':batch:' + i);
      const recovered = await this.recoverBatch(c, job, i, groups[i]);
      if (recovered) { job.written[i] = recovered; save(); continue; }
      const response = await c.session.execute('append_blocks', { block_id: job.page.id, blocks: groups[i] });
      if (!response.verified) throw Error('Notion 内容写入尚未核验，已停止自动追加。');
      job.written[i] = response.created_block_ids; save();
    }
    // Verify the remote order, including every uploaded media block.
    const c = await this.connect(job.options.destination, signal, 'collection:' + job.id);
    const actual = []; let cursor;
    do { const response = await c.session.execute('read_block_children', { block_id: job.page.id, ...(cursor ? { start_cursor: cursor } : {}) }); actual.push(...response.results.map(b => b.id)); cursor = response.next_cursor; } while (cursor);
    const expected = job.written.flat();
    let last = -1; for (const id of expected) { const index = actual.indexOf(id); if (index <= last) throw Error('Notion 内容顺序核验失败，已保留页面供检查。'); last = index; }
    const original = groups.flat();
    job.sourceSlots ||= Object.fromEntries(Object.entries(job.writeSlots).map(([id, slot]) => [id, { ...slot, ids: expected.slice(slot.start, slot.start + slot.count), original: original.slice(slot.start, slot.start + slot.count) }]));
    job.savedAnalysis ||= hash(JSON.stringify(job.writeAnalyses));
    job.savedAnalysisItems ||= Object.fromEntries(Object.entries(job.writeAnalyses).flatMap(([id, item]) => ['transcript', 'vision'].filter(key => item[key]).map(key => [id + ':' + key, hash(JSON.stringify(item[key]))])));
    save();
    if (job.writeFingerprint !== fingerprint) return this.repair(job, nodes, plan, save, signal);
    return job.page;
  }
  async recoverBatch(c, job, index, blocks) {
    if (!this.root) return null;
    const directory = path.join(this.root, 'write-journal'); if (!fs.existsSync(directory)) return null;
    const records = fs.readdirSync(directory).filter(name => /^content-[a-f\d]{64}\.json$/.test(name)).map(name => { try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); } catch { return null; } })
      .filter(record => record?.workspace_id === job.options.destination.workspaceId && record.operation_scope === 'collection:' + job.id + ':batch:' + index && record.name === 'append_blocks');
    if (!records.length) return null;
    if (records.length !== 1 || JSON.stringify(canonical(records[0].request?.body?.children)) !== JSON.stringify(canonical(blocks))) throw Error('此前正文写入计划存在差异，未重复追加。');
    const submitted = records[0].response?.results;
    if (!Array.isArray(submitted) || submitted.length !== blocks.length || new Set(submitted.map(block => block.id)).size !== blocks.length) throw Error('此前正文写入结果不确定，未重复追加，请检查已有页面。');
    const actual = []; let cursor;
    do { const response = await c.session.execute('read_block_children', { block_id: job.page.id, ...(cursor ? { start_cursor: cursor } : {}) }); actual.push(...response.results); cursor = response.next_cursor; } while (cursor);
    let position = -1;
    for (let i = 0; i < submitted.length; i++) {
      const at = actual.findIndex(block => block.id === submitted[i].id), current = actual[at];
      if (at <= position || ![current?.parent?.block_id, current?.parent?.page_id].includes(job.page.id) || !matchesBlockContent(current, blocks[i], submitted[i])) throw Error('此前已写正文与读回内容或顺序不一致，未重复追加。');
      position = at;
    }
    job.recoveredBatches ||= []; if (!job.recoveredBatches.includes(index)) job.recoveredBatches.push(index);
    return submitted.map(block => block.id);
  }
  async repair(job, nodes, plan, save, signal) {
    if (!job.sourceSlots) throw Error('上次写入尚未完成核验，不能自动重排内容，请检查已有页面。');
    const c = await this.connect(job.options.destination, signal, 'collection:' + job.id);
    const plain = block => (block?.[block.type]?.rich_text || []).map(t => t.plain_text ?? t.text?.content ?? '').join('');
    for (const node of nodes) {
      const old = job.sourceSlots[node.id], next = plan.slots[node.id];
      const changedMedia = old && !old.placeholder && mediaKinds.has(node.kind) && next && !next.placeholder && hash(JSON.stringify(old.original)) !== hash(JSON.stringify(plan.blocks.slice(next.start, next.start + next.count)));
      if ((!old?.placeholder && !changedMedia) || !next || next.placeholder) continue;
      if (changedMedia && old.ids.length !== 1) throw Error('已有分段媒体需要人工确认后替换，未覆盖原内容。');
      const originalId = old.ids[0], current = await c.session.execute('read_block', { block_id: originalId });
      const alreadyRemoved = current.block.in_trash || current.block.archived;
      let echo = old.echo;
      if (changedMedia && !echo && this.root) {
        const directory = path.join(this.root, 'write-journal');
        if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory).filter(name => /^content-[a-f\d]{64}\.json$/.test(name))) {
          try { const record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); if (record.workspace_id === job.options.destination.workspaceId && record.operation_scope?.startsWith('collection:' + job.id)) { echo = record.response?.results?.find(block => block.id === originalId); if (echo) break; } } catch {}
        }
      }
      const unchanged = block => changedMedia ? matchesBlockContent(block, old.original[0], echo) : plain(block) === plain(old.original[0]);
      if (!alreadyRemoved && !unchanged(current.block)) throw Error('待补全位置已被手动修改，已保留修改，未自动替换。');
      if (changedMedia && old.replacement?.ids && old.ids[0] === old.replacement.ids[0]) delete old.replacement;
      old.replacement ||= {};
      if (!old.replacement.ids) {
        if (alreadyRemoved) throw Error('待补全位置已移除，未在其他位置重复插入。');
        const blocks = plan.blocks.slice(next.start, next.start + next.count);
        const response = await c.session.execute('append_blocks', { block_id: job.page.id, blocks, after: originalId });
        if (!response.verified) throw Error('补全素材的插入结果尚未核验。');
        old.replacement.ids = response.created_block_ids; old.replacement.echo = response.results?.[0]; save();
      }
      if (!alreadyRemoved) {
        const latest = await c.session.execute('read_block', { block_id: originalId });
        if (!unchanged(latest.block)) throw Error('待补全占位内容发生变化，请检查后继续。');
        const response = await c.session.execute('trash_block', { block_id: originalId, block_revision: latest.block_revision });
        if (!response.verified) throw Error('补全素材已插入，占位内容移除尚未核验。');
      }
      old.ids = old.replacement.ids; old.echo = old.replacement.echo; old.placeholder = false; old.original = plan.blocks.slice(next.start, next.start + next.count); save();
    }
    const analysisFingerprint = hash(JSON.stringify(job.analyses));
    if (job.savedAnalysis !== analysisFingerprint) {
      const audioNodes = nodes.filter(node => ['video', 'audio'].includes(node.kind));
      if (!job.correctedAudioNote && audioNodes.length === 1 && job.writeAnalyses?.[audioNodes[0].id]?.transcript?.note === '此媒体没有音轨。' && job.analyses[audioNodes[0].id]?.transcript?.text) {
        const index = job.writeGroups?.flat().findIndex(block => plain(block) === '此媒体没有音轨。');
        const id = index >= 0 ? job.written?.flat()[index] : null;
        if (id) {
          const current = await c.session.execute('read_block', { block_id: id });
          if (plain(current.block) === '此媒体没有音轨。') {
            const response = await c.session.execute('update_block', { block_id: id, block_revision: current.block_revision, block: paragraph('音轨已补齐，完整逐字稿见下方补全结果。') });
            if (!response.verified) throw Error('音轨说明更新尚未核验。');
          }
        }
        job.correctedAudioNote = true; save();
      }
      const supplementary = [paragraph('补全的逐字稿与识别结果（此前未完成项以本次记录为准）')];
      for (const node of nodes) { const item = job.analyses[node.id]; if (!item) continue;
        for (const [key, title] of [['transcript', '逐字稿'], ['vision', 'DeepSeek 识别']]) if ((item[key]?.text || item[key]?.note) && job.savedAnalysisItems?.[node.id + ':' + key] !== hash(JSON.stringify(item[key]))) supplementary.push(...textBlocks({ kind: 'heading', level: 3, text: `素材 ${nodes.indexOf(node) + 1} · ${title}` }), ...textBlocks({ kind: 'paragraph', text: item[key].text || item[key].note }));
      }
      job.analysisBatches ||= {};
      const groups = batches(supplementary), done = job.analysisBatches[analysisFingerprint] ||= [];
      for (let i = 0; i < groups.length; i++) if (!done[i]) { const response = await c.session.execute('append_blocks', { block_id: job.page.id, blocks: groups[i] });
        if (!response.verified) throw Error('补全的识别结果尚未核验。'); done[i] = response.created_block_ids; save(); }
      job.savedAnalysis = analysisFingerprint;
      job.savedAnalysisItems = Object.fromEntries(Object.entries(job.analyses).flatMap(([id, item]) => ['transcript', 'vision'].filter(key => item[key]).map(key => [id + ':' + key, hash(JSON.stringify(item[key]))]))); save();
    }
    const ids = []; let cursor;
    do { const response = await c.session.execute('read_block_children', { block_id: job.page.id, ...(cursor ? { start_cursor: cursor } : {}) }); ids.push(...response.results.filter(b => !b.in_trash && !b.archived).map(b => b.id)); cursor = response.next_cursor; } while (cursor);
    let position = -1;
    for (const node of nodes) for (const id of job.sourceSlots[node.id]?.ids || []) { const next = ids.indexOf(id); if (next <= position) throw Error('补全后的原文顺序尚未核验，请检查页面。'); position = next; }
    if (job.managedStatus === '待补全' && !job.document.incomplete && !Object.values(job.resources).some(r => r.error) && !Object.values(job.analyses).some(a => a.errors?.length)) {
      const entry = await c.session.execute('read_database_entry', { page_id: job.page.id });
      if (entry.properties?.['处理状态'] === '待补全') {
        const response = await c.session.execute('update_database_entry', { page_id: job.page.id, property_revision: entry.property_revision, properties: { '处理状态': '已保存' } });
        if (!response.verified) throw Error('内容已补全，数据库状态更新尚未核验。');
      }
      job.managedStatus = '已保存'; save();
    }
    return job.page;
  }
}
function nodesFor(job) { const { selectedNodes } = require('./model.cjs'); return selectedNodes(job.document, job.options, job.selectedIds); }
module.exports = { CollectionNotion, textSpans, textBlocks, renderDocument, batches, mimeFor };
