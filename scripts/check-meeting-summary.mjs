import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Standalone and read-only, so this file can also be copied to another Mac.
// Return allowlisted metadata only: never print profile paths, keys, IDs,
// meeting text, draft summaries, request headers, or raw server errors.
const bool = value => typeof value === 'boolean' ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) ? value : null;
const message = error => {
  if (!error) return null;
  if (typeof error !== 'string') return '摘要错误详情不可用';
  if (/HTTP\s+\d{3}/.test(error)) return 'Notion HTTP ' + error.match(/HTTP\s+(\d{3})/)[1];
  if (/发生变化|已经变化/.test(error)) return '生成期间来源或指令变化';
  if (/指令|模板/.test(error)) return '摘要指令读取失败';
  if (/账号|登录|权限/.test(error)) return '登录会话或编辑权限问题';
  if (/工作区/.test(error)) return '工作区范围不匹配';
  if (/核验|尚未确认/.test(error)) return '摘要写回尚未核验成功';
  if (/DeepSeek|API Key/.test(error)) return 'DeepSeek 配置、连接或生成失败';
  if (/尚无可总结|有效的转录|会议子记录|会议标签|文字过长|内容过大/.test(error)) return '会议转录或标签读取失败';
  return '摘要生成或保存失败（现有状态未提供具体阶段）';
};

export async function checkMeetingSummary({ projectDirectory = path.resolve(import.meta.dirname, '..'), root,
  platform = process.platform, home = os.homedir(), env = process.env, fsImpl = fs, fetchImpl = fetch } = {}) {
  if (root && !path.isAbsolute(root) || !path.isAbsolute(projectDirectory)) throw Error('资料目录必须是绝对路径。');
  const read = (directory, name) => {
    try {
      const file = path.join(directory, name), stat = fsImpl.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
      return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    } catch { return null; }
  };
  root ||= env.NOTION_SWITCH_ROOT;
  if (root && !path.isAbsolute(root)) throw Error('资料目录必须是绝对路径。');
  const candidates = root ? [{ label: '指定资料目录', directory: root }] : [
    { label: '项目资料', directory: path.join(projectDirectory, '.notion-switch', ...(platform === 'darwin' ? ['mac-arm64'] : [])) },
    ...(platform === 'darwin' ? [{ label: 'Mac 应用资料', directory: path.join(home, 'Library', 'Application Support', 'Switch Notion') }] : [])
  ];
  const profiles = [];
  for (const { label, directory } of candidates) {
    const saved = read(directory, 'speech.local.json'), prepared = read(directory, 'prepared.json');
    if (!saved && !prepared) continue;
    const report = { profile: label, platformMatches: !prepared?.platform || prepared.platform === platform,
      notionVersion: /^\d+\.\d+\.\d+$/.test(prepared?.version || '') ? prepared.version : null,
      live: false, speechEnabled: saved ? saved.enabled === true : null,
      autoSummary: saved ? saved.autoSummary !== false : null, providerMode: null, providerKeyConfigured: null,
      summary: null, recentEvents: [] };
    const control = report.platformMatches ? read(directory, 'control.json') : null;
    if (Number.isSafeInteger(control?.port) && control.port > 0 && control.port <= 65535 && /^[a-f\d]{64}$/.test(control.token || '')) {
      try {
        const response = await fetchImpl(`http://127.0.0.1:${control.port}/status`, {
          method: 'GET', headers: { authorization: `Bearer ${control.token}` }, redirect: 'error', signal: AbortSignal.timeout(5000)
        });
        if (response.ok) {
          const status = await response.json(), summary = status.meetingSummaries;
          report.live = status.appReady === true;
          report.speechEnabled = bool(status.speech?.enabled) ?? report.speechEnabled;
          report.autoSummary = bool(status.speech?.autoSummary) ?? report.autoSummary;
          report.providerMode = ['deepseek', 'mock', 'configuration-error'].includes(status.mode) ? status.mode : null;
          report.providerKeyConfigured = bool(status.keyConfigured);
          report.summary = summary ? { active: count(summary.active), completed: count(summary.completed), uncertain: count(summary.uncertain), error: message(summary.lastError) } : null;
        }
      } catch {}
    }
    // Read just the tail of the event journal; never copy arbitrary log data.
    let fd;
    try {
      const file = path.join(directory, 'events.jsonl'), stat = fsImpl.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        fd = fsImpl.openSync(file, 'r');
        const size = Math.min(stat.size, 1024 * 1024), buffer = Buffer.alloc(size);
        fsImpl.readSync(fd, buffer, 0, size, stat.size - size);
        const allowed = new Set(['offline-audio-connected', 'offline-meeting-summary-skipped', 'meeting-summary-failed', 'meeting-summary-verified']);
        for (const line of buffer.toString('utf8').split('\n').slice(stat.size > size ? 1 : 0)) {
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (allowed.has(event.type) && timestamp(event.time)) report.recentEvents.push({ time: event.time, type: event.type });
        }
        report.recentEvents = report.recentEvents.slice(-12);
      }
    } catch {} finally { if (fd !== undefined) fsImpl.closeSync(fd); }
    report.finding = !report.platformMatches ? '资料属于其他操作系统，不能据此判断当前 Mac。' :
      !report.live ? '服务未连接；只能看到历史记录，请启动 Switch Notion 后再检查。' :
      report.autoSummary === false ? '当前机器关闭了自动摘要。' :
      report.providerMode !== 'deepseek' || report.providerKeyConfigured === false ? '当前机器的 DeepSeek 配置尚未就绪。' :
      report.summary?.active > 0 ? '摘要任务仍在处理。' :
      report.summary?.error ? report.summary.error :
      report.summary?.uncertain > 0 ? '有摘要写回结果尚未确认；不要重复提交。' :
      '开关和配置可用；需对照最近一次重试后的事件，现有记录不能确认指定会议的失败原因。';
    profiles.push(report);
  }
  return { platform, readOnly: true, profiles,
    note: '录音与摘要是独立流程。此检查不启动录音、不调用模型、不修改 Notion，也不检查工作区 API 连接密钥。没有结果事件不等于没有发出请求。' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--root')) throw Error('只支持 --root 绝对资料路径。');
    const projectDirectory = fs.existsSync(path.resolve('src/desktop-hook.cjs')) ? process.cwd() : path.resolve(import.meta.dirname, '..');
    console.log(JSON.stringify(await checkMeetingSummary({ projectDirectory, ...(args.length ? { root: args[1] } : {}) }), null, 2));
  } catch { console.error('只读会议检查未完成，请核对项目目录和 --root 参数。'); process.exitCode = 1; }
}
