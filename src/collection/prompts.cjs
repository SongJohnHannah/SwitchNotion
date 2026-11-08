function promptSettings(input = {}, base = { mode: 'auto', preference: '' }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('提取设置无效。');
  // Legacy builds stored two editable templates (article/video); accept them on
  // read so existing settings and job files still load, then drop the text.
  if (Object.keys(input).some(key => !['mode', 'preference', 'article', 'video'].includes(key))) throw Error('提取设置包含未知选项。');
  const value = { ...base, ...input };
  if (value.mode === 'article' || value.mode === 'video') value.mode = 'auto';
  if (!['auto', 'style', 'both', 'off'].includes(value.mode)) throw Error('请选择有效的内容提取模式。');
  if (typeof value.preference !== 'string' || value.preference.length > 4000 || value.preference.includes('\0')) throw Error('额外总结偏好须为 0–4000 字。');
  return { mode: value.mode, preference: value.preference };
}

module.exports = { promptSettings };
