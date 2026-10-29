const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { app, session, BrowserWindow, dialog, Notification, ipcMain, Menu, MenuItem, shell } = require('electron');
const platform = require('./platform/index.cjs').createDesktopPlatform();
const { initializeRuntime, disableBuiltinUpdates } = require('./runtime-bootstrap.cjs');
const root = initializeRuntime({ app, dialog, platform });
if (!root) return;
disableBuiltinUpdates(root);
const { NativeMock, json } = require('./native-mock.cjs');
const { NativeWriter } = require('./native-writer.cjs');
const { createInlineReferenceReader } = require('./inline-references.cjs');
const { adaptResponse } = require('./compat/response.cjs');
const { localRecords } = require('./local-records.cjs');
const { ProviderRouter } = require('./provider.cjs');
const { WebSources } = require('./web-sources.cjs');
const { WorkspaceMemory } = require('./workspace-memory.cjs');
const { AiExtensions } = require('./ai-extensions.cjs');
const { McpOAuth } = require('./mcp-oauth.cjs');
const { AiBrowser } = require('./ai-browser.cjs');
const { attachmentType } = require('./media-transcript.cjs');
const { resolveNativeInstructions } = require('./native-instructions.cjs');
const { openNativeCalendar } = require('./native-calendar.cjs');
const { CalendarConnection } = require('./calendar-connection.cjs');
const { CalendarWrites } = require('./calendar-writes.cjs');
const { BackgroundAgents } = require('./background-agents.cjs');
const { AiTransfer } = require('./ai-transfer.cjs');
const { PageFiles } = require('./page-files.cjs');
const { openNativePageFiles } = require('./native-page-files.cjs');
const { GeneratedFiles: SharedGeneratedFiles, xml: escapeFileText } = require('./generated-files.cjs');
const macFileDownloads = platform.id === 'darwin' ? require('./compat/macos-generated-files.cjs') : null;
const GeneratedFiles = macFileDownloads?.MacGeneratedFiles || SharedGeneratedFiles;
const { NotionRouter } = require('./notion-routing.cjs');
const { nativeModelCatalog } = require('./native-models.cjs');
const { setupSettings, isSettings, createAuxiliaryWindow } = require('./settings-window.cjs');
const { createNativeImageAdapter, describeUploadResponse } = require('./native-images.cjs');
const { LocalImageUploads, prefix: localUploadPrefix } = require('./local-image-uploads.cjs');
const { LocalDocumentUploads, prefix: localDocumentUploadPrefix, previewPrefix: localDocumentPreviewPrefix } = require('./local-document-uploads.cjs');
const { createNativeAttachmentAdapter } = require('./native-attachments.cjs');
const { LocalInlineDocuments, uploadPrefix: inlineDocumentUploadPrefix, referencePrefix: inlineDocumentReferencePrefix } = require('./local-inline-documents.cjs');
const { generateAiBlock } = require('./native-ai-block.cjs');
const { NativeAutofillStore } = require('./native-autofill-store.cjs');
const { createAutofillJobs, isLocalId: isLocalAutofillId } = require('./native-autofill-jobs.cjs');
const { createNativeBuildService } = require('./native-build-service.cjs');
const { NativeBuildStore } = require('./native-database-build-store.cjs');
const { setupDatabaseWizard, wizardEntryScript } = require('./database-wizard-window.cjs');
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
const webSources = new WebSources({ root });
const memory = new WorkspaceMemory({ root });
const approveAi = async ({ title, message, detail, signal }) => {
  signal?.throwIfAborted(); await app.whenReady();
  const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && !isSettings(window.webContents));
  if (!parent || parent.isDestroyed()) return false;
  const result = await dialog.showMessageBox(parent, { type: 'question', title, message, detail, buttons: ['取消', '允许本次'], defaultId: 0, cancelId: 0, noLink: true, ...(signal ? { signal } : {}) });
  signal?.throwIfAborted(); return result.response === 1;
};
const aiBrowser = new AiBrowser({ createWindow: createAuxiliaryWindow, ready: () => app.whenReady(), approve: approveAi });
const calendarConnection = new CalendarConnection({ createWindow: createAuxiliaryWindow, ready: () => app.whenReady() });
const calendarWrites = new CalendarWrites({ root, connection: calendarConnection, approve: approveAi });
app.on('will-quit', () => calendarConnection.close());
const mcpOAuth = new McpOAuth({ openBrowser: async url => { await app.whenReady(); await shell.openExternal(url); } });
app.on('will-quit', () => mcpOAuth.close());
const extensions = new AiExtensions({ root, memory, browser: aiBrowser, oauth: mcpOAuth, approve: approveAi });
const generatedFiles = new GeneratedFiles({ root, printPdf: async (title, text, signal) => {
  signal?.throwIfAborted(); await app.whenReady();
  const window = createAuxiliaryWindow({ show: false, webPreferences: { partition: 'notion-switch-pdf-' + crypto.randomUUID(), nodeIntegration: false, contextIsolation: true, sandbox: true, javascript: false } });
  const stop = () => { if (!window.isDestroyed()) window.destroy(); }; signal?.addEventListener('abort', stop, { once: true });
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>' + escapeFileText(title) + '</title><style>@page{size:A4;margin:18mm}body{font:12pt/1.65 system-ui,sans-serif;color:#202020}main{white-space:pre-wrap;overflow-wrap:anywhere}</style><main>' + escapeFileText(text) + '</main>'));
    signal?.throwIfAborted(); const bytes = await window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: 'A4' }); signal?.throwIfAborted(); return bytes;
  } finally { signal?.removeEventListener('abort', stop); stop(); }
} });
extensions.generatedFiles = generatedFiles;
app.on('will-quit', () => aiBrowser.close());
const meetingBridge = new MeetingNativeBridge();
const autofill = createAutofillJobs({ root, provider, log,
  storeFactory: (info, meta) => new NativeAutofillStore({ native: meetingBridge.forRequest(meta.request, meta.session, info.spaceId), workspace, webSources }) });
const meetingSummaries = new MeetingSummaryService({ root, provider, log,
  storeFactory: (info, meta) => meta.store || meetingBridge.forRequest(meta.request, meta.session, info.spaceId) });
const workspace = new NotionRouter({ root, log });
extensions.pageFiles = new PageFiles({ workspace, parseContent: (...args) => mediaTranscripts.parse(...args) });
const mock = new NativeMock({ log, stateFile: path.join(root, 'conversations.local.json'), provider, workspace, webSources, memory, extensions, workspaceResearch: true,
  inlineReferences: createInlineReferenceReader({ workspace, resolveFile: ({ blockId, pageId, propertyId, fileIndex, spaceId, signal, session, maxBytes }) =>
    extensions.pageFiles.open({ spaceId, signal, session, maxBytes }).execute('read_notion_file', pageId ? { page_id: pageId, property_id: propertyId, file_index: fileIndex } : { block_id: blockId }) }) });
const backgroundAgents = new BackgroundAgents({ root, memory, provider, workspace, extensions, notify: ({ title, status }) => {
  if (Notification.isSupported()) new Notification({ title: 'Notion AI · ' + title, body: status === 'completed' ? '后台任务已完成，请在工作区配置中查看结果。' : '后台任务需要处理，请在工作区配置中查看。' }).show();
} });
app.whenReady().then(() => backgroundAgents.start());
app.on('will-quit', () => backgroundAgents.close());
const transfer = new AiTransfer({ memory, agent: mock.agent, native: mock, approve: approveAi,
  chooseSave: async (defaultPath, { format = 'json' } = {}) => { const result = await dialog.showSaveDialog({ title: format === 'html' ? '保存只读共享对话' : '导出当前工作区 AI 数据', defaultPath, filters: [{ name: format === 'html' ? '只读对话 HTML' : 'Notion AI 数据', extensions: [format] }] }); return result.canceled ? null : result.filePath; },
  chooseOpen: async () => { const result = await dialog.showOpenDialog({ title: '导入同一工作区 AI 数据', properties: ['openFile'], filters: [{ name: 'Notion AI 数据', extensions: ['json'] }] }); return result.canceled ? null : result.filePaths[0]; }
});
const databaseBuild = createNativeBuildService({ root, provider, log,
  storeFactory: (info, meta) => new NativeBuildStore({ native: meetingBridge.forRequest(meta.request, meta.session, info.spaceId) }) });
const databaseWizard = setupDatabaseWizard({ root, provider, bridge: meetingBridge, createWindow: createAuxiliaryWindow, app, ipcMain, Menu, MenuItem, shell });
const nativeWriter = new NativeWriter({ root, provider, log,
  hasRecord: id => mock.hasRecord(id) || databaseBuild.owns({ threadId: id }),
  storeFactory: (info, meta) => meetingBridge.forRequest(meta.request, meta.session, info.spaceId) });
app.on('before-quit', () => nativeWriter.close());
const aiRecords = { record: (id, table, scope) => nativeWriter.record(id, table, scope) || databaseBuild.record(id, table, scope) || autofill.record(id, table, scope) || mock.record(id, table, scope),
  hasRecord: (id, table) => !!nativeWriter.record(id, table) || mock.hasRecord(id, table) || !!databaseBuild.findRecord?.(id, table) || !!databaseBuild.previewOwner?.(id, table) ||
    ['workflow_automation_run', 'task_output'].includes(table) && !!autofill.find?.(id),
  recordRole: (id, table, scope) => databaseBuild.recordRole(id, table, scope) };
const localImages = new LocalImageUploads({ root, owns: input => mock.owns(input), record: id => mock.record(id) });
const localDocuments = new LocalDocumentUploads({ root, fileType: attachmentType, record: (id, scope) => mock.record(id, 'thread', scope) });
const localInlineDocuments = new LocalInlineDocuments({ root, store: localDocuments, fileType: attachmentType, parseContent: (...args) => mediaTranscripts.parse(...args), reserve: scope => {
  if (nativeWriter.owns({ threadId: scope.threadId }) || databaseBuild.owns({ threadId: scope.threadId })) throw Error('Notion 浮动附件不能使用建库或原生续写对话。');
  mock.reserveInlineUpload(scope);
} });
let recordings;
const settings = setupSettings({ root, platform, webSources, memory, extensions, backgroundAgents, transfer, isBusy: () => nativeWriter.active > 0 || calendarWrites.active > 0 || databaseWizard.service.active > 0 || backgroundAgents.active > 0 || mock.status().activeTurns > 0 || databaseBuild.active > 0 || autofill.active > 0 || meetingSummaries.active > 0 || recordings?.active > 0, getCompatibility: () => compatibility });
const mediaTranscripts = settings.mediaTranscripts;
recordings = new MeetingRecordings({ root, provider: settings.speech.provider, enabled: () => settings.speech.autoAttachAudio,
  storeFactory: (info, signal) => meetingBridge.forRecording(info, signal), log });
settings.speech.audioImports = recordings;
const nativeSpeech = new NativeSpeech({ speech: settings.speech, recordings, log }); settings.speech.native = nativeSpeech;
const installed = new WeakSet();
const cacheReady = new WeakMap();
const compatibility = { adaptedAssets: [], automaticAssets: [], unsupportedAssets: [] };
const endpoints = new Set(['runWriter', 'undoAgentServiceTurn', 'runInferenceTranscript', 'createAgentThread', 'createCalendarAgentThread', 'sendEventToAgentThread', 'sendEventToLegacyThread', 'listenToThreadTranscript', 'stopWorkflowAutomationRunThread']);
function isNotion(hostname) { return hostname === 'notion.so' || hostname.endsWith('.notion.so') || hostname === 'notion.com' || hostname.endsWith('.notion.com'); }
async function route(request, passthrough, ses) {
  const url = new URL(request.url), endpoint = url.pathname.match(/\/api\/v\d+\/([^/]+)/)?.[1] || url.pathname.split('/').pop();
  if (isNotion(url.hostname) && url.pathname === '/_notion-switch/database-wizard/open' && typeof databaseWizard !== 'undefined') {
    if (request.method !== 'POST' || request.headers.get('x-notion-switch-ui') !== 'database-wizard-v1') return json({ ok: false }, 403);
    try {
      const text = await request.text(); if (text.length > 4096) throw Error('请求过长。');
      const input = JSON.parse(text); await databaseWizard.open({ session: ses, pageId: uuid(input?.pageId) }); return json({ ok: true });
    } catch (error) { return json({ ok: false, message: /^Notion /.test(error.message || '') ? error.message : '建库向导打开失败，请从应用菜单重试。' }, 400); }
  }
  if (isNotion(url.hostname) && typeof localInlineDocuments !== 'undefined') {
    if (url.pathname.startsWith(inlineDocumentUploadPrefix)) return localInlineDocuments.post(request);
    if (url.pathname.startsWith(inlineDocumentReferencePrefix)) return localInlineDocuments.download(request);
    if (url.pathname.includes('/api/') && endpoint === 'getUploadFileUrlForAssistantChatTranscriptUpload') {
      const input = await request.clone().json();
      if (localDocuments.handles(input.name)) {
        try { return json(localInlineDocuments.create(input, request.headers.get('x-notion-active-user-header'), url.origin)); }
        catch (error) { return json({ name: 'NotionSwitchInlineDocument', message: error.message }, 400); }
      }
    }
    if (url.pathname.includes('/api/') && endpoint === 'processAgentAttachment') {
      const input = await request.clone().json();
      if (localInlineDocuments.handles(input.url)) {
        if (request.headers.get('x-notion-switch-inline-documents-client') !== '1') return json({ name: 'NotionSwitchInlineDocument', message: 'Notion 当前附件客户端接口尚未审核，请更新后重新上传。' }, 409);
        try { return json(await localInlineDocuments.process(input, request.headers.get('x-notion-active-user-header'), url.origin, request.signal)); }
        catch (error) { return json({ name: 'NotionSwitchInlineDocument', message: error.message }, 400); }
      }
    }
  }
  if (isNotion(url.hostname)) {
    if (typeof generatedFiles !== 'undefined' && url.pathname.startsWith('/notion-switch-generated/')) return generatedFiles.serve(request);
    if (typeof localDocuments !== 'undefined' && url.pathname.startsWith(localDocumentPreviewPrefix)) return localDocuments.preview(request);
    if (url.pathname.startsWith('/notion-switch-local-image/') || url.pathname.startsWith('/image/')) {
      const preview = localImages.preview(request); if (preview) return preview;
    }
    if (url.pathname.includes('/api/') && endpoint === 'getFileContentURLForAgentThread') {
      const input = await request.clone().json();
      if (typeof localDocuments !== 'undefined' && localDocuments.hasFile(input.fileId)) {
        try { return json(localDocuments.resolve(input, request.headers.get('x-notion-active-user-header'), url.origin)); }
        catch { return json({ message: '无法读取当前对话的文档附件。' }, 404); }
      }
      if (localImages.hasFile(input.fileId)) {
        try { return json(localImages.resolve(input, request.headers.get('x-notion-active-user-header'), url.origin)); }
        catch { return json({ message: '无法读取当前对话的图片附件。' }, 404); }
      }
    }
  }
  if (typeof localDocuments !== 'undefined' && isNotion(url.hostname) && url.pathname.startsWith(localDocumentUploadPrefix))
    return localDocuments.put(url.pathname.slice(localDocumentUploadPrefix.length), request);
  if (isNotion(url.hostname) && url.pathname.startsWith(localUploadPrefix)) {
    return localImages.put(url.pathname.slice(localUploadPrefix.length), request);
  }
  if (isNotion(url.hostname) && url.pathname.includes('/api/') && ['createAgentServiceFileUploadURL', 'completeAgentServiceFileUpload'].includes(endpoint)) {
    try {
      const input = await request.clone().json(), user = request.headers.get('x-notion-active-user-header');
      if (typeof localDocuments !== 'undefined') {
        if (endpoint === 'createAgentServiceFileUploadURL' && localDocuments.handles(input.filename) && localDocuments.handlesTarget(input.target)) return json(localDocuments.create(input, user, url.origin));
        if (endpoint === 'completeAgentServiceFileUpload' && (localDocuments.hasPending(input.fileId) || localDocuments.hasFile(input.fileId))) return json(localDocuments.complete(input, user));
      }
      if (endpoint === 'createAgentServiceFileUploadURL' && localImages.handlesTarget(input.target) &&
          ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(input.mediaType)) return json(localImages.create(input, user, url.origin));
      if (endpoint === 'completeAgentServiceFileUpload' && localImages.hasPending(input.fileId)) return json(localImages.complete(input, user));
    } catch (error) { return json({ name: 'NotionSwitchImageUpload', message: error.message }, 400); }
  }
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
  if (isNotion(url.hostname) && url.pathname.includes('/api/') &&
      ['triggerLiteAgentAutofill', 'triggerAgentOverCollection', 'notionSwitchGetAutofillStatus', 'markWorkflowAutomationRunCancelled'].includes(endpoint)) {
    const input = await request.clone().json(), localControl = endpoint === 'notionSwitchGetAutofillStatus' || endpoint === 'markWorkflowAutomationRunCancelled' && isLocalAutofillId(input.runId);
    if (localControl || endpoint.startsWith('trigger')) {
      if (!localControl && provider.status().mode !== 'deepseek')
        return json({ name: 'NotionSwitchAutofill', message: 'Notion Autofill 请先在配置中启用 DeepSeek。' }, 400);
      if (!localControl && request.headers.get('x-notion-switch-autofill-client') !== '1')
        return json({ name: 'NotionSwitchAutofill', message: 'Notion Autofill 客户端尚未通过适配，请重新加载页面；本次未转交 Notion 托管 AI。' }, 501);
      const response = await autofill.handle(endpoint, input, request.signal, { request, session: ses,
        userId: request.headers.get('x-notion-active-user-header') });
      if (response) return response;
    }
  }
  if (isNotion(url.hostname) && url.pathname.includes('/api/') && endpoint === 'getAudioProcessorAuthToken' && settings.speech.enabled) {
    try { return json(await nativeSpeech.token({ userId: uuid(request.headers.get('x-notion-active-user-header')) })); }
    catch (error) { return json({ message: error.message, status: 503 }, 503); }
  }
  if (isNotion(url.hostname) && url.pathname.includes('/api/') && settings.speech.enabled && ['runMeetingNotesAgent', 'runInferenceTranscript'].includes(endpoint)) {
    const input = await request.clone().json();
    if (isMeetingSummary(endpoint, input)) return settings.speech.autoSummary === false ? offlineSummaryResponse(endpoint, log) :
      meetingSummaries.handle(endpoint, input, request.signal, { request, session: ses });
  }
  if (typeof databaseBuild !== 'undefined' && isNotion(url.hostname) && url.pathname.includes('/api/') &&
      ['saveTransactionsFanout', 'queryCollection', 'runInferenceTranscript', 'stopWorkflowAutomationRunThread'].includes(endpoint)) {
    const input = await request.clone().json(), meta = { request, session: ses, userId: request.headers.get('x-notion-active-user-header') };
    if (endpoint === 'saveTransactionsFanout') { const response = await databaseBuild.transactions(input, request.signal, meta); if (response) return response; }
    if (endpoint === 'queryCollection') { const response = databaseBuild.previewQuery(input, meta); if (response) return response; }
    if (endpoint === 'runInferenceTranscript' && databaseBuild.accepts(input)) {
      if (!databaseBuild.owns(input) && mock.hasRecord(input.threadId, 'thread')) return json({ message: '此对话属于其他本地 AI 入口，请新建建库对话。' }, 409);
      if (settings.isLoginSyncing()) return json({ message: '本机登录同步正在准备重启，请等待重新打开后继续。' }, 409);
      return databaseBuild.stream(input, request.signal, meta);
    }
    if (endpoint === 'stopWorkflowAutomationRunThread' && databaseBuild.owns(input)) return databaseBuild.stop(input, meta);
  }
  if (isNotion(url.hostname) && url.pathname.includes('/api/') && endpoint === 'getAvailableModels' && provider.status().mode === 'deepseek') {
    const input = await request.clone().json();
    if (input.surface !== 'workspace_model_settings') {
      const catalog = nativeModelCatalog();
      log({ type: 'local-model-catalog-served', count: catalog.models.length });
      return json(catalog);
    }
  }
  if (isNotion(url.hostname) && url.pathname.includes('/api/') && endpoint === 'saveTransactionsFanout') {
    const input = await request.clone().json(), response = mock.transactions?.(input, { userId: request.headers.get('x-notion-active-user-header') });
    if (response) return response;
  }
  if (isNotion(url.hostname) && ['syncRecordValues', 'syncRecordValuesSpace', 'syncRecordValuesMain', 'syncRecordValuesSpaceInitial', 'syncRecordValuesSpaceFanout', 'getRecordValues'].includes(endpoint)) {
    return localRecords(request, await request.clone().json(), endpoint, aiRecords, passthrough, log);
  }
  if (isNotion(url.hostname) && url.pathname.includes('/api/') && endpoint === 'getInferenceTranscriptsForUser') {
    const input = await request.clone().json();
    const historyAgent = typeof databaseBuild !== 'undefined' ? {
      threads: new Map([...mock.historyThreads(), ...databaseBuild.historyThreads()]),
      record: id => databaseBuild.historyRecord(id) || mock.historyRecord(id)
    } : { threads: mock.historyThreads(), record: id => mock.historyRecord(id) };
    if (typeof nativeWriter !== 'undefined' && input.includeWriterChats === true) {
      historyAgent.threads = new Map([...historyAgent.threads, ...nativeWriter.events.threads]);
      const historyRecord = historyAgent.record;
      historyAgent.record = id => nativeWriter.record(id) || historyRecord(id);
    }
    return mock.handle(endpoint, input, request.signal, { historyAgent, userId: request.headers.get('x-notion-active-user-header'), fetchHistory: async data => {
      const headers = new Headers(request.headers); headers.delete('content-length');
      return passthrough(new Request(request, { headers, body: JSON.stringify(data) }));
    } });
  }
  if (isNotion(url.hostname) && ['getThreadSpaceId', 'recordAgentThreadView', 'markInferenceTranscriptSeen'].includes(endpoint)) {
    const input = await request.clone().json();
    if (typeof nativeWriter !== 'undefined' && nativeWriter.owns(input)) {
      const record = nativeWriter.record(input.threadId, 'thread', { userId: request.headers.get('x-notion-active-user-header'), spaceId: input.spaceId ?? request.headers.get('x-notion-space-id') ?? undefined });
      return record ? json(endpoint === 'getThreadSpaceId' ? { spaceId: record.space_id } : {}) : json({ message: '续写对话不属于当前账号或工作区。' }, 403);
    }
    if (typeof databaseBuild !== 'undefined' && databaseBuild.owns(input)) {
      const record = databaseBuild.record(input.threadId, 'thread', { userId: request.headers.get('x-notion-active-user-header'), spaceId: input.spaceId });
      return record ? json(endpoint === 'getThreadSpaceId' ? { spaceId: record.space_id } : {}) : json({ message: '建库对话不属于当前账号或工作区。' }, 403);
    }
    const record = mock.record(input.threadId, 'thread', { userId: request.headers.get('x-notion-active-user-header'), spaceId: input.spaceId ?? request.headers.get('x-notion-space-id') ?? undefined });
    if (record) return json(endpoint === 'getThreadSpaceId' ? { spaceId: record.space_id } : {});
    if (mock.hasRecord(input.threadId, 'thread')) return json({ message: '本地 AI 对话不属于当前账号或工作区。' }, 403);
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
    catch (error) {
      if (!['autofill', 'attachments'].includes(error.notionSwitchKind)) nativeSpeech.lifecycleReady = false;
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
  if (isNotion(url.hostname) && url.pathname.includes('/api/') && endpoint === 'generateAiBlock' && provider.status().mode === 'deepseek') {
    try {
      const input = await request.clone().json(), spaceId = uuid(input?.blockPointer?.spaceId);
      const store = meetingBridge.forRequest(request, ses, spaceId);
      const budget = { files: 0, bytes: 0 };
      const files = openNativePageFiles({ store, parseContent: (...args) => mediaTranscripts.parse(...args), signal: request.signal, budget });
      const properties = typeof extensions !== 'undefined' ? extensions.pageFiles?.open({ spaceId: store.spaceId, signal: request.signal, budget }) : null;
      return await generateAiBlock({ input, store, provider, workspace: typeof workspace !== 'undefined' ? workspace : undefined,
        readFile: ({ blockId }) => files.execute('read_notion_file', { block_id: blockId }), ...(properties ? { readFileProperties: ({ pageId, propertyIds }) => properties.readProperties(pageId, propertyIds) } : {}), signal: request.signal });
    } catch (error) {
      const message = /^(?:AI block|当前页面|此 AI block|暂只支持|请填写|无法读取)/.test(error.message || '') ? error.message : 'AI block 生成未完成，请检查当前页面和模型配置。';
      log({ type: 'local-ai-block-failed', reason: 'generation_failed' });
      return json({ name: 'NotionSwitchAiBlock', message }, 400);
    }
  }
  const localRead = ['getThreadTranscript', 'getThreadQueuedMessages', 'listenToThreadTranscript'].includes(endpoint);
  if (isNotion(url.hostname) && url.pathname.includes('/api/') && (localRead || endpoints.has(endpoint) || /^(runInference|create.*Agent.*Thread|sendEventTo.*Thread)/.test(endpoint))) {
    try {
      const input = await request.clone().json();
      if (typeof nativeWriter !== 'undefined') {
        if (endpoint === 'undoAgentServiceTurn' && !nativeWriter.owns(input)) return passthrough(request);
        if (settings.isLoginSyncing() && (endpoint === 'runWriter' || nativeWriter.owns(input))) return json({ message: '本机登录同步正在准备重启，请等待重新打开后继续。' }, 409);
        if (endpoint === 'runWriter' || nativeWriter.owns(input)) return nativeWriter.handle(endpoint, input, request.signal, {
          request, session: ses, userId: request.headers.get('x-notion-active-user-header'), spaceId: request.headers.get('x-notion-space-id') ?? undefined });
      }
      if (typeof databaseBuild !== 'undefined' && ['createAgentThread', 'createCalendarAgentThread'].includes(endpoint) && databaseBuild.owns(input))
        return json({ message: '此对话属于本地建库入口，请新建侧栏对话。' }, 409);
      if (settings.isLoginSyncing() && /^(?:create|sendEventTo|runInference)/.test(endpoint)) return json({ name: 'NotionSwitchPrototype', message: '本机登录同步正在准备重启，请等待重新打开后继续。' }, 409);
      if (localRead && !mock.owns(input)) return passthrough(request);
      const images = createNativeImageAdapter({
        ocrImage: typeof mediaTranscripts !== 'undefined' && mediaTranscripts.ocr ? (...args) => mediaTranscripts.ocr.recognize(...args) : undefined,
        readLocalFile: ({ spaceId, threadId, fileId }) => localImages.read({ spaceId, threadId, fileId, userId: request.headers.get('x-notion-active-user-header') }),
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
      const attachments = typeof localDocuments !== 'undefined' ? createNativeAttachmentAdapter({ images, parseContent: (...args) => mediaTranscripts.parse(...args),
        readLocalDocument: scope => localDocuments.read({ ...scope, userId: request.headers.get('x-notion-active-user-header') }) }) : images;
      return await mock.handle(endpoint, input, request.signal, { userId: request.headers.get('x-notion-active-user-header'), spaceId: request.headers.get('x-notion-space-id') ?? undefined, images: attachments,
        ...(typeof openNativeCalendar === 'function' ? { openCalendar: ({ userId, spaceId, signal }) => openNativeCalendar({ store: meetingBridge.forRequest(request, ses, spaceId), userId, spaceId, signal }) } : {}),
        ...(typeof calendarWrites !== 'undefined' ? { openCalendarWrites: scope => calendarWrites.open(scope) } : {}),
        resolveInstructions: ({ input, content, signal, userId }) => resolveNativeInstructions({ store: meetingBridge.forRequest(request, ses, input.spaceId), userId, spaceId: input.spaceId, content, signal }),
        ...(typeof localInlineDocuments !== 'undefined' ? { inlineAttachment: scope => localInlineDocuments.prepare({ ...scope,
          userId: request.headers.get('x-notion-active-user-header'), origin: url.origin }) } : {}) });
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
app.on('before-quit', () => mock.close());
app.on('before-quit', () => autofill.close());
app.on('before-quit', () => databaseBuild.close());
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
  contents.on('did-finish-load', () => {
    try { const url = new URL(contents.getURL()); if (url.protocol === 'https:' && isNotion(url.hostname)) void contents.executeJavaScript(wizardEntryScript).catch(() => {}); } catch {}
    if (macFileDownloads) try { const url = new URL(contents.getURL()); if (url.protocol === 'https:' && isNotion(url.hostname)) void contents.executeJavaScript(macFileDownloads.downloadScript).catch(() => {}); } catch {}
  });
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
      activeTurns: state.activeTurns + nativeWriter.active + databaseBuild.active + databaseWizard.service.active + calendarWrites.active + autofill.active + (speechBusy ? 1 : 0) + meetingSummaries.active + recordings.active + backgroundAgents.active + (settings.mediaTranscripts?.pending || 0) + (settings.mediaTranscripts?.ocr?.pending || 0) + (settings.mediaTranscripts?.ocr?.preparing ? 1 : 0) + (settings.collection?.service.active || 0), nativeWriter: { active: nativeWriter.active }, databaseWizard: { active: databaseWizard.service.active, available: databaseWizard.service.available }, calendarWrites: { active: calendarWrites.active, available: calendarWrites.available }, databaseBuild: { active: databaseBuild.active, available: databaseBuild.available }, autofill: { active: autofill.active, available: autofill.available }, collection: settings.collection?.status(), meetingSummaries: meetingSummaries.status(), meetingContexts: meetingBridge.contexts.length,
      compatibility, notion: workspace.status(), settings: settings.status(), speech: { ...settings.speech.status(), native: nativeSpeech.status() } }));
  }
  else if (req.url === '/collection/open' && req.method === 'POST') {
    await settings.collection.open(); res.end(JSON.stringify({ opened: true }));
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
