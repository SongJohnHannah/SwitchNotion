const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function createSpeechPlatform({ id = process.platform, arch = process.arch, env = process.env,
  home = os.homedir(), fsImpl = fs } = {}) {
  const windows = id === 'win32' && arch === 'x64';
  const apple = id === 'darwin' && arch === 'arm64';
  const paths = id === 'win32' ? path.win32 : path.posix;
  const profile = Object.freeze({ platform: id, architecture: arch, supported: windows || apple,
    provider: 'faster-whisper', model: 'medium', device: windows ? 'cuda' : 'cpu',
    computeType: windows ? 'float16' : 'int8', cpuThreads: 4, offline: true,
    hardwareLabel: windows ? 'NVIDIA GPU' : apple ? 'Apple Silicon CPU' : '不支持的平台' });
  function requireSupported() {
    if (!profile.supported) {
      const error = Error('离线语音支持 Windows x64 NVIDIA GPU 和 Apple Silicon Mac（M1 或更新芯片）；请使用原生 ARM64 程序。');
      error.code = 'SPEECH_PLATFORM_UNSUPPORTED'; throw error;
    }
  }
  function normalizeRuntime(runtime) {
    requireSupported();
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime) ||
      ![runtime.pythonExecutable, runtime.modelDirectory].every(v => typeof v === 'string' && !v.includes('\0') && paths.isAbsolute(v)) ||
      runtime.platform && runtime.platform !== id || runtime.architecture && runtime.architecture !== arch ||
      runtime.device && runtime.device !== profile.device || runtime.computeType && runtime.computeType !== profile.computeType) {
      const error = Error('本机语音配置不属于当前系统，请在离线语音中重新检测。');
      error.code = 'SPEECH_RUNTIME_MISMATCH'; throw error;
    }
    // Windows v1 settings did not include a platform stamp. Never reuse its
    // DLL paths on a Mac, even when the rest of the configuration was copied.
    if (apple && runtime.dllDirectory) throw Error('本机语音配置来自 Windows，请在 Mac 上重新检测。');
    return { pythonExecutable: runtime.pythonExecutable, modelDirectory: runtime.modelDirectory,
      dllDirectory: windows ? runtime.dllDirectory || null : null, platform: id, architecture: arch, device: profile.device,
      computeType: profile.computeType, cpuThreads: profile.cpuThreads };
  }
  function candidates(root) {
    const result = windows ? [paths.join(root, 'speech/python/python.exe')]
      : [paths.join(root, 'speech/python/bin/python3'), paths.join(root, 'speech/venv/bin/python3')];
    try {
      const saved = JSON.parse(fsImpl.readFileSync(paths.join(root, 'speech.local.json'), 'utf8'));
      result.push(normalizeRuntime(saved.runtime).pythonExecutable);
    } catch {}
    if (env.NOTION_SWITCH_SPEECH_PYTHON) result.push(env.NOTION_SWITCH_SPEECH_PYTHON);
    if (windows) result.push(paths.join(home, 'AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe'));
    else result.push('/opt/homebrew/bin/python3', paths.join(home, '.local/bin/python3'));
    const versions = paths.join(home, windows ? '.pyenv/pyenv-win/versions' : '.pyenv/versions');
    try { for (const name of fsImpl.readdirSync(versions).sort().reverse()) result.push(paths.join(versions, name, windows ? 'python.exe' : 'bin/python3')); } catch {}
    for (const dir of (env.PATH || '').split(windows ? ';' : ':')) if (dir) result.push(paths.join(dir, windows ? 'python.exe' : 'python3'));
    const name = windows ? /^python(?:\d+(?:\.\d+)*)?\.exe$/i : /^python(?:3(?:\.\d+)?)?$/;
    return [...new Set(result)].filter(file => paths.isAbsolute(file) && name.test(paths.basename(file)) && fsImpl.existsSync(file));
  }
  function environment(root) {
    // Explicit local-execution variables only; never inherit API keys or login tokens.
    const allowed = windows ? /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|HOMEDRIVE|HOMEPATH|CUDA_PATH(?:_V[\d_]+)?)$/i
      : /^(?:PATH|HOME|TMPDIR|LANG|LC_ALL|LC_CTYPE)$/;
    const value = { ...Object.fromEntries(Object.entries(env).filter(([key]) => allowed.test(key))),
      PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1',
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' };
    if (windows) value.CUDA_CACHE_PATH = paths.join(root, 'speech/cuda-cache');
    return value;
  }
  return Object.freeze({ profile, requireSupported, normalizeRuntime, candidates, environment });
}
module.exports = { createSpeechPlatform };
