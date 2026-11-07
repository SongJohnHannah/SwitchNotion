const path = require('node:path');
const { execFile } = require('node:child_process');
const { createSpeechPlatform } = require('./platform.cjs');
const worker = path.join(__dirname, 'worker.py');
function environment(root) { return createSpeechPlatform().environment(root); }
async function discover(root, { execFileImpl = execFile, platform = createSpeechPlatform() } = {}) {
  platform.requireSupported();
  for (const executable of platform.candidates(root)) {
    const result = await new Promise(resolve => execFileImpl(executable, [worker, '--root', root, '--model', platform.profile.model, '--discover'],
      { windowsHide: true, timeout: 45000, maxBuffer: 32768, encoding: 'utf8', env: platform.environment(root) }, (error, stdout) => {
        if (error) return resolve(null);
        try { const value = JSON.parse(stdout); resolve(value.ok ? platform.normalizeRuntime(value.runtime) : null); } catch { resolve(null); }
      }));
    if (result) return result;
  }
  const error = Error(`未找到本机 faster-whisper ${platform.profile.model} 与 ${platform.profile.hardwareLabel} 运行环境；请先准备离线转写环境。`);
  error.code = 'SPEECH_RUNTIME_NOT_FOUND'; throw error;
}
module.exports = { discover, environment, worker };
