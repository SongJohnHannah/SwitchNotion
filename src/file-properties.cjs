const { createHash } = require('node:crypto');
const { uuid } = require('./native-context.cjs');
const fail = message => { throw Error('Notion 文件读取' + message); };
const propertyKey = value => { if (typeof value !== 'string') return null; try { return decodeURIComponent(value); } catch { return value; } };
function propertyFiles(entry, propertyId) {
  if (!entry || !uuid(entry.page_id) || entry.in_trash || entry.archived || typeof propertyId !== 'string' || !propertyId || propertyId.length > 200) fail('记录或文件字段无效。');
  const name = Object.keys(entry.property_ids || {}).find(name => propertyKey(entry.property_ids[name]) === propertyKey(propertyId));
  if (name === undefined || entry.property_types?.[name] !== 'files' || entry.incomplete_properties?.includes(name)) fail('文件字段不存在、尚未完整读取或类型不匹配。');
  const values = entry.properties?.[name];
  if (!Array.isArray(values) || values.length > 100) fail('文件字段格式或数量无效。');
  const identity = values.map(file => {
    const address = file?.[file?.type]?.url;
    if (!file || !['file', 'external'].includes(file.type) || typeof file.name !== 'string' || !file.name || file.name.length > 255 || typeof address !== 'string' || address.length > 16384) fail('文件字段内容无效。');
    let url; try { url = new URL(address); } catch { fail('文件字段地址无效。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('文件字段只支持 HTTPS 附件地址。');
    return [file.name, file.type, file.type === 'file' ? url.origin + url.pathname : url.href];
  });
  return { name, id: entry.property_ids[name], files: values, revision: createHash('sha256').update(JSON.stringify([uuid(entry.page_id), propertyKey(entry.property_ids[name]), identity])).digest('hex') };
}
async function readFileProperty(session, pageId, propertyId, spaceId, signal) {
  signal?.throwIfAborted();
  const entry = await session.execute('read_database_entry', { page_id: pageId, workspace_id: spaceId });
  if (uuid(entry.page_id) !== uuid(pageId)) fail('附件记录不属于所选页面。');
  const name = Object.keys(entry.property_ids || {}).find(name => propertyKey(entry.property_ids[name]) === propertyKey(propertyId));
  if (name !== undefined && entry.incomplete_properties?.includes(name)) {
    const result = await session.execute('read_database_entry_property', { page_id: pageId, property_id: entry.property_ids[name], workspace_id: spaceId });
    if (result.property_type !== 'files' || result.has_more || result.complete !== true || !Array.isArray(result.value)) fail('文件字段未完整读取，请缩小范围。');
    entry.properties[name] = result.value; entry.incomplete_properties = entry.incomplete_properties.filter(value => value !== name);
  }
  return propertyFiles(entry, propertyId);
}
function modelFileProperties(value) {
  const metadata = files => Array.isArray(files) ? files.map((file, file_index) => ({ name: typeof file?.name === 'string' ? file.name : '', type: file?.type, file_index, body_available: false, note: '用 read_notion_file 读取正文。' })) : [];
  const result = { ...value };
  if (value?.properties && Object.values(value.property_types || {}).includes('files')) {
    result.properties = { ...value.properties };
    for (const [name, type] of Object.entries(value.property_types)) if (type === 'files') result.properties[name] = metadata(value.properties[name]);
  }
  if (value?.property_type === 'files') {
    result.value = metadata(value.value);
    if (Array.isArray(value.items)) result.items = metadata(value.items.flat());
  }
  if (Array.isArray(value?.results)) result.results = value.results.map(modelFileProperties);
  return result;
}
module.exports = { propertyFiles, propertyKey, readFileProperty, modelFileProperties };
