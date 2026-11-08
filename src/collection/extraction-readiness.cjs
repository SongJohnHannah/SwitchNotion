const { transcriptQualityIssue } = require('../speech/transcript-quality.cjs');
function extractionReadiness(job, nodes) {
  for (const [index, node] of nodes.entries()) {
    if (!['audio', 'video'].includes(node.kind)) continue;
    const asset = job.resources?.[node.id]?.asset, analysis = job.analyses?.[node.id] || {};
    const label = `素材 ${index + 1} 的${node.kind === 'video' ? '视频' : '音频'}`;
    if (!asset?.path) return { deferred: true, stage: 'download', error: `${label}下载未完成；AI 总结已暂停，下载并处理成功后重试。` };
    const textFirst = node.kind === 'video' && job.options.denseOcr && analysis.ocr?.dense && analysis.ocr.text?.trim();
    if (job.options.transcribe && asset.audio !== false && !(analysis.transcript?.text?.trim() || analysis.transcript?.note?.trim()) && !textFirst) return { deferred: true, stage: 'transcript', error: `${label}转写未完成；AI 总结已暂停，转写成功后重试。` };
    if (transcriptQualityIssue(analysis.transcript?.text)) return { deferred: true, stage: 'transcript-quality', error: `${label}逐字稿出现异常重复标点；AI 总结已暂停，请重新转写。` };
    if (![analysis.transcript, analysis.ocr, analysis.vision].some(item => item?.text?.trim())) return { deferred: true, stage: 'evidence', error: `${label}尚无可用逐字稿或画面识别内容；AI 总结已暂停，不使用标题或网页简介代替音视频正文。` };
  }
  return null;
}
module.exports = { extractionReadiness };
