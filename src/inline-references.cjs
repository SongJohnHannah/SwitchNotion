const { randomUUID } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const { propertyFiles, propertyKey, readFileProperty } = require('./file-properties.cjs');
const fail = message => { throw Error('Notion 引用' + message); };
function referencePointers(values = [], workspaceId, { limit = 32 } = {}) {
  if (!Array.isArray(values) || values.length > limit) fail(`列表无效或超过 ${limit} 项，请缩小范围。`);
  const unique = new Map();
  for (const value of values) {
    if (!value || value.table !== 'block' || !uuid(value.id) ||
        value.spaceId !== undefined && !uuid(value.spaceId)) fail('类型或标识不受支持；文件正文请使用支持该格式的入口。');
    const spaceId = uuid(value.spaceId) || uuid(workspaceId);
    if (!spaceId) fail('缺少所属工作区，请重新选择来源。');
    const pointer = { table: 'block', id: uuid(value.id), spaceId };
    unique.set(spaceId + ':' + pointer.id, pointer);
  }
  return [...unique.values()];
}
const plain = spans => (spans || []).map(span => span.plain_text ?? span.text?.content ?? span.equation?.expression ?? '').join('');
const blockText = block => {
  const data = block[block.type] || {};
  if (block.type === 'table_row') return (data.cells || []).map(plain).join(' | ');
  return plain(data.rich_text || data.caption) || data.expression || data.title || '';
};
const parentId = block => uuid(block.parent?.block_id || block.parent?.page_id);
const graphemes = text => [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)].map(part => part.segment);
const normalizePreview = text => text.normalize('NFC').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();

// All I/O goes through the existing scoped Router. This module has no paths,
// Electron dependencies, model tools, writes, or operating-system branches.
function createInlineReferenceReader({ workspace, resolveFile, maxFiles = 8, maxFileBytes = 24 * 1024 * 1024, maxCalls = 128, maxBlocks = 800, maxCharacters = 160000, timeoutMs = resolveFile ? 300000 : 30000 } = {}) {
  return async ({ pointers = [], selection, pageId, spaceId, signal }) => {
    pointers = referencePointers(pointers, spaceId);
    if (!workspace?.open || !uuid(spaceId)) fail('读取连接尚未配置，请先添加该工作区的连接。');
    const deadline = AbortSignal.timeout(timeoutMs), active = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let calls = 0, blocks = 0, fileBytes = 0;
    const files = new Map(), fileProofs = new Map(), pageProofs = new Map(), fileTypes = new Set(['image', 'pdf', 'file', 'audio', 'video']);
    let session;
    const readError = error => {
      if (signal?.aborted) throw error;
      if (deadline.aborted) fail('读取超时，请减少引用或稍后重试。');
      if (/^Notion /.test(error.message || '')) throw error;
      fail('读取失败，请确认来源所属工作区的连接和访问权限。');
    };
    try { session = await workspace.open({ operationScope: 'inline-reference-' + randomUUID(), signal: active,
      nativeContext: { workspace_id: uuid(spaceId), page_id: uuid(pageId) } }); }
    catch (error) { readError(error); }
    const execute = async (name, args, scope = uuid(spaceId)) => {
      active.throwIfAborted();
      if (++calls > maxCalls) fail('读取范围过大，请减少引用或缩小选区。');
      const value = await session.execute(name, { ...args, workspace_id: scope });
      active.throwIfAborted(); return value;
    };
    const checkSize = value => { if (JSON.stringify(value).length > maxCharacters) fail('内容过长，请缩小范围；未将截断内容交给模型。'); return value; };
    const cache = new Map();
    const remember = (block, scope) => {
      if (!block || !uuid(block.id) || typeof block.type !== 'string') fail('返回的块结构无效。');
      const key = scope + ':' + uuid(block.id);
      if (!cache.has(key) && ++blocks > maxBlocks) fail('包含过多内容块，请缩小选区。');
      cache.set(key, block); checkSize(block); return block;
    };
    const readBlock = async (id, scope) => {
      const key = scope + ':' + id;
      return cache.get(key) || remember((await execute('read_block', { block_id: id }, scope)).block, scope);
    };
    const fileBody = async (block, scope, strict = false, property) => {
      if (!resolveFile) return null;
      const key = scope + ':' + JSON.stringify(property ? [uuid(block.id), propertyKey(property.propertyId), property.fileIndex] : [uuid(block.id)]);
      if (files.has(key)) {
        const value = files.get(key); if (strict && !value.body_available) fail('所选附件格式尚未支持，未忽略附件继续生成。'); return value;
      }
      if (files.size >= maxFiles || fileBytes >= maxFileBytes) fail('本轮页面附件超过 8 个或 24 MiB，请只引用必要附件。');
      let value;
      try {
        value = await resolveFile({ ...(property ? { pageId: uuid(block.id), ...property } : { blockId: uuid(block.id) }), spaceId: scope, signal: active,
          session: { execute: (name, args) => execute(name, args, scope) }, maxBytes: Math.min(16 * 1024 * 1024, maxFileBytes - fileBytes) });
        active.throwIfAborted();
        const revision = property ? value?.file_revision : value?.block_revision;
        if (!value?.document || value.body_available !== true || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || typeof revision !== 'string' || !revision || value.workspace_id !== scope ||
            (property ? uuid(value.page_id) !== uuid(block.id) || propertyKey(value.property_id) !== propertyKey(property.propertyId) || value.file_index !== property.fileIndex : uuid(value.block_id) !== uuid(block.id))) fail('页面附件没有取得可核对的正文。');
        fileBytes += value.bytes; if (fileBytes > maxFileBytes) fail('本轮页面附件超过 24 MiB，请缩小引用范围。');
        fileProofs.set(key, { ...(property ? { pageId: uuid(block.id), ...property } : { blockId: uuid(block.id) }), scope, revision });
        value = { ...(property ? { page_id: uuid(block.id), property_id: value.property_id, file_index: value.file_index } : { block_id: uuid(block.id) }), type: block.type, document: value.document, body_available: true, read_only: true };
      } catch (error) {
        if (error.code !== 'NOTION_FILE_UNSUPPORTED' || strict) throw error;
        value = { ...(property ? { page_id: uuid(block.id), property_id: property.propertyId, file_index: property.fileIndex } : { block_id: uuid(block.id) }), type: block.type, body_available: false, note: '附件格式尚未支持，未读取其二进制正文。' };
      }
      checkSize(value); files.set(key, value); return value;
    };
    async function* children(id, scope) {
      let cursor; const cursors = new Set(), seen = new Set();
      do {
        const result = await execute('read_block_children', { block_id: id, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, scope);
        if (!Array.isArray(result.results)) fail('子块列表无效。');
        for (const raw of result.results) {
          const block = remember(raw, scope), child = uuid(block.id);
          if (seen.has(child) || parentId(block) && parentId(block) !== id) fail('子块顺序或归属发生变化，请刷新后重新选择。');
          seen.add(child); yield block;
        }
        if (!result.has_more) break;
        if (!result.next_cursor || cursors.has(result.next_cursor)) fail('子块分页不完整，未使用部分内容生成。');
        cursor = result.next_cursor; cursors.add(cursor);
      } while (true);
    }
    const notFound = error => error?.status === 404;
    async function readPage(id, scope, metadata) {
      metadata ||= await execute('read_page_info', { page_id: id }, scope);
      if (metadata.in_trash) fail('页面已在回收站中，请重新选择。');
      const chunks = []; let offset = 0, revision;
      do {
        const part = await execute('read_page', { page_id: id, offset }, scope);
        if (typeof part.markdown !== 'string' || part.incomplete) fail('页面正文尚未完整加载，请缩小范围或重试。');
        if (revision && part.revision && revision !== part.revision) fail('页面在分页读取期间发生变化，请重试。');
        revision ||= part.revision;
        chunks.push(part.markdown); checkSize(chunks);
        if (part.next_offset == null) break;
        if (!Number.isSafeInteger(part.next_offset) || part.next_offset !== offset + part.markdown.length || part.next_offset <= offset) fail('页面正文分页无效。');
        offset = part.next_offset;
      } while (true);
      const value = { kind: 'page', page_id: id, title: metadata.title, text: chunks.join(''), complete: true };
      if (metadata.parent?.database_id || metadata.parent?.data_source_id) value.entry = await completeEntry(await execute('read_database_entry', { page_id: id }, scope), scope);
      if (resolveFile) {
        const attachments = [], visited = new Set([id]);
        const visit = async parent => {
          for await (const block of children(parent, scope)) {
            const child = uuid(block.id); if (visited.has(child)) fail('页面附件遍历出现重复或循环。'); visited.add(child);
            if (fileTypes.has(block.type)) attachments.push(await fileBody(block, scope));
            // A page reference does not implicitly select linked pages,
            // databases, or a synced block's external source.
            if (block.has_children && !['child_page', 'child_database', 'link_to_page', 'synced_block'].includes(block.type)) await visit(child);
            checkSize(attachments);
          }
        };
        await visit(id);
        for (const [name, type] of Object.entries(value.entry?.property_types || {})) if (type === 'files') {
          const property = propertyFiles(value.entry, value.entry.property_ids[name]);
          for (let index = 0; index < property.files.length; index++) attachments.push(await fileBody({ id, type: 'file' }, scope, false, { propertyId: property.id, fileIndex: index }));
          value.entry.properties[name] = property.files.map(file => ({ name: file.name, type: file.type, body_available: false, note: '正文见 attachments 对应字段及序号。' }));
        }
        if (!revision) fail('页面附件列表缺少可核对的版本。');
        pageProofs.set(scope + ':' + id, { pageId: id, scope, revision });
        value.attachments = attachments;
        value.attachment_scope = '读取本页附件块与本记录文件属性；不展开子页面、其他数据库记录、同步来源或链接。未支持格式标记为 body_available=false。';
      }
      return value;
    }
    async function completeEntry(entry, scope) {
      const value = structuredClone(entry);
      for (const name of entry.incomplete_properties || []) {
        const id = entry.property_ids?.[name]; if (!id) fail('记录字段缺少完整读取标识。');
        const items = []; let cursor; const cursors = new Set();
        do {
          const result = await execute('read_database_entry_property', { page_id: entry.page_id, property_id: id, page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}) }, scope);
          if (Array.isArray(result.items)) items.push(...result.items);
          else if (!result.has_more) items.push(...(entry.property_types?.[name] === 'files' && Array.isArray(result.value) ? result.value : [result.value]));
          else fail('记录字段分页内容无效。');
          checkSize(items);
          if (!result.has_more) break;
          if (!result.next_cursor || cursors.has(result.next_cursor)) fail('记录字段分页不完整。');
          cursor = result.next_cursor; cursors.add(cursor);
        } while (true);
        value.properties[name] = ['title', 'rich_text'].includes(entry.property_types?.[name]) ? items.join('') : items;
      }
      value.incomplete_properties = []; return value;
    }
    async function readDatabase(id, scope) {
      const schema = await execute('read_database', { database_id: id }, scope);
      if (schema.incomplete || schema.in_trash) fail('数据库结构不完整或已在回收站中。');
      const sources = schema.data_source_ids || (schema.data_source_id ? [schema.data_source_id] : []);
      if (sources.length > 25 || new Set(sources).size !== sources.length) fail('数据库数据源过多或重复，请缩小范围。');
      const rows = [], seenRows = new Set();
      for (const source of sources) {
        if (!uuid(source)) fail('数据库数据源标识无效。');
        let cursor; const cursors = new Set();
        do {
          const result = await execute('query_database', { data_source_id: source, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, scope);
          if (!Array.isArray(result.results)) fail('数据库记录列表无效。');
          for (const row of result.results) {
            if (!uuid(row.page_id) || seenRows.has(uuid(row.page_id))) fail('数据库记录分页重复或标识无效，请重新读取。');
            seenRows.add(uuid(row.page_id));
            if (++blocks > maxBlocks) fail('数据库记录过多，请缩小范围。');
            rows.push(await completeEntry(row, scope)); checkSize(rows);
          }
          if (!result.has_more) break;
          if (!result.next_cursor || cursors.has(result.next_cursor)) fail('数据库记录分页不完整。');
          cursor = result.next_cursor; cursors.add(cursor);
        } while (true);
      }
      return { kind: 'database', schema, rows, complete: true, view_scope: 'database-all-records',
        note: '这些是明确引用的数据库记录属性；未确认原生视图筛选，不包含每条记录的正文。' };
    }
    async function blockTree(block, scope, ancestors = new Set()) {
      const id = uuid(block.id); if (ancestors.has(id)) fail('内容出现循环引用。');
      const next = new Set(ancestors).add(id), data = block[block.type] || {};
      const value = { block_id: id, type: block.type, text: blockText(block), data };
      if (block.type === 'table_row') value.cells = (data.cells || []).map(plain);
      if (['link_to_page', 'child_page', 'child_database'].includes(block.type)) {
        value.pointer_only = true; value.body_available = false; value.note = '仅引用指针，未打开其目标正文。'; return value;
      }
      if (['image', 'pdf', 'file', 'audio', 'video', 'bookmark', 'embed', 'link_preview'].includes(block.type)) {
        const parsed = fileTypes.has(block.type) ? await fileBody(block, scope, ancestors.size === 0) : null;
        if (parsed) {
          Object.assign(value, parsed);
          // Signed storage URLs are used only by the downloader, not the model.
          value.data = { ...(data.name ? { name: data.name } : {}), ...(data.caption ? { caption: data.caption } : {}) };
        } else { value.body_available = false; value.note = '只读取到媒体或链接元数据，尚未解析二进制正文。'; }
      } else if (!['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'quote',
        'to_do', 'toggle', 'callout', 'code', 'equation', 'divider', 'breadcrumb', 'table_of_contents', 'table', 'table_row',
        'column_list', 'column', 'synced_block'].includes(block.type)) {
        value.body_available = false; value.note = '保留 API 实际返回的类型与字段；尚未实现此类型的完整正文解释。';
      }
      let childRoot = id;
      if (block.type === 'synced_block' && data.synced_from?.block_id) {
        childRoot = uuid(data.synced_from.block_id); if (!childRoot || next.has(childRoot)) fail('同步块指针无效或循环。');
        value.synced_source = childRoot; next.add(childRoot);
        block = await readBlock(childRoot, scope);
      }
      if (block.has_children) {
        value.children = [];
        for await (const child of children(childRoot, scope)) { value.children.push(await blockTree(child, scope, next)); checkSize(value); }
      }
      return value;
    }
    async function objectReference(pointer, fullPage) {
      const { id, spaceId: scope } = pointer; let block;
      try { block = await readBlock(id, scope); }
      catch (error) {
        if (!notFound(error)) throw error;
        let metadata;
        try { metadata = await execute('read_page_info', { page_id: id }, scope); }
        catch (error) { if (!notFound(error)) throw error; return readDatabase(id, scope); }
        return readPage(id, scope, metadata);
      }
      if (block.type === 'child_database') return readDatabase(id, scope);
      if (fullPage && block.type === 'child_page') return readPage(id, scope);
      return { kind: 'block', content: await blockTree(block, scope), complete: true };
    }
    async function textRange(selected) {
      const scope = uuid(spaceId), start = selected.value.start, end = selected.value.end;
      const first = await readBlock(start.pointer.id, scope), last = start.pointer.id === end.pointer.id ? first : await readBlock(end.pointer.id, scope);
      const slice = (block, from, to) => {
        const text = graphemes(blockText(block));
        if (from < 0 || from > text.length || to !== undefined && to > text.length) fail('文字范围已变化，请重新选择。');
        return text.slice(from, to).join('');
      };
      let text;
      if (first.id === last.id) text = slice(first, start.index, end.index);
      else {
        const lineage = async block => {
          const chain = [uuid(block.id)];
          for (let depth = 0, parent; (parent = parentId(block)); depth++) {
            if (chain.includes(parent) || depth >= 24) fail('选区父级出现循环或层级过深。');
            chain.push(parent);
            if (block.parent?.page_id || parent === uuid(pageId)) break;
            block = await readBlock(parent, scope);
          }
          return chain;
        };
        const left = await lineage(first), right = await lineage(last), common = left.find(id => right.includes(id));
        if (!common) fail('起止文字不属于同一内容范围。');
        const ancestors = new Set(left), pieces = [], visited = new Set(); let started = false, ended = false;
        const visit = async block => {
          const id = uuid(block.id);
          if (visited.has(id)) fail('文字范围出现循环或重复块。'); visited.add(id);
          if (id === uuid(first.id)) { started = true; pieces.push(slice(block, start.index)); }
          else if (id === uuid(last.id)) {
            if (!started) fail('文字起止顺序无效。');
            pieces.push(slice(block, 0, end.index)); ended = true; return;
          } else if (started) pieces.push(blockText(block));
          if (!ended && block.has_children && (started || ancestors.has(id)) &&
              (id === common || !['child_page', 'child_database', 'link_to_page'].includes(block.type))) {
            for await (const child of children(id, scope)) { await visit(child); if (ended) break; }
          }
          checkSize(pieces);
        };
        await visit(await readBlock(common, scope));
        if (!started || !ended) fail('文字边界未能完整读取，请重新选择。');
        text = pieces.join('\n');
      }
      if (!normalizePreview(text).startsWith(normalizePreview(selected.text))) fail('预览与读取内容不一致，请重新选择后重试。');
      return { type: 'text', text, complete: true, start, end };
    }
    try {
      const result = { references: [] };
      if (selection && (!selection.text.trim() || selection.isPreviewTruncated)) {
        result.selection = selection.type === 'text' ? await textRange(selection) : { type: 'blocks', complete: true, blocks: [] };
        if (selection.type === 'blocks') for (const pointer of referencePointers(selection.value, spaceId, { limit: maxBlocks })) {
          result.selection.blocks.push({ pointer, ...(await objectReference(pointer, false)) }); checkSize(result);
        }
      }
      for (const pointer of pointers) { result.references.push({ pointer, ...(await objectReference(pointer, true)) }); checkSize(result); }
      for (const proof of fileProofs.values()) {
        if (proof.pageId) {
          const latest = await readFileProperty({ execute: (name, args) => execute(name, args, proof.scope) }, proof.pageId, proof.propertyId, proof.scope, active);
          if (latest.revision !== proof.revision) fail('引用文件属性在读取其他来源期间已改变，请重新发送。');
          continue;
        }
        const latest = await execute('read_block', { block_id: proof.blockId }, proof.scope);
        if (latest.block_revision !== proof.revision) fail('引用附件在读取其他来源期间已改变，请重新发送。');
      }
      for (const proof of pageProofs.values()) {
        const latest = await execute('read_page', { page_id: proof.pageId, offset: 0 }, proof.scope);
        if (latest.revision !== proof.revision) fail('引用页面或附件列表在读取期间已改变，请重新发送。');
      }
      active.throwIfAborted(); return checkSize(result);
    } catch (error) { readError(error); }
  };
}
module.exports = { createInlineReferenceReader, referencePointers };
