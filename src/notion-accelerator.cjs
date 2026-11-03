const fs = require('node:fs');
const path = require('node:path');

const fileName = 'notion-accelerator.local.json';
// Chromium 的 --proxy-bypass-list 与 NO_PROXY 都使用这些域名。
const bypassList = '*.notion.so;*.notion.com;*.notion.site;notion.so;notion.com;notion.site';
const bypassEnv = 'notion.so,.notion.so,notion.com,.notion.com,notion.site,.notion.site';
// 这些域名实测都可以由 Notion 源站 IP 提供服务；api.pgncs.notion.so 在 AWS，不能固定。
const mappedHosts = ['api.notion.com', 'notion.so', 'www.notion.so', 'msgstore.www.notion.so', 'exp.notion.so',
  'calendar-api.notion.so', 'file.notion.so', 'notion.com', 'www.notion.com', 'calendar.notion.so'];

function ipv4(value) {
  return typeof value === 'string' && /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(value) ? value : '';
}

function timestamp(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : '';
}

function empty() {
  return { bypassVpn: false, autoIp: false, bestIp: '', checkedAt: '' };
}

function read(root) {
  const file = path.join(root, fileName);
  if (!fs.existsSync(file)) return empty();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { bypassVpn: data?.bypassVpn === true, autoIp: data?.autoIp === true, bestIp: ipv4(data?.bestIp), checkedAt: timestamp(data?.checkedAt) };
  } catch { return empty(); }
}

function save(root, value = {}) {
  const previous = read(root);
  const settings = { bypassVpn: value.bypassVpn === true, autoIp: value.autoIp === true,
    bestIp: value.bestIp === undefined ? previous.bestIp : ipv4(value.bestIp),
    checkedAt: value.checkedAt === undefined ? previous.checkedAt : timestamp(value.checkedAt) };
  fs.writeFileSync(path.join(root, fileName), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flush: true });
  return settings;
}

function hostRules(ip) {
  const address = ipv4(ip);
  return address ? mappedHosts.map(host => `MAP ${host} ${address}`).join(', ') : '';
}

module.exports = { fileName, bypassList, bypassEnv, mappedHosts, read, save, hostRules };
