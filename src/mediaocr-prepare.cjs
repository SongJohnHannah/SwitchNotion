const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { REVISION, layout, verifySource } = require('./mediaocr.cjs');
async function prepareMediaOcr({ root, platform = process.platform, arch = process.arch, signal, progress = () => {} }) {
  if (!['win32', 'darwin'].includes(platform)) throw Error('mediaocr 准备仅支持 Windows 与 Mac。');
  root = path.resolve(root); const files = layout(root, platform, arch);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|TMPDIR|USERPROFILE|APPDATA|LOCALAPPDATA|HOME|LANG|LC_ALL)$/i.test(key)));
  Object.assign(env, { PIP_CACHE_DIR: path.join(root, 'mediaocr', 'pip-cache'), PIP_DISABLE_PIP_VERSION_CHECK: '1' });
  const command = (file, args, timeout = 600000) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    execFile(file, args, { cwd: root, env, signal, windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 8 * 1024 ** 2, timeout }, (error, stdout) => error ? reject(Error('mediaocr 准备命令失败，已保留下载缓存；请检查 Git、Python 与网络后重试。')) : resolve(stdout.trim()));
  });
  fs.mkdirSync(root, { recursive: true });
  for (let cursor = files.directory; cursor !== path.dirname(root); cursor = path.dirname(cursor)) { if (fs.lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('mediaocr 资料路径含链接，未准备。'); if (cursor === path.dirname(cursor)) break; }
  fs.mkdirSync(files.directory, { recursive: true });
  for (const file of [files.source, path.join(files.directory, 'venv')]) if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('mediaocr 运行目录含链接，未准备。');
  if (!fs.existsSync(path.join(files.source, '.git'))) await command('git', ['init', files.source]);
  let checkedOut;
  try { checkedOut = await command('git', ['-C', files.source, 'rev-parse', 'HEAD']); } catch {}
  if (checkedOut && checkedOut !== REVISION) throw Error('mediaocr 运行目录包含其他版本，未覆盖。');
  if (!checkedOut) {
    progress('正在取得包含 Mac 支持的 mediaocr 指定版本…');
    await command('git', ['-C', files.source, '-c', 'credential.helper=', 'fetch', '--depth', '1', 'https://github.com/SongJohnHannah/mediaocr.git', REVISION]);
    await command('git', ['-C', files.source, '-c', 'core.autocrlf=false', 'checkout', '--detach', REVISION]);
  }
  if (await command('git', ['-C', files.source, 'rev-parse', 'HEAD']) !== REVISION) throw Error('mediaocr 版本不是已审核版本，未执行。');
  verifySource(files.source, platform);
  if (!fs.existsSync(files.python)) {
    let python;
    let speechPython;
    try { speechPython = JSON.parse(fs.readFileSync(path.join(root, 'speech.local.json'), 'utf8')).runtime?.pythonExecutable; } catch {}
    const candidates = [...(typeof speechPython === 'string' && path.isAbsolute(speechPython) ? [speechPython] : []), ...(platform === 'win32' ? ['python', 'python3.11'] : ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3.11'])];
    for (const candidate of candidates) {
      try {
        const info = JSON.parse(await command(candidate, ['-c', 'import json,sys,struct,platform;print(json.dumps({"executable":sys.executable,"version":list(sys.version_info[:2]),"bits":struct.calcsize("P")*8,"machine":platform.machine()}))'], 30000));
        const version = info.version[0] === 3 && (platform === 'win32' ? info.version[1] === 11 : info.version[1] >= 11), native = platform !== 'darwin' || (arch === 'arm64' ? ['arm64', 'aarch64'].includes(info.machine.toLowerCase()) : ['x86_64', 'amd64'].includes(info.machine.toLowerCase()));
        if (version && native && info.bits === 64) { python = info.executable; break; }
      } catch {}
    }
    if (!python) throw Error(platform === 'win32' ? 'mediaocr 需要 64 位 Python 3.11，未修改其他 Python 环境。' : 'mediaocr 需要与 Mac 架构一致的 Python 3.11+，请先安装；未启用 Rosetta。');
    progress('正在建立独立 Python 环境…'); await command(python, ['-m', 'venv', path.dirname(path.dirname(files.python))]);
  }
  progress('正在准备 mediaocr 的 MCP、PDF 与媒体依赖…');
  const prefix = await command(files.python, ['-c', 'import sys;print(sys.prefix)'], 30000), expectedPrefix = path.dirname(path.dirname(files.python));
  if ((platform === 'win32' ? path.resolve(prefix).toLowerCase() : path.resolve(prefix)) !== (platform === 'win32' ? expectedPrefix.toLowerCase() : expectedPrefix)) throw Error('mediaocr Python 不属于专用环境，未安装依赖。');
  await command(files.python, ['-m', 'ensurepip', '--upgrade'], 60000);
  await command(files.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'mcp[cli]>=1.26,<2', 'PyMuPDF>=1.24,<2', 'imageio-ffmpeg>=0.5,<1', ...(platform === 'darwin' ? ['protobuf>=4.25,<8'] : [])]);
  await command(files.python, ['-c', 'import sys,struct;sys.path.insert(0,sys.argv[1]);import server,mcp,fitz,imageio_ffmpeg;assert sys.version_info>=(3,11) and struct.calcsize("P")==8', files.source], 30000);
  if (platform === 'darwin') { progress('正在核对上游 Mac 原生引擎清单与合成样例…'); await command(files.python, [path.join(files.source, 'scripts', 'verify_macos_engine.py')], 120000); }
  signal?.throwIfAborted();
  const temporary = files.ready + '.tmp'; fs.writeFileSync(temporary, JSON.stringify({ version: 1, revision: REVISION, platform, arch, preparedAt: new Date().toISOString() }), { mode: 0o600, flush: true }); fs.renameSync(temporary, files.ready);
  progress('mediaocr 已就绪；下一次附件 OCR 使用其本机原生引擎。');
  return { ready: true, revision: REVISION, platform, arch };
}
module.exports = { prepareMediaOcr };
