// Used when the user disables automatic DeepSeek summaries. A deliberately
// skipped summary must not turn a successfully drained recording into HTTP 503.
function isMeetingSummary(endpoint, input) {
  return endpoint === 'runMeetingNotesAgent' || endpoint === 'runInferenceTranscript' &&
    Array.isArray(input?.transcript) && input.transcript.some(step => step?.type === 'config' && step.value?.type === 'summarize-transcript');
}
function offlineSummaryResponse(endpoint, log = () => {}) {
  log({ type: 'offline-meeting-summary-skipped', endpoint, reason: 'offline-transcription-only' });
  const event = { type: 'notion-switch-summary-status', status: 'skipped', reason: 'offline-transcription-only',
    message: '离线转写模式已跳过自动总结，不自动上传会议内容；需要总结时可在 AI 侧栏要求 DeepSeek 总结当前页。' };
  return new Response(JSON.stringify(event) + '\n', { headers: {
    'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-notion-switch-summary': 'skipped-offline'
  } });
}
module.exports = { isMeetingSummary, offlineSummaryResponse };
