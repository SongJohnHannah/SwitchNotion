const { modules } = require('../compat/macos-speech-reviewed.json');
const roles = ['audio', 'connection', 'recording'];
function verifiedClient(value, inputMode) {
  if (typeof value !== 'string' || value.length > 512) return false;
  let client; try { client = JSON.parse(value); } catch { return false; }
  return client?.version === 1 && ['meeting', 'microphone'].includes(inputMode) && client.inputMode === inputMode &&
    Object.keys(client).length === 5 && roles.every(kind => Object.values(modules).some(record => record.kind === kind && record.hash === client[kind]));
}

// Embedded into the reviewed connection module. Readiness lives in this
// renderer, so another window's unsupported asset cannot disable this page.
async function requestSpeechToken(environment, request) {
  const showError = message => {
    if (typeof document === 'undefined' || !document.body) return;
    const id = 'notion-switch-speech-error'; document.getElementById(id)?.remove();
    const panel = document.createElement('div'), text = document.createElement('span'), refresh = document.createElement('button');
    panel.id = id; panel.setAttribute('role', 'alert');
    panel.style.cssText = 'position:fixed;bottom:24px;left:24px;z-index:2147483647;max-width:460px;padding:16px;border:1px solid #d5a052;border-radius:8px;background:#fff8e8;color:#382b1b;box-shadow:0 4px 20px #0002;font:14px/1.5 system-ui';
    text.textContent = message; refresh.textContent = '刷新会议页面'; refresh.style.cssText = 'display:block;margin-top:10px;cursor:pointer';
    refresh.addEventListener('click', () => location.reload()); panel.append(text, refresh); document.body.append(panel);
  };
  const state = globalThis.__notionSwitchSpeechClient;
  if (!state?.audio || !state.connection || !state.recording || !state.inputMode) {
    const message = '当前会议页的录音组件尚未加载完整，请刷新会议页面后重试。';
    showError(message); throw Error(message);
  }
  const client = JSON.stringify({ version: 1, audio: state.audio, connection: state.connection, recording: state.recording, inputMode: state.inputMode });
  const result = await environment.api.callApi({ ...request, headers: { ...request.headers, 'x-notion-switch-speech-client': client } });
  if (result.type !== 'success') {
    const message = result.error?.message;
    showError(typeof message === 'string' && /^(?:本机|当前会议|录音)/.test(message) ? message : '会议录音暂时无法连接，请刷新会议页面后重试。');
  } else if (typeof document !== 'undefined') document.getElementById('notion-switch-speech-error')?.remove();
  return result;
}
module.exports = { verifiedClient, requestSpeechToken };
