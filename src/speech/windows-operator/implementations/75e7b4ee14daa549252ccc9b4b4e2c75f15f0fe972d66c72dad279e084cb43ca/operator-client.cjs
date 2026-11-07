'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { transcriptQualityIssue } = require('./transcript-quality.cjs');
const defaultOperatorDirectory = 'D:\\迅雷下载\\notionSwitch\\GPU转写算子';
const digest = value => createHash('sha256').update(value).digest('hex');

// The package owns its Python/model/CUDA root and machine-wide GPU lease. This
// adapter must never prepare, probe, or fall back through the app's old provider.
class GpuOperatorClient {
  constructor({ root, directory, env = process.env, loader = require } = {}) {
    this.directory = directory || env.NOTION_SWITCH_GPU_OPERATOR_DIRECTORY || defaultOperatorDirectory;
    this.archiveDirectory = path.join(root || path.dirname(this.directory), 'collection', 'transcriptions');
    this.videoArchiveDirectory = path.join(root || path.dirname(this.directory), 'collection', 'video-transcodes');
    this.loader = loader;
  }
  load() {
    if (!path.isAbsolute(this.directory)) throw Error('独立 GPU 算子目录必须使用绝对路径。');
    if (!this.operator) {
      const entry = path.join(this.directory, 'operator.cjs');
      try { this.operator = this.loader(entry); }
      catch (cause) { throw Object.assign(Error('独立 GPU 转写算子无法加载：' + entry + '；' + cause.message, { cause }), { code: 'GPU_OPERATOR_UNAVAILABLE' }); }
      if (typeof this.operator?.transcribeFile !== 'function') throw Error('独立 GPU 算子未提供 transcribeFile 文件接口。');
    }
    return this.operator;
  }
  profileIdentity({ profile = 'winner', language = 'auto' } = {}) {
    if (!['auto', 'en', 'zh'].includes(language)) throw Error('转写语言须为 auto、en 或 zh。');
    const description = this.load().describe?.() || {}, selected = description.profiles?.[profile];
    const files = ['operator.cjs', 'module/src/speech/gpu-file.cjs'];
    for (const file of [selected?.planFile, selected?.entryFile].filter(Boolean)) {
      const resolved = path.resolve(this.directory, file), relative = path.relative(this.directory, resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('独立 GPU 算子方案路径无效。');
      files.push(relative);
    }
    return digest(JSON.stringify({ packageDirectory: this.directory, createdAt: description.createdAt, model: description.model, profile, language,
      selected, files: files.map(file => { const full = path.join(this.directory, file); return [file, fs.existsSync(full) ? digest(fs.readFileSync(full)) : null]; }) }));
  }
  outputDirectoryFor(source, options = {}) {
    if (!path.isAbsolute(source)) throw Error('转写文件须为绝对路径。');
    const stat = fs.statSync(source);
    if (!stat.isFile() || !stat.size) throw Error('转写音视频文件无效。');
    // Directory routing only. The operator still computes and verifies its own
    // source identity and checkpoint identity before accepting any saved text.
    const sourceKey = digest(JSON.stringify([fs.realpathSync(source), stat.size, stat.mtimeMs]));
    return path.join(this.archiveDirectory, sourceKey, this.profileIdentity(options));
  }
  async transcribeFile({ source, outputDirectory, language = 'auto', profile = 'winner', allowExperimental = false, signal, onProgress = () => {} } = {}) {
    signal?.throwIfAborted();
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw Error('转写文件须为绝对路径。');
    if (!['auto', 'en', 'zh'].includes(language)) throw Error('转写语言须为 auto、en 或 zh。');
    if (typeof allowExperimental !== 'boolean') throw Error('allowExperimental 必须为 boolean 布尔值。');
    const operator = this.load();
    outputDirectory ||= this.outputDirectoryFor(source, { profile, language });
    if (!path.isAbsolute(outputDirectory)) throw Error('转写记录目录须为绝对路径。');
    const result = await operator.transcribeFile({ source, outputDirectory, language, profile, allowExperimental, signal, onProgress });
    signal?.throwIfAborted();
    if (!result?.complete || result.device !== 'cuda' || typeof result.text !== 'string') throw Error('独立 GPU 算子未完成整份音轨转写；AI 总结已暂停。');
    const issue = transcriptQualityIssue(result.text);
    if (issue) throw Object.assign(Error(issue + '；AI 总结已暂停。'), { code: 'SPEECH_UNRELIABLE' });
    return { ...result, outputDirectory };
  }
  async transcodeVideo({ source, outputDirectory = this.videoArchiveDirectory, quality = 'original', hardwareDecode = true,
    forceKeyframeSeconds, signal, onProgress = () => {} } = {}) {
    signal?.throwIfAborted();
    if (![source, outputDirectory].every(value => typeof value === 'string' && path.isAbsolute(value)) ||
        !['original', '1080p', '720p'].includes(quality) || typeof hardwareDecode !== 'boolean' ||
        forceKeyframeSeconds !== undefined && (!Number.isFinite(forceKeyframeSeconds) || forceKeyframeSeconds < .25 || forceKeyframeSeconds > 600)) throw Error('GPU 视频转码参数无效。');
    const operator = this.load();
    if (typeof operator.transcodeVideo !== 'function') throw Error('独立算子尚未提供 GPU 视频转码接口，原片已保留。');
    const result = await operator.transcodeVideo({ source, outputDirectory, quality, hardwareDecode,
      ...(forceKeyframeSeconds !== undefined ? { forceKeyframeSeconds } : {}), signal, onProgress });
    signal?.throwIfAborted();
    if (!result?.complete || result.engine !== 'h264_nvenc' || hardwareDecode && !/_cuvid$/.test(result.decodeEngine || '')) throw Error('GPU 视频转码未返回经过验证的 NVENC/NVDEC 结果，未改用 CPU，原片已保留。');
    if (forceKeyframeSeconds !== undefined && (result.nvenc?.forcedIdr !== true || result.nvenc.forceKeyframeSeconds !== forceKeyframeSeconds)) throw Error('GPU 视频转码未确认实际执行所需关键帧间隔，原片与记录已保留。');
    if (typeof result.path !== 'string' || !path.isAbsolute(result.path) || typeof result.recordDirectory !== 'string' || !path.isAbsolute(result.recordDirectory)) throw Error('GPU 视频转码未返回独立的输出和记录路径，原片已保留。');
    const output = fs.realpathSync(result.path), base = fs.realpathSync(outputDirectory), recordDirectory = fs.realpathSync(result.recordDirectory);
    for (const candidate of [output, recordDirectory]) {
      const relative = path.relative(base, candidate);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('GPU 视频输出不在本次归档目录，原片已保留。');
    }
    if (output === fs.realpathSync(source) || !fs.statSync(output).isFile() || !fs.statSync(output).size) throw Error('GPU 视频输出无效或与原片重合。');
    return { ...result, outputDirectory, ...(forceKeyframeSeconds !== undefined ? { forceKeyframeSeconds: result.nvenc.forceKeyframeSeconds } : {}) };
  }
}
module.exports = { GpuOperatorClient, defaultOperatorDirectory };
