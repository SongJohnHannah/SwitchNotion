function downloadDetail(value) {
  return String(value || '').replace(/(?:Cookie|Authorization)\s*[:=][^\r\n]*/gi, '[凭据已隐藏]')
    .replace(/Bearer\s+\S+|(?:sk-|ntn_|secret_)[\w-]{8,}/gi, '[凭据已隐藏]')
    .replace(/https?:\/\/[^\s<>"']+/gi, value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return '[链接]'; } })
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 450);
}
function downloadError(result) {
  const detail = downloadDetail(result?.error || result?.message || '下载器未返回所需媒体文件。');
  const verification = /not a bot|captcha|verify you are human|confirm you.re not|人机验证|验证码/i.test(detail);
  const authentication = !verification && /login required|log in to|sign in to|private video|members.only|age.restricted|登录后|需要登录/i.test(detail);
  return Error('媒体下载失败：' + detail + (verification ? ' 请在收集浏览器中完成原站验证后重试。' : authentication ? ' 原站明确限制了访问，请检查当前账号是否有权限后重试。' : ''));
}
module.exports = { downloadError, downloadDetail };
