import fs from './native-fs.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import desktop from '../src/platform/index.cjs';
import speech from '../src/speech/platform.cjs';
import { inspectDesktop } from './desktop-compat.mjs';
import { stateRoot } from './runtime-update.mjs';

// Read-only: no preparation, downloads, login reads, or native permission prompts.
export function checkWindows({ root = stateRoot, platform = desktop.createDesktopPlatform(),
  speechPlatform = speech.createSpeechPlatform(), nodeVersion = process.versions.node,
  fsImpl = fs, inspect = inspectDesktop } = {}) {
  if (platform.id !== 'win32') throw Error('此检测仅用于 Windows。');
  const checks = [], add = (id, status, message) => checks.push({ id, status, message });
  const read = file => {
    try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const fileExists = file => { try { return fsImpl.statSync(file).isFile(); } catch { return false; } };
  add('node', Number(nodeVersion.split('.')[0]) >= 22 ? 'pass' : 'fail', '需要 Node.js 22 或更新版本。');
  add('desktop-platform', platform.capabilities.prepareRuntime && platform.capabilities.launchRuntime &&
    speechPlatform.profile.architecture === 'x64' ? 'pass' : 'fail', 'Windows 桌面运行需要 x64 环境。');
  try {
    const source = platform.discoverInstallation(root);
    if (!source) add('installation', 'fail', '未找到官方 Notion，请安装后重新检测或通过启动窗口选择。');
    else {
      const build = inspect(fsImpl.readFileSync(source.archive), platform.compatibility);
      add('installation', 'pass', `官方 Notion ${build.version} 通过${build.compatibility === 'reviewed' ? '已审核哈希' : '结构'}检查。`);
    }
  } catch { add('installation', 'fail', 'Notion 安装无法读取或接入结构不兼容，请通过启动入口查看检查结果。'); }
  try {
    const saved = read(path.join(root, 'prepared.json'));
    if (!saved) add('runtime', 'info', '尚无隔离副本，首次启动时准备。');
    else if (saved.platform && saved.platform !== platform.id) add('runtime', 'fail', '隔离副本属于其他操作系统，请使用当前电脑的独立资料目录。');
    else {
      const layout = platform.runtimeLayout(path.join(root, 'runtime'));
      add('runtime', fileExists(layout.executable) && fileExists(layout.archive) ? (saved.pendingValidation ? 'warn' : 'pass') : 'fail',
        saved.pendingValidation ? '隔离副本尚未通过启动验证，请通过正常入口启动。' : '检查当前系统的隔离程序和资源文件是否完整。');
    }
    const launcher = read(path.join(root, 'launcher.local.json'));
    if (saved) add('login-helper', launcher && platform.isNodeExecutable(launcher.nodeExecutable) &&
      typeof launcher.projectDirectory === 'string' && path.isAbsolute(launcher.projectDirectory) &&
      fileExists(path.join(launcher.projectDirectory, 'scripts/login-helper.cjs')) &&
      fileExists(path.join(launcher.projectDirectory, 'scripts/open-settings.mjs')) ? 'pass' : 'warn',
    '登录同步需要当前项目和 Node 的有效记录；资料目录可与项目分开。记录失效时从项目启动入口重开。');
  } catch { add('runtime', 'fail', '隔离副本或启动记录无法读取，请保留现有资料并重新启动。'); }
  try {
    const saved = read(path.join(root, 'speech.local.json'));
    if (!saved?.runtime) add('speech', saved?.enabled ? 'fail' : 'info', '离线语音尚未准备，可在配置中检测并准备。');
    else {
      const selected = speechPlatform.withModel(saved.model || 'medium'), runtime = selected.normalizeRuntime(saved.runtime);
      const ready = fileExists(runtime.pythonExecutable) && fileExists(path.join(runtime.modelDirectory, 'model.bin'));
      add('speech', ready ? 'pass' : saved.enabled ? 'fail' : 'warn', ready
        ? `${selected.profile.hardwareLabel} / ${runtime.computeType} 配置与文件可用；实际引擎仍需在配置中检测。`
        : '本机 Python 或模型文件缺失，请在离线语音配置中重新检测。');
    }
  } catch { add('speech', 'fail', '语音配置损坏或属于其他系统、架构或模型，请在本机重新检测。'); }
  return { platform: platform.id, architecture: speechPlatform.profile.architecture, nodeVersion,
    ok: !checks.some(check => check.status === 'fail'), checks,
    manualChecks: ['Windows 原生窗口中的图片、引用、会议录音和更新恢复'],
    note: '只读检测通过不代表原生界面、系统权限或音频设备已实测。' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkWindows(); console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ ok: false, error: '当前系统不受支持，或运行资料目录设置无效。' })); process.exitCode = 1;
  }
}
