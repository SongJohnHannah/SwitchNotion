const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { download } = require('./download.cjs');
const { createSpeechPlatform } = require('./platform.cjs');
const { discover } = require('./discovery.cjs');
const models = require('./models.json');
const UV = Object.freeze({
  win32: { archive: 'uv-x86_64-pc-windows-msvc.zip', digest: 'a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a', executable: 'uv.exe' },
  darwin: { archive: 'uv-aarch64-apple-darwin.tar.gz', digest: '743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73', executable: 'uv-aarch64-apple-darwin/uv' }
});
function run(executable, args, { env, signal, spawnImpl = spawn } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env, signal });
    let bytes = 0;
    const consume = chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) child.kill(); };
    child.stdout?.on('data', consume); child.stderr?.on('data', consume);
    child.once('error', () => reject(Error('本机语音准备进程未能启动。')));
    child.once('exit', code => code === 0 ? resolve() : reject(Error('本机语音组件准备失败，请检查网络后重新准备；已下载的缓存会保留。')));
  });
}
async function install({ root, platform = createSpeechPlatform(), onProgress = () => {}, signal,
  downloadImpl = download, runImpl = run, discoverImpl = discover } = {}) {
  platform.requireSupported();
  const directory = path.resolve(root, 'speech'), selected = UV[platform.profile.platform];
  if (!path.isAbsolute(root) || !selected) throw Error('本机语音安装目录无效。');
  fs.mkdirSync(directory, { recursive: true });
  // All installers, caches and managed Python files stay inside local state.
  for (let cursor = directory; cursor !== path.dirname(root); cursor = path.dirname(cursor)) {
    if (fs.lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('本机语音安装目录含链接，未安装。');
    if (cursor === path.dirname(cursor)) break;
  }
  const tools = path.join(directory, 'tools/uv-0.13.5'), archive = path.join(directory, selected.archive);
  const uv = path.join(tools, selected.executable), marker = path.join(tools, 'verified.json');
  const phase = message => onProgress({ message });
  const env = { ...platform.environment(root), HF_HUB_OFFLINE: '0', TRANSFORMERS_OFFLINE: '0',
    HF_HOME: path.join(directory, 'huggingface'), HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_HUB_DISABLE_XET: '1',
    UV_CACHE_DIR: path.join(directory, 'cache'), UV_PYTHON_INSTALL_DIR: path.join(directory, 'python-managed'),
    UV_PYTHON_BIN_DIR: path.join(directory, 'python-bin'), UV_PYTHON_INSTALL_BIN: '0', UV_PYTHON_INSTALL_REGISTRY: '0' };
  env.UV_HTTP_TIMEOUT = '90'; env.HF_HUB_DOWNLOAD_TIMEOUT = '90';
  let verified = false;
  try { const value = JSON.parse(fs.readFileSync(marker)); verified = value.sha256 === selected.digest && value.executableHash === createHash('sha256').update(fs.readFileSync(uv)).digest('hex'); } catch {}
  if (!verified) {
    phase('正在下载并校验本机 Python 准备工具…');
    await downloadImpl({ url: 'https://github.com/astral-sh/uv/releases/download/0.13.5/' + selected.archive,
      file: archive, sha256: selected.digest, signal, onProgress: value => onProgress({ message: '正在下载本机准备工具…', ...value }) });
    fs.mkdirSync(tools, { recursive: true });
    if (platform.profile.platform === 'win32') await runImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'extract-runtime.ps1'), '-Archive', archive, '-Destination', tools], { env, signal });
    else await runImpl('/usr/bin/tar', ['-xzf', archive, '-C', tools], { env, signal });
    fs.chmodSync(uv, 0o755);
    fs.writeFileSync(marker, JSON.stringify({ sha256: selected.digest, executableHash: createHash('sha256').update(fs.readFileSync(uv)).digest('hex') }));
  }
  phase('正在项目本地目录准备独立 Python 3.11 环境…');
  const venv = path.join(directory, 'python'), python = path.join(venv, platform.profile.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
  await runImpl(uv, ['--no-config', 'venv', '--no-project', '--managed-python', '--python', '3.11', '--allow-existing', venv], { env, signal });
  if (platform.profile.platform === 'win32') {
    try { await runImpl(python, ['-c', 'import ctypes; d=ctypes.WinDLL("nvcuda.dll"); assert d.cuInit(0)==0'], { env, signal }); }
    catch { throw Error('本机未检测到可用的 NVIDIA CUDA 驱动，请安装驱动后再准备语音。'); }
  }
  phase('正在下载 faster-whisper 和本地依赖，首次准备需要联网…');
  await runImpl(uv, ['--no-config', 'pip', 'install', '--python', python, '--only-binary=:all:', '-r', path.join(__dirname, 'requirements.txt')], { env, signal });
  const model = models[platform.profile.model];
  phase(`正在下载或续传 ${model.name} 中英文模型（约 ${model.size}）…`);
  await runImpl(python, [path.join(__dirname, 'managed_prepare.py'), '--root', root, '--model', platform.profile.model], { env, signal });
  phase('正在验证本机离线环境…');
  try { return await discoverImpl(root, { platform }); }
  catch (error) { if (platform.profile.platform !== 'win32' || error.code !== 'SPEECH_RUNTIME_NOT_FOUND') throw error; }
  phase('正在下载缺少的 Windows GPU 运行库（约 1.2 GB）…');
  await runImpl(uv, ['--no-config', 'pip', 'install', '--python', python, '--only-binary=:all:',
    'nvidia-cublas-cu12==12.8.4.1', 'nvidia-cudnn-cu12==9.10.2.21', 'nvidia-cuda-runtime-cu12==12.8.90'], { env, signal });
  return discoverImpl(root, { platform });
}
module.exports = { install, run, UV };
