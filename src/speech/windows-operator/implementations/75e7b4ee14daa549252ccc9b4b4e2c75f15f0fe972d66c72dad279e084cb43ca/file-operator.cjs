'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createFileOperator({ home = __dirname, loader = require } = {}) {
  const inside = value => {
    if (typeof value !== 'string') throw Error('包内路径无效。');
    const resolved = path.resolve(home, value), relative = path.relative(home, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('包内路径越界。');
    return resolved;
  };
  const machine = () => JSON.parse(fs.readFileSync(path.join(home, 'machine.json'), 'utf8'));
  function describe() {
    const value = machine();
    return { ...value, packageDirectory: home, operatorProtocol: 1, deviceRequired: 'cuda',
      resourcesReady: [value.pythonExecutable, value.modelDirectory, value.ffmpeg].every(file => fs.existsSync(inside(file))),
      gpuProbePerformed: false };
  }
  async function transcribeFile(options = {}) {
    // Read the profile on each call. A running application can adopt a newly
    // validated immutable profile without reloading a live worker's source.
    const current = machine(), profile = options.profile || 'winner', selected = current.profiles?.[profile];
    if (!selected) throw Error('未知GPU方案：' + profile);
    if (['failed', 'content-review-needed', 'rejected'].includes(selected.status)) throw Error('此方案已失败或内容待复核，不能作为可用转写路径。');
    if (selected.experimental === true && options.allowExperimental !== true) throw Error('实验GPU方案尚未验收，需要显式实验调用。');
    const plan = JSON.parse(fs.readFileSync(inside(selected.planFile), 'utf8'));
    const language = Object.hasOwn(options, 'language') ? options.language : 'en';
    if (!['auto', 'en', 'zh'].includes(language)) throw Error('language须为auto/en/zh。');
    plan.languageOverride = language === 'auto' ? null : language;
    const source = path.resolve(options.source || current.originalVideo || '');
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw Error('音视频不存在，请提供source绝对路径。');
    const outputDirectory = options.outputDirectory ? path.resolve(options.outputDirectory)
      : path.join(home, 'outputs', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8));
    const runtime = { pythonExecutable: inside(current.pythonExecutable), modelDirectory: inside(current.modelDirectory),
      model: current.model, platform: 'win32', architecture: 'x64', device: 'cuda', computeType: plan.computeType,
      cpuThreads: 4, dllDirectory: null, dllDirectories: [] };
    const entryFile = selected.entryFile || 'module/src/speech-provider.cjs';
    const api = loader(inside(entryFile));
    if (typeof api.transcribeGpuFile !== 'function') throw Error('GPU方案缺少独立入口。');
    const result = await api.transcribeGpuFile({ source, outputDirectory, root: inside(current.resourcesRoot),
      ffmpeg: inside(current.ffmpeg), runtime, plan, language, signal: options.signal, onProgress: options.onProgress || (() => {}) });
    if (result.complete !== true || result.device !== 'cuda') throw Error('独立算子拒绝非完整CUDA结果。');
    return { ...result, profile, entryFile, outputDirectory,
      validationScope: selected.experimental ? '实验路径，需独立整片质量和稳定性验收'
        : language === 'en' ? '本机英文访谈整段验证路径；本次结果独立保存' : '显式auto/zh派生调用，未冒用英文全片质量验收' };
  }
  async function transcodeVideo(options = {}) {
    const current = machine();
    const api = loader(inside('module/src/speech/video-transcode.cjs'));
    const result = await api.transcodeVideo({ source: path.resolve(options.source || ''),
      outputDirectory: options.outputDirectory ? path.resolve(options.outputDirectory) : path.join(home, 'video-runs'),
      quality: options.quality || 'original', hardwareDecode: options.hardwareDecode !== false,
      ...(options.forceKeyframeSeconds !== undefined ? { forceKeyframeSeconds: options.forceKeyframeSeconds } : {}),
      root: inside(current.resourcesRoot), ffmpeg: inside(current.ffmpeg), ffprobe: inside(current.ffprobe || 'bin/ffprobe.exe'),
      signal: options.signal, onProgress: options.onProgress || (() => {}) });
    if (result.complete !== true || result.engine !== 'h264_nvenc') throw Error('独立算子没有返回完整GPU视频转码结果。');
    return result;
  }
  function createSpeechSession(options = {}) {
    const current = machine();
    if (!current.sessionEntryFile) throw Error('独立实时GPU会话尚未部署。');
    const native = current.profiles?.native30;
    if (!native) throw Error('缺少已验证的Native30会话配置。');
    if (![current.pythonExecutable, current.modelDirectory].every(file => fs.existsSync(inside(file)))) throw Error('独立GPU会话资源不完整。');
    const planNative = JSON.parse(fs.readFileSync(inside(native.planFile), 'utf8'));
    const api = loader(inside(current.sessionEntryFile));
    const gpu = loader(inside(path.join(path.dirname(current.sessionEntryFile), 'gpu-file.cjs')));
    const runtime = { pythonExecutable: inside(current.pythonExecutable), modelDirectory: inside(current.modelDirectory),
      model: current.model, platform: 'win32', architecture: 'x64', device: 'cuda', computeType: 'float16',
      cpuThreads: 4, dllDirectory: null, dllDirectories: [] };
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) throw Error('会话超时设置无效。');
    return api.createSpeechSession({ root: inside(current.resourcesRoot), runtime, planNative, onProgress: options.onProgress,
      providerFactory: values => { const provider = gpu.providerFor(values); if (options.timeoutMs !== undefined) provider.timeoutMs = options.timeoutMs; return provider; } });
  }
  return { transcribeFile, transcodeVideo, createSpeechSession, describe };
}
module.exports = { ...createFileOperator(), createFileOperator };
