const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { app, session, BrowserWindow, dialog } = require('electron');
const platform = require('./platform/index.cjs').createDesktopPlatform();
const { initializeRuntime, disableBuiltinUpdates } = require('./runtime-bootstrap.cjs');
const root = initializeRuntime({ app, dialog, platform });
if (!root) return;
disableBuiltinUpdates(root);
const { NativeMock, json } = require('./native-mock.cjs');
const { adaptResponse } = require('./compat/response.cjs');
const { localRecords } = require('./local-records.cjs');
const { ProviderRouter } = require('./provider.cjs');
const { NotionRouter } = require('./notion-routing.cjs');
const { nativeModelCatalog } = require('./native-models.cjs');
const { setupSettings, isSettings } = require('./settings-window.cjs');
const { createNativeImageAdapter, describeUploadResponse } = require('./native-images.cjs');
const { NativeSpeech, loopbackCsp } = require('./speech/native.cjs');
const { isMeetingSummary, offlineSummaryResponse } = require('./speech/summary.cjs');
const { MeetingNativeBridge } = require('./meeting-summary-native.cjs');
const { MeetingSummaryService } = require('./meeting-summary.cjs');
const { MeetingRecordings } = require('./meeting-recordings.cjs');
const { uuid } = require('./native-context.cjs');
const logFile = path.join(root, 'events.jsonl');
const log = event => fs.appendFileSync(logFile, JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n');
for (const [name, dir] of [['userData', 'profile'], ['sessionData', 'profile'], ['crashDumps', 'crashDumps']]) {
  const location = path.join(root, dir); fs.mkdirSync(location, { recursive: true }); app.setPath(name, location);
}
app.setAppLogsPath(path.join(root, 'logs'));
app.setName(platform.id === 'darwin' && fs.existsSync(path.join(root, 'profile', '.notion-switch-use-original-keychain')) ? 'Notion' : 'Switch Notion');
// Keep the original installation's OS URL association and application identity.
app.setAsDefaultProtocolClient = () => false;
app.removeAsDefaultProtocolClient = () => false;
platform.configureAppIdentity(app);

const provider = new ProviderRouter({ root });
const meetingBridge = new MeetingNativeBridge();
const meetingSummaries = new MeetingSummaryService({ root, provider, log,
  storeFactory: (info, meta) => meta.store || meetingBridge.forRequest(meta.request, meta.session, info.spaceId) });
const workspace = new NotionRouter({ root, log });
const mock = new NativeMock({ log, stateFile: path.join(root, 'conversations.local.json'), provider, workspace });
let recordings;
const settings = setupSettings({ root, platform, isBusy: () => mock.status().activeTurns > 0 || meetingSummaries.active > 0 || recordings?.active > 0, getCompatibility: () => compatibility });
recordings = new MeetingRecordings({ root, provider: settings.speech.provider, enabled: () => settings.speech.autoAttachAudio,
  storeFactory: (info, signal) => meetingBridge.forRecording(info, signal), log });
settings.speech.audioImports = recordings;
const nativeSpeech = new NativeSpeech({ speech: settings.speech, recordings, log }); settings.speech.native = nativeSpeech;
const installed = new WeakSet();
const cacheReady = new WeakMap();
const compatibility = { adaptedAssets: [], automaticAssets: [], unsupportedAssets: [] };
const endpoints = new Set(['runInferenceTranscript', 'createAgentThread', 'createCalendarAgentThread', 'sendEventToAgentThread', 'sendEventToLegacyThread', 'listenToThreadTranscript', 'stopWorkflowAutomationRunThread']);
function isNotion(hostname) { return hostname === 'notion.so' || hostname.endsWith('.notion.so') || hostname === 'notion.com' || hostname.endsWith('.notion.com'); }
async function route(request, passthrough, ses) {
  const url = new URL(request.url), endpoint = url.pathname.match(/\/api\/v\d+\/([^/]+)/)?.[1] || url.pathname.split('/').pop();
  meetingBridge.observe(request, ses);
  recordings.wake();
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
    try { return json(await nativeSpeech.token({ userId: uuid(request.headers.get('x-notion-active-user-header')) })); }
    catch (error) { return json({ message: error.message, status: 503 }, 503); }
  }
  if (isNotion(url.hostname) && url.pathname.includes('/api/') && settings.speech.enabled && ['runMeetingNotesAgent', 'runInferenceTranscript'].includes(endpoint)) {
    const input = await request.clone().json();
    if (isMeetingSummary(endpoint, input)) return settings.speech.autoSummary === false ? offlineSummaryResponse(endpoint, log) :
      meetingSummaries.handle(endpoint, input, request.signal, { request, session: ses });
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
  if (url.hostname === 'app.notion.com' && /^\/_assets\/\d+-[a-f\d]{16}\.js$/.test(url.pathname)) {
    const compatAsset = url.pathname.split('/').pop();
    const response = await passthrough(request);
    if (!response.ok) return response;
    let adapted;
    try {
      adapted = await adaptResponse(response, compatAsset, { localSpeechEnabled: nativeSpeech.enabled, audioEndpoint: nativeSpeech.endpoint, inputMode: settings.speech.inputMode,
        prepare: async () => { if (nativeSpeech.enabled) await nativeSpeech.ready; } });
      if (adapted === null) return response;
      if (adapted.kinds.includes('audio') && nativeSpeech.enabled && adapted.changed) nativeSpeech.transportReady = true;
      if (adapted.kinds.includes('recording') && nativeSpeech.enabled && adapted.changed) nativeSpeech.lifecycleReady = true;
      if (adapted.kinds.includes('connection') && nativeSpeech.enabled) nativeSpeech.drainTransportReady = true;
    }
    catch {
      nativeSpeech.lifecycleReady = false;
      if (!compatibility.unsupportedAssets.includes(compatAsset)) { compatibility.unsupportedAssets.push(compatAsset); log({ type: 'local-provider-ui-unsupported', asset: compatAsset }); }
      return response;
    }
    log({ type: 'local-provider-ui-adapted', asset: compatAsset });
    if (!compatibility.adaptedAssets.includes(compatAsset)) compatibility.adaptedAssets.push(compatAsset);
    if (adapted.automatic.length && !compatibility.automaticAssets.includes(compatAsset)) {
      compatibility.automaticAssets.push(compatAsset); log({ type: 'local-provider-ui-auto-adapted', asset: compatAsset, modules: adapted.automatic });
    }
    return adapted.response;
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
    const state = mock.status(), speechBusy = settings.speech.provider.leases > 0 || settings.speech.provider.status().busy || nativeSpeech.connections.size > 0;
    res.end(JSON.stringify({ pid: process.pid, appReady: app.isReady(), windows: BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), minimized: win.isMinimized(), destroyed: win.isDestroyed() })), ...state,
      activeTurns: state.activeTurns + (speechBusy ? 1 : 0) + meetingSummaries.active + recordings.active, meetingSummaries: meetingSummaries.status(), meetingContexts: meetingBridge.contexts.length,
      compatibility, notion: workspace.status(), settings: settings.status(), speech: { ...settings.speech.status(), native: nativeSpeech.status() } }));
  }
  else if (['/meetings/inspect', '/meetings/summarize'].includes(req.url) && req.method === 'POST') {
    const abort = new AbortController(); res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    let counted = false;
    try {
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 4096) throw Error('会议操作参数过长。'); }
      const input = JSON.parse(text), pageId = uuid(input.pageId);
      if (!pageId || input.summaryTabId !== undefined && !uuid(input.summaryTabId) || Object.keys(input).some(k => !['pageId', 'meetingId', 'summaryTabId'].includes(k))) throw Error('请提供有效的会议页面链接。');
      const store = await meetingBridge.forPage(pageId, abort.signal), ids = await store.findMeetings(pageId, abort.signal);
      if (req.url === '/meetings/inspect') {
        const meetings = [];
        for (const id of ids.slice(0, 20)) {
          const snapshot = await store.load(id, abort.signal), pending = [];
          for (const job of meetingSummaries.jobs.values()) if (job.scope === `${store.spaceId}:${id}` && ['submitted', 'uncertain'].includes(job.status)) {
            const records = await store.records(job.plan.blocks.map(b => b.id), abort.signal);
            pending.push({ key: job.key, existingPlannedRecords: records.size, linked: snapshot.meeting.format?.transcription_summary_id === job.plan.tabId });
          }
          meetings.push({ meetingId: id, hasSummary: !!snapshot.meeting.format?.transcription_summary_id, notesChars: snapshot.notes.length, transcriptChars: snapshot.transcript.length, pending });
        }
        res.end(JSON.stringify({ workspaceId: store.spaceId, meetings }));
      } else {
        const meetingId = input.meetingId ? uuid(input.meetingId) : ids.length === 1 ? ids[0] : null;
        if (!meetingId || !ids.includes(meetingId)) throw Error('页面中有多个会议，请指定其中一场会议后再生成。');
        meetingSummaries.active++; counted = true;
        const result = await meetingSummaries.run({ spaceId: store.spaceId, meetingId, tabId: uuid(input.summaryTabId) || crypto.randomUUID(), language: 'auto', template: 'auto' }, abort.signal, { store });
        res.end(JSON.stringify({ verified: result.ok, reused: !!result.reused, summaryTabId: result.tabId, recordCount: Object.keys(result.recordMap.block || {}).length }));
      }
    } catch (error) { res.writeHead(400).end(JSON.stringify({ error: /^(?:会议|此前会议|该摘要|当前|页面|同一摘要|生成|无法读取|所选|暂不支持|请先|请提供|DeepSeek)/.test(error.message || '') ? error.message : '会议笔记操作未完成，请在原型中打开该页面后重试。' })); }
    finally { if (counted) meetingSummaries.active--; }
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
app.on('will-quit', () => { recordings.close(); meetingSummaries.close(); nativeSpeech.close(); server.close(); log({ type: 'prototype-quit' }); });
log({ type: 'hook-loaded', originalStartupContinues: true });
