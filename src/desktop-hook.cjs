const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { app, session, BrowserWindow } = require('electron');
const { NativeMock, json } = require('./native-mock.cjs');
const { adaptClient } = require('./client-compat.cjs');
const { localRecords } = require('./local-records.cjs');
const { ProviderRouter } = require('./provider.cjs');
const { NotionRouter } = require('./notion-routing.cjs');
const { nativeModelCatalog } = require('./native-models.cjs');
const { setupSettings, isSettings } = require('./settings-window.cjs');
const { createNativeImageAdapter, describeUploadResponse } = require('./native-images.cjs');
const { NativeSpeech, loopbackCsp } = require('./speech/native.cjs');
const platform = require('./platform/index.cjs').createDesktopPlatform();

const root = process.env.NOTION_SWITCH_ROOT;
if (!root || !path.isAbsolute(root) || !fs.existsSync(path.join(root, 'prepared.json'))) throw new Error('Start the isolated prototype using npm start');
const logFile = path.join(root, 'events.jsonl');
const log = event => fs.appendFileSync(logFile, JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n');
for (const [name, dir] of [['userData', 'profile'], ['sessionData', 'profile'], ['crashDumps', 'crashDumps']]) {
  const location = path.join(root, dir); fs.mkdirSync(location, { recursive: true }); app.setPath(name, location);
}
app.setAppLogsPath(path.join(root, 'logs'));
app.setName('NotionSwitch Prototype');
// Keep the original installation's OS URL association and application identity.
app.setAsDefaultProtocolClient = () => false;
app.removeAsDefaultProtocolClient = () => false;
platform.configureAppIdentity(app);

const provider = new ProviderRouter({ root });
const workspace = new NotionRouter({ root, log });
const mock = new NativeMock({ log, stateFile: path.join(root, 'conversations.local.json'), provider, workspace });
const settings = setupSettings({ root, platform, isBusy: () => mock.status().activeTurns > 0, getCompatibility: () => compatibility });
const nativeSpeech = new NativeSpeech({ speech: settings.speech, log }); settings.speech.native = nativeSpeech;
const installed = new WeakSet();
const cacheReady = new WeakMap();
const compatibility = { adaptedAssets: [], unsupportedAssets: [] };
const endpoints = new Set(['runInferenceTranscript', 'createAgentThread', 'createCalendarAgentThread', 'sendEventToAgentThread', 'sendEventToLegacyThread', 'listenToThreadTranscript', 'stopWorkflowAutomationRunThread']);
function isNotion(hostname) { return hostname === 'notion.so' || hostname.endsWith('.notion.so') || hostname === 'notion.com' || hostname.endsWith('.notion.com'); }
async function route(request, passthrough, ses) {
  const url = new URL(request.url), endpoint = url.pathname.match(/\/api\/v\d+\/([^/]+)/)?.[1] || url.pathname.split('/').pop();
  const upstream = passthrough;
  passthrough = async req => {
    let response = await upstream(req);
    if (nativeSpeech.enabled && nativeSpeech.endpoint && isNotion(url.hostname) && ['content-security-policy', 'content-security-policy-report-only'].some(name => response.headers.has(name))) {
      const headers = new Headers(response.headers);
      for (const name of ['content-security-policy', 'content-security-policy-report-only']) if (headers.has(name)) headers.set(name, loopbackCsp(headers.get(name), nativeSpeech.endpoint));
      for (const name of ['content-length', 'content-encoding']) headers.delete(name);
      response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    if (isNotion(url.hostname) && url.pathname.includes('/api/') && response.status >= 400) log({ type: 'notion-api-status', endpoint, status: response.status });
    if (isNotion(url.hostname) && ['createAgentServiceFileUploadURL', 'completeAgentServiceFileUpload'].includes(endpoint)) {
      try { const shape = describeUploadResponse(endpoint, await request.clone().json(), await response.clone().json()); if (shape) log({ type: 'native-image-upload-shape', ...shape }); } catch {}
    }
    return response;
  };
  if (isNotion(url.hostname) && url.pathname.includes('/api/') && endpoint === 'getAudioProcessorAuthToken' && settings.speech.enabled) {
    try { return json(await nativeSpeech.token()); }
    catch (error) { return json({ message: error.message, status: 503 }, 503); }
  }
  if (isNotion(url.hostname) && url.pathname.includes('/api/') && endpoint === 'runMeetingNotesAgent' && settings.speech.enabled) {
    return json({ name: 'NotionSwitchOfflineSpeech', message: '当前为离线转写模式，不自动连接云端总结。需要总结时，可在 AI 侧栏手动要求 DeepSeek 总结当前页。' }, 503);
  }
  if (isNotion(url.hostname) && endpoint === 'runInferenceTranscript' && settings.speech.enabled) {
    const input = await request.clone().json();
    if (input.transcript?.some(step => step.type === 'config' && step.value?.type === 'summarize-transcript')) return json({ name: 'NotionSwitchOfflineSpeech', message: '离线转写已完成；当前不自动连接云端生成会议总结。可在 AI 侧栏手动要求 DeepSeek 总结当前页。' }, 503);
  }
  if (isNotion(url.hostname) && url.pathname.includes('/api/') && endpoint === 'getAvailableModels' && provider.status().mode === 'deepseek') {
    const input = await request.clone().json();
    if (input.surface !== 'workspace_model_settings') {
      const catalog = nativeModelCatalog();
      log({ type: 'local-model-catalog-served', count: catalog.models.length });
      return json(catalog);
    }
  }
  if (isNotion(url.hostname) && ['syncRecordValues', 'syncRecordValuesSpace', 'syncRecordValuesMain', 'syncRecordValuesSpaceInitial', 'syncRecordValuesSpaceFanout', 'getRecordValues'].includes(endpoint)) {
    return localRecords(request, await request.clone().json(), endpoint, mock, passthrough, log);
  }
  if (isNotion(url.hostname) && url.pathname.includes('/api/') && endpoint === 'getInferenceTranscriptsForUser') {
    const input = await request.clone().json();
    return mock.handle(endpoint, input, request.signal, { userId: request.headers.get('x-notion-active-user-header'), fetchHistory: async data => {
      const headers = new Headers(request.headers); headers.delete('content-length');
      return passthrough(new Request(request, { headers, body: JSON.stringify(data) }));
    } });
  }
  if (isNotion(url.hostname) && ['getThreadSpaceId', 'recordAgentThreadView', 'markInferenceTranscriptSeen'].includes(endpoint)) {
    const input = await request.clone().json(), record = mock.record(input.threadId);
    if (record) return json(endpoint === 'getThreadSpaceId' ? { spaceId: record.space_id } : {});
  }
  if (url.hostname === 'app.notion.com' && /^\/_assets\/(?:95271|96975|32453|17521)-[^/]+\.js$/.test(url.pathname)) {
    const compatAsset = url.pathname.split('/').pop();
    const response = await passthrough(request);
    if (!response.ok) return response;
    const source = await response.text();
    let patched;
    try {
      if (nativeSpeech.enabled) await nativeSpeech.ready;
      patched = adaptClient(source, compatAsset, { localSpeechEnabled: nativeSpeech.enabled, audioEndpoint: nativeSpeech.endpoint });
      if (compatAsset.startsWith('17521-') && nativeSpeech.enabled && patched !== source) nativeSpeech.transportReady = true;
    }
    catch {
      if (!compatibility.unsupportedAssets.includes(compatAsset)) { compatibility.unsupportedAssets.push(compatAsset); log({ type: 'local-provider-ui-unsupported', asset: compatAsset }); }
      return new Response(source, { status: response.status, headers: (() => { const h = new Headers(response.headers); for (const key of ['content-length', 'content-encoding']) h.delete(key); return h; })() });
    }
    const headers = new Headers(response.headers);
    for (const header of ['content-length', 'content-encoding', 'etag', 'content-md5']) headers.delete(header);
    headers.set('cache-control', 'no-store');
    log({ type: 'local-provider-ui-adapted', asset: compatAsset });
    if (!compatibility.adaptedAssets.includes(compatAsset)) compatibility.adaptedAssets.push(compatAsset);
    return new Response(patched, { status: response.status, headers });
  }
  const localRead = ['getThreadTranscript', 'getThreadQueuedMessages', 'listenToThreadTranscript'].includes(endpoint);
  if (isNotion(url.hostname) && url.pathname.includes('/api/') && (localRead || endpoints.has(endpoint) || /^(runInference|create.*Agent.*Thread|sendEventTo.*Thread)/.test(endpoint))) {
    try {
      const input = await request.clone().json();
      if (settings.isLoginSyncing() && /^(?:create|sendEventTo|runInference)/.test(endpoint)) return json({ name: 'NotionSwitchPrototype', message: '本机登录同步正在准备重启，请等待重新打开后继续。' }, 409);
      if (localRead && !mock.owns(input)) return passthrough(request);
      const images = createNativeImageAdapter({
        resolveFile: async ({ spaceId, threadId, fileId, includeFileMetadata, signal }) => {
          if (!ses) throw Error('DeepSeek 原生图片会话不可用，请重试。');
          const headers = { 'content-type': 'application/json' };
          for (const name of ['x-notion-active-user-header', 'x-notion-space-id']) if (request.headers.has(name)) headers[name] = request.headers.get(name);
          const response = await ses.fetch(new URL('/api/v3/getFileContentURLForAgentThread', url.origin).href, { method: 'POST', headers, body: JSON.stringify({ spaceId, threadId, fileId, includeFileMetadata }), credentials: 'include', signal, redirect: 'error', bypassCustomProtocolHandlers: true });
          if (!response.ok) { await response.body?.cancel(); throw Error(`DeepSeek 无法读取原生图片附件（Notion HTTP ${response.status}），请重新上传。`); }
          return response.json();
        },
        fetchImage: (target, options) => ses.fetch(target, { ...options, bypassCustomProtocolHandlers: true })
      });
      return await mock.handle(endpoint, input, request.signal, { userId: request.headers.get('x-notion-active-user-header'), images });
    }
    catch (error) { log({ type: 'adapter-error', endpoint, message: error.message }); return json({ name: 'NotionSwitchPrototype', message: error.message }, 500); }
  }
  return passthrough(request);
}
function install(ses) {
  if (installed.has(ses)) return;
  installed.add(ses);
  // Service-worker responses can bypass custom protocol handlers entirely.
  // Clear derived assets before the first navigation, keeping cookies and
  // local/IndexedDB workspace data intact in this isolated profile.
  cacheReady.set(ses, app.whenReady().then(async () => {
    await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    await ses.clearCache();
    log({ type: 'prototype-asset-cache-cleared' });
  }));
  const handle = ses.protocol.handle.bind(ses.protocol);
  // Wrap later protocol registrations too, preserving Notion's own handler as fallback.
  ses.protocol.handle = (scheme, handler) => handle(scheme, scheme === 'https' ? request => route(request, handler, ses) : handler);
  handle('https', request => route(request, req => ses.fetch(req, { bypassCustomProtocolHandlers: true }), ses));
  log({ type: 'session-hook-installed' });
}
app.on('session-created', install);
app.on('before-quit', () => { try { mock.agent.save(); } catch { log({ type: 'local-conversation-save-failed' }); } });
app.on('web-contents-created', (_event, contents) => {
  if (isSettings(contents)) return;
  install(contents.session);
  const loadURL = contents.loadURL.bind(contents);
  contents.loadURL = async (...args) => {
    await cacheReady.get(contents.session);
    return loadURL(...args);
  };
  try {
    contents.debugger.attach('1.3');
    contents.debugger.on('message', (_event, method, params) => {
      if (method === 'Runtime.consoleAPICalled') for (const arg of params.args || []) {
        if (arg.subtype === 'error' && /^(TypeError|ReferenceError|SyntaxError):/.test(arg.description || '')) log({ type: 'renderer-exception', detail: arg.description.slice(0, 4000) });
      }
    });
    contents.debugger.sendCommand('Runtime.enable').catch(() => {});
    // A restored Notion service worker can serve an unadapted asset without
    // reaching protocol.handle. Keep this isolated prototype on the network
    // path so the hash-checked compatibility patch runs on every launch.
    contents.debugger.sendCommand('Network.enable').then(() => Promise.all([
      contents.debugger.sendCommand('Network.setBypassServiceWorker', { bypass: true }),
      contents.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true })
    ])).then(() => log({ type: 'prototype-asset-cache-bypassed' }))
      .catch(() => log({ type: 'prototype-asset-cache-bypass-failed' }));
  } catch {}
  contents.on('did-fail-load', (_event, code, description, url, mainFrame) => { if (mainFrame) log({ type: 'load-failed', code, description, origin: (() => { try { return new URL(url).origin; } catch { return 'unknown'; } })() }); });
  contents.on('did-finish-load', () => { let origin; try { origin = new URL(contents.getURL()).origin; } catch { origin = 'unknown'; } log({ type: 'page-loaded', origin }); });
});
app.on('browser-window-created', (_event, win) => {
  if (isSettings(win.webContents)) return;
  // The isolated test launcher runs hidden; show the app's own workspace when ready.
  win.once('ready-to-show', () => win.show());
  win.webContents.on('page-title-updated', (event, title) => { event.preventDefault(); win.setTitle(`NotionSwitch Prototype — ${title}`); });
});

const token = crypto.randomBytes(32).toString('hex');
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
  res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
  if (req.url === '/status' && req.method === 'GET') {
    const state = mock.status(), speechBusy = settings.speech.provider.leases > 0 || settings.speech.provider.status().busy;
    res.end(JSON.stringify({ pid: process.pid, appReady: app.isReady(), windows: BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), minimized: win.isMinimized(), destroyed: win.isDestroyed() })), ...state,
      activeTurns: state.activeTurns + (speechBusy ? 1 : 0), compatibility, notion: workspace.status(), settings: settings.status(), speech: { ...settings.speech.status(), native: nativeSpeech.status() } }));
  }
  else if (req.url === '/updates/status' && req.method === 'GET') res.end(JSON.stringify(await settings.updateStatus()));
  else if (req.url === '/settings/open' && req.method === 'POST') {
    try { await settings.open(); res.end(JSON.stringify({ opened: true })); }
    catch { res.writeHead(500).end(JSON.stringify({ error: '无法打开配置窗口，请重新启动 NotionSwitch。' })); }
  }
  else if (req.url === '/notion/open' && req.method === 'POST') {
    try { const opened = await settings.openNotion(); res.writeHead(opened ? 200 : 503).end(JSON.stringify({ opened })); }
    catch { res.writeHead(500).end(JSON.stringify({ error: '无法打开 Notion，请稍后重试。' })); }
  }
  else if (req.url === '/quit' && req.method === 'POST') { res.end(JSON.stringify({ quitting: true })); setTimeout(() => app.quit(), 50); }
  else { res.writeHead(404).end(JSON.stringify({ error: 'Unknown route' })); }
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(root, 'control.json'), JSON.stringify({ port: server.address().port, pid: process.pid, token }));
  log({ type: 'control-ready', mode: provider.status().mode });
});
app.whenReady().then(() => { install(session.defaultSession); log({ type: 'native-app-ready', electron: process.versions.electron }); });
app.on('will-quit', () => { nativeSpeech.close(); server.close(); log({ type: 'prototype-quit' }); });
log({ type: 'hook-loaded', originalStartupContinues: true });
