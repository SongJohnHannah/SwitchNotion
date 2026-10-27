const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
function encodeRecording({ directory, root, provider, signal, spawnImpl = spawn }) {
  const runtime = provider.runtime;
  if (!runtime?.pythonExecutable) return Promise.reject(Error('会议录音编码环境未就绪，请检测离线语音引擎。'));
  return new Promise((resolve, reject) => {
    const child = spawnImpl(runtime.pythonExecutable, ['-B', path.join(__dirname, 'speech/encode-meeting.py'), '--directory', directory], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: provider.platform.environment(root)
    });
    let output = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => { child.kill(); finish(Error('会议录音保存已暂停，临时音频保留在本机。')); };
    const timer = setTimeout(abort, 30 * 60 * 1000); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.on('error', () => finish(Error('会议录音编码器无法启动。')));
    child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { output += text; if (output.length > 100000) abort(); });
    child.on('close', code => {
      if (code !== 0) { finish(Error('会议录音编码失败，原始临时音频已保留。')); return; }
      try {
        const result = JSON.parse(output);
        if (!Array.isArray(result.parts) || !result.parts.length || result.parts.length > 1000) throw Error();
        for (const part of result.parts) {
          if (!/^audio-\d{3,4}\.mp3$/.test(part.filename) || !Number.isSafeInteger(part.samples) || part.samples < 1) throw Error();
          const file = path.join(directory, part.filename), stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 || stat.size !== part.bytes) throw Error();
        }
        finish(null, result.parts);
      } catch { finish(Error('会议录音编码结果无效，临时音频已保留。')); }
    });
  });
}
module.exports = { encodeRecording };
