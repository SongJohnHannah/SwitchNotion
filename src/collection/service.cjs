const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { defaults, preferences, destination, extractUrls, selectedNodes, mediaKinds, atomicJson, hash, layoutNodes } = require('./model.cjs');
const { CollectionBinaries } = require('./binaries.cjs');
const { CollectionBrowser } = require('./browser.cjs');
const { CollectionMedia } = require('./media.cjs');
const { OllamaService } = require('./ollama.cjs');
const { MediaOcr } = require('../mediaocr.cjs');
const { CollectionNotion } = require('./notion.cjs');
const { CollectionExtraction } = require('./extraction.cjs');
const { extractionReadiness } = require('./extraction-readiness.cjs');
const { parseInputs, describeLocal, checkLocal, localDocument, isLikelyVideoInput } = require('./local-media.cjs');
const { clearCompleted, ownedExport } = require('./history.cjs');
const { prepareLocalOutput, writeLocalOutput } = require('./local-output.cjs');
const { loadLocalCollection, checkRetainedAsset, inside } = require('./reprocessing.cjs');
const activeStates = new Set(['queued', 'reading', 'downloading', 'waiting_processing', 'processing', 'uploading', 'saving']);
const resumableStates = new Set(['failed', 'partial', 'cancelled', 'interrupted', 'paused', 'needs_login']);
const deletableStates = new Set([...resumableStates, 'awaiting_selection']);
const dedupeKey = (url, options) => hash(JSON.stringify([url, options.destination, options.types, options.transcribe, options.vision, options.visionEngine, options.compress, options.quality, options.keepLocal, options.extraction, ...(options.extraction.mode !== 'off' ? ['separate-reports-v1', ...(options.denseOcr ? ['dense-ocr'] : [])] : [])]));
const safeError = error => {
  const text = String(error?.message || '操作未完成，请检查连接后重试。');
  if (/(?:sk-|ntn_|secret_)[\w-]{8}|Bearer\s|Cookie\s*[:=]/i.test(text)) return '连接或处理失败，请在配置中检查后重试。';
  return /^[\u3400-\u9fff]|^(Notion|DeepSeek|媒体|收集|资源|目标|此|本地|请选择|请先|无法|没有|下载)/.test(text) ? text.slice(0, 500) : '操作未完成，请检查网络与组件状态后重试。';
};
class CollectionService extends EventEmitter {
  constructor({ root, downloadsDirectory = path.join(os.homedir(), 'Downloads'), speech, provider, webSources, binaries, browser, media, notion, extraction } = {}) {
    super(); this.root = root; this.downloadsDirectory = downloadsDirectory; this.directory = path.join(root, 'collection'); this.settingsFile = path.join(this.directory, 'settings.local.json');
    this.settings = preferences(); this.jobs = new Map(); this.queue = []; this.processingQueue = []; this.downloading = null; this.running = null;
    this.downloadTask = null; this.processingTask = null; this.mediaIdleTask = null; this.pauseTask = null; this.pausing = false; this.closed = false; this.lastError = ''; this.preparing = false;
    if (fs.existsSync(this.settingsFile)) try {
      const saved = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')), value = saved.settings || saved;
      // The old processing options did not expose a persistent OCR off switch.
      if ((saved.version === undefined || saved.version === 1) && value.denseOcr === false) delete value.denseOcr;
      if (saved.platform && saved.platform !== process.platform) { value.browserExecutable = ''; value.browserProfile = ''; value.outputDirectory = ''; }
      this.settings = preferences(value);
    } catch { this.configError = '收集配置无法读取，已保留原文件，请检查后恢复。'; }
    this.binaries = binaries || new CollectionBinaries({ root });
    this.browser = browser || new CollectionBrowser({ root, getSettings: () => this.settings, binaries: this.binaries });
    this.media = media || new CollectionMedia({ root, browser: this.browser, binaries: this.binaries, speech, provider,
      ollama: new OllamaService(), ocr: ['win32', 'darwin'].includes(process.platform) ? new MediaOcr({ root }) : undefined });
    this.notion = notion || (process.platform === 'darwin'
      ? new (require('../compat/macos-collection-notion.cjs').MacCollectionNotion)({ root })
      : new CollectionNotion({ root }));
    this.extractor = extraction || new CollectionExtraction({ provider, webSources });
    const jobsDirectory = path.join(this.directory, 'jobs');
    if (fs.existsSync(jobsDirectory)) for (const name of fs.readdirSync(jobsDirectory)) {
      if (!/^[a-f\d-]{36}$/i.test(name)) continue;
      try {
        const file = path.join(jobsDirectory, name, 'job.json');
        if (fs.lstatSync(path.dirname(file)).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()) continue;
        const job = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (job.id !== name || job.version !== 1 || !job.options) continue;
        job.options = preferences({ denseOcr: false, ...job.options, ...(!job.options.extraction ? { extraction: { mode: 'off' } } : {}) });
        if (job.localSource) { if (!path.isAbsolute(job.localSource.path) || !/^[a-f\d]{64}$/.test(job.localSource.signature)) continue; }
        else extractUrls(job.url);
        if (activeStates.has(job.status)) { job.status = 'interrupted'; job.message = '上次运行已中断，已保留文件和写入进度，可继续。'; }
        if (job.document && job.extraction?.text && job.options.extraction.mode !== 'off') {
          const pending = extractionReadiness(job, layoutNodes(selectedNodes(job.document, job.options, job.selectedIds), job.layout));
          if (pending) {
            job.extraction = pending; delete job.classification; delete job.extractionWork; job.message = pending.error;
            const legacy = '媒体下载未完成，请在收集浏览器中登录并确认原始内容可播放。';
            const corrected = '媒体下载未完成；旧版本未记录实际失败原因，请重试下载。';
            for (const resource of Object.values(job.resources || {})) if (resource.error === legacy) resource.error = corrected;
            job.warnings = (job.warnings || []).map(warning => warning.replace('尚待补全：', '处理未完成：').replace(legacy, corrected));
          }
        }
        this.jobs.set(job.id, job);
        if (job.status === 'completed' && !this.settings.keepHistory) this.forgetCompleted(job);
      } catch { this.lastError = '部分任务记录无法读取，原文件已保留。'; }
    }
  }
  get active() { return new Set([...this.queue, ...this.processingQueue, ...[this.running?.id, this.downloading?.id].filter(Boolean)]).size + Number(this.preparing); }
  busy(id) { return this.running?.id === id || this.downloading?.id === id || this.queue.includes(id) || this.processingQueue.includes(id); }
  location(job) {
    if (!/^[a-f\d-]{36}$/i.test(job.id)) throw Error('收集任务标识无效。');
    const dir = path.join(this.directory, 'jobs', job.id);
    for (const candidate of [this.directory, path.dirname(dir), dir]) if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('收集任务目录不能使用目录链接。');
    return dir;
  }
  save(job) {
    job.updatedAt = new Date().toISOString();
    if (job.options.keepLocal && job.document && job.exportDirectory) {
      try { writeLocalOutput(job); if (job.localCopyError && this.lastError === '本地资料保存未完成：' + job.localCopyError) this.lastError = ''; delete job.localCopyError; }
      catch (error) { job.localCopyError = safeError(error); this.lastError = '本地资料保存未完成：' + job.localCopyError; }
    }
    atomicJson(path.join(this.location(job), 'job.json'), job); this.emit('change');
  }
  status() {
    return { active: this.active, pausing: this.pausing, lastError: this.lastError, configError: this.configError || '', settings: structuredClone(this.settings), defaultDownloadDirectory: path.join(this.downloadsDirectory, 'NotionSwitch'),
      binaries: this.binaries.status(), preparing: this.preparing, latestCompletion: this.latestCompletion ? { ...this.latestCompletion, canRedistill: this.canRedistill(this.jobs.get(this.latestCompletion.id)) } : null,
      jobs: [...this.jobs.values()].filter(job => !job.historyCleared && (this.settings.keepHistory || job.status !== 'completed')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(job => ({ id: job.id, url: job.url, local: !!job.localSource, title: job.document?.title || job.url,
        status: job.status, canDelete: deletableStates.has(job.status) && !this.busy(job.id), canRedistill: this.canRedistill(job), message: job.message, createdAt: job.createdAt, page: job.page, pages: job.pages, options: job.options, warnings: job.warnings || [],
        classification: job.classification ? { type: job.classification.type, title: job.classification.title, tone: job.classification.tone || '', degraded: job.classification.degraded === true } : null,
        selectedIds: job.selectedIds, preview: job.document ? { incomplete: job.document.incomplete, requiresLogin: job.document.requiresLogin,
          nodes: job.document.nodes.map(n => ({ id: n.id, kind: n.kind, text: n.text.slice(0, 600), caption: n.caption.slice(0,600), level: n.level })) } : null })) };
  }
  async configure(input) {
    if (this.configError) throw Error(this.configError);
    const next = preferences(input, this.settings);
    if (Object.hasOwn(input, 'destination') && next.destination) await this.notion.verifyTarget(next.destination, AbortSignal.timeout(30000));
    this.settings = next; atomicJson(this.settingsFile, { version: 2, platform: process.platform, settings: next });
    if (!next.keepHistory) for (const job of this.jobs.values()) if (job.status === 'completed' && !job.historyCleared) this.forgetCompleted(job);
    this.emit('settings'); this.emit('change'); return { message: '内容收集设置已保存，新任务使用新设置。', settings: next };
  }
  async create({ input, options = {}, preview = false, force = false }) {
    if (this.configError) throw Error(this.configError);
    const chosen = preferences(options, this.settings);
    if (!preview && !chosen.destination) throw Error('请先选择保存到哪个 Notion 数据库或父页面。');
    const results = [];
    const sources = parseInputs(input).map(source => source.kind === 'local' ? { source: describeLocal(source.path) } : source);
    for (const entry of sources) {
      const url = entry.url || 'local-media:' + entry.source.signature;
      const key = dedupeKey(url, chosen);
      const existing = !force && [...this.jobs.values()].find(job => job.dedupe === key);
      if (existing) {
        if (['cancelled', 'failed', 'interrupted', 'partial', 'paused'].includes(existing.status)) this.retry(existing.id);
        if (existing.status === 'completed') this.latestCompletion = { id: existing.id, title: existing.document?.title || existing.url, page: existing.page, pages: existing.pages };
        results.push({ id: existing.id, existing: true, status: existing.status, page: existing.page, pages: existing.pages }); continue;
      }
      const job = { version: 1, id: randomUUID(), url, dedupe: key, createdAt: new Date().toISOString(), status: 'queued', message: '等待读取内容…',
        options: structuredClone(chosen), previewOnly: preview, resources: {}, analyses: {}, warnings: [], layout: 'result-first',
        ...(entry.source ? { localSource: entry.source, document: localDocument(entry.source) } : {}), ...(entry.shareTitle ? { shareTitle: entry.shareTitle } : {}) };
      this.jobs.set(job.id, job); this.save(job); this.enqueue(job); results.push({ id: job.id });
    }
    return { jobs: results };
  }
  canRedistill(job) { return !!(job?.status === 'completed' && job.options.keepLocal && job.exportDirectory && (job.hasVideo || job.document && selectedNodes(job.document, job.options, job.selectedIds).some(node => node.kind === 'video'))); }
  redistill({ id, directory, preference = '', destination: target, visionEngine = this.settings.visionEngine } = {}) {
    if (this.configError) throw Error(this.configError);
    if ((id === undefined) === (directory === undefined)) throw Error('请选择一条已完成的视频任务或一个本地资料文件夹。');
    let original;
    if (id !== undefined) {
      original = this.jobs.get(id);
      if (!this.canRedistill(original)) throw Error('此任务没有可复用的本地视频资料；收集前需取消勾选「不保留本地资料」。');
      directory = ownedExport(original);
      if (!directory) throw Error('本地资料文件夹已被删除，请选择仍保留视频的资料文件夹。');
    }
    const source = loadLocalCollection(directory);
    const chosen = preferences({ destination: original?.options.destination || source.destination || target || this.settings.destination,
      keepLocal: true, types: ['text', 'video'], vision: true, visionEngine, transcribe: false, denseOcr: false, extraction: { mode: 'style', preference } }, this.settings);
    if (!chosen.destination) throw Error('旧资料未记录保存位置，请先选择原 Notion 工作区中的数据库或父页面。');
    const key = hash(JSON.stringify(['local-style-v1', source.referencePage.id, Object.values(source.resources).map(resource => resource.asset), chosen.destination, chosen.visionEngine, chosen.extraction]));
    const existing = [...this.jobs.values()].find(job => job.dedupe === key);
    if (existing) {
      if (['failed', 'partial', 'cancelled', 'interrupted', 'paused'].includes(existing.status)) this.retry(existing.id);
      if (existing.status === 'completed') this.latestCompletion = { id: existing.id, title: existing.document.title, page: existing.page, pages: existing.pages };
      return { id: existing.id, existing: true, message: existing.status === 'completed' ? '已有这份制作拆解，可直接打开 Notion。' : '已复用现有重新蒸馏任务。' };
    }
    const job = { version: 1, id: randomUUID(), url: source.url, dedupe: key, createdAt: new Date().toISOString(), status: 'queued',
      message: '等待复用本地资料，按视频制作方式重新识别画面…', options: chosen,
      document: { ...source.document, title: source.document.title + ' · 画面与视频制作拆解' }, selectedIds: source.selectedIds,
      resources: source.resources, analyses: source.analyses, warnings: [], layout: 'result-first',
      reprocessing: { directory: source.directory, originalPage: source.referencePage } };
    this.jobs.set(job.id, job); this.save(job); this.enqueue(job);
    return { id: job.id, message: '已加入重新蒸馏队列：复用本地视频和已有文字资料，生成关联原页面的制作拆解。' };
  }
  enqueue(job) {
    if (this.closed || this.busy(job.id)) return;
    job.status = 'queued'; job.message = '等待按顺序读取和下载…'; this.save(job); this.queue.push(job.id); this.pumpDownloads();
  }
  failJob(job, controller, error) {
    const paused = controller.signal.aborted && controller.signal.reason?.code === 'COLLECTION_PAUSED';
    job.status = paused ? 'paused' : controller.signal.aborted ? 'cancelled' : 'failed';
    job.message = paused ? '已暂停；已下载素材和已完成进度保留。' : controller.signal.aborted ? '已停止后续处理；已保存的内容和进度保留。' : safeError(error); this.save(job);
  }
  releaseIdleMedia() {
    if (this.closed || this.active || this.mediaIdleTask) return;
    this.mediaIdleTask = Promise.allSettled([this.media.closeOcrSession?.(), this.media.unloadLocalModel?.()])
      .finally(() => { this.mediaIdleTask = null; });
  }
  pumpDownloads() {
    if (this.downloading || this.closed || this.pausing) return;
    const id = this.queue.shift(); if (!id) return;
    const job = this.jobs.get(id), controller = new AbortController(); this.downloading = { id, controller };
    this.downloadTask = (async () => {
      try {
        const ready = await this.downloadJob(job, controller.signal);
        controller.signal.throwIfAborted();
        if (ready && !this.closed) {
          const incomplete = selectedNodes(job.document, job.options, job.selectedIds).some(node => mediaKinds.has(node.kind) && (job.resources[node.id]?.error || !job.resources[node.id]?.asset?.path));
          job.status = 'waiting_processing'; job.message = incomplete ? '部分素材下载未完成，等待整理已有内容…' : '素材下载完成，等待按顺序整理…'; this.save(job);
          this.processingQueue.push(id); this.pump();
        }
      } catch (error) { this.failJob(job, controller, error); }
      finally {
        this.downloading = null; this.downloadTask = null; this.emit('change');
        this.pumpDownloads(); this.releaseIdleMedia();
      }
    })();
  }
  pump() {
    if (this.running || this.closed || this.pausing) return;
    const id = this.processingQueue.shift(); if (!id) return;
    const job = this.jobs.get(id), controller = new AbortController(); this.running = { id, controller };
    this.processingTask = (async () => {
      try {
        if (this.mediaIdleTask) await this.mediaIdleTask;
        controller.signal.throwIfAborted();
        job.status = 'processing'; job.message = '正在整理已下载的素材…'; this.save(job);
        await this.process(job, controller.signal);
      } catch (error) { this.failJob(job, controller, error); }
      finally {
        this.running = null; this.processingTask = null; this.emit('change');
        this.pump(); this.releaseIdleMedia();
      }
    })();
  }
  async downloadJob(job, signal) {
    const save = () => this.save(job);
    const progress = message => { job.message = message; save(); };
    if (!job.document) {
      job.status = 'reading'; progress('正在识别链接中的正文、图片、视频和音频…');
      job.document = await this.browser.inspect(job.url, { signal, progress });
      if (job.shareTitle && job.document.titleSource === 'unavailable') {
        job.document.title = job.shareTitle;
        job.document.titleSource = 'share';
        if (/(?:\.{3}|…)$/.test(job.shareTitle)) job.document.warnings.push('作品标题来自分享文案，文案末尾有截断。');
      }
      job.warnings = [...job.document.warnings]; save();
    }
    if ((job.document.requiresLogin || job.document.incomplete) && !job.allowPartial) {
      job.status = 'needs_login';
      progress(job.document.requiresLogin ? '原站提示账号访问限制或人工验证，请在收集浏览器中处理后重新读取；也可手动保存已获取的部分。' : '原网页正文尚未完整获取，请确认页面已加载或展开正文后重新读取；也可手动保存已获取的部分。');
      return;
    }
    if (job.previewOnly) { job.status = 'awaiting_selection'; progress('已识别内容，请选择要保存的项目与位置。'); return; }
    if (!job.options.destination) throw Error('请先选择保存位置。');
    const selected = layoutNodes(selectedNodes(job.document, job.options, job.selectedIds), job.layout);
    if (!selected.length) throw Error('请至少选择一项要保存的内容。');
    if (job.options.keepLocal) { prepareLocalOutput(job, this.downloadsDirectory); save(); }
    if (job.reprocessing) { await this.prepareReprocessing(job, selected, save, progress, signal); return true; }
    for (const [index, node] of selected.entries()) {
      if (!mediaKinds.has(node.kind)) continue;
      signal.throwIfAborted();
      const resource = job.resources[node.id] ||= {};
      if (resource.asset?.path && fs.existsSync(resource.asset.path)) continue;
      delete resource.asset; delete resource.error;
      const directory = job.options.keepLocal ? path.join(job.exportDirectory, '素材', String(index + 1).padStart(2, '0') + '-' + ({ image: '图片', video: '视频', audio: '音频' }[node.kind])) : path.join(this.location(job), 'working', node.id);
      const nodeProgress = message => progress(`素材 ${index + 1}/${selected.length} · ` + message);
      job.status = 'downloading'; save();
      try {
        if (job.options.keepLocal && !ownedExport(job)) throw Error('资料文件夹已被手动删除，请停止任务或重新收集。');
        resource.asset = job.localSource ? await this.media.importLocal(job.localSource, directory, { signal, progress: nodeProgress }) : await this.media.acquire({ ...node, sourceUrl: job.document.url }, directory, { signal, progress: nodeProgress });
      } catch (error) { signal.throwIfAborted(); resource.error = safeError(error); }
      save();
    }
    signal.throwIfAborted(); return true;
  }
  async process(job, signal) {
    const save = () => this.save(job), progress = message => { job.message = message; save(); };
    const selected = layoutNodes(selectedNodes(job.document, job.options, job.selectedIds), job.layout);
    const { limit } = await this.notion.verifyTarget(job.options.destination, signal);
    await this.processMedia(job, selected, limit, save, progress, signal);
    if (job.options.extraction.mode !== 'off') {
      job.status = 'processing'; save();
      const pending = extractionReadiness(job, selected);
      if (pending) { job.extraction = pending; delete job.classification; delete job.extractionWork; }
      else try { job.extraction = await this.extractor.run(job, selected, { signal, progress, save }); }
      catch (error) { signal.throwIfAborted(); job.extraction = { error: safeError(error) }; }
      if (job.reprocessing && job.extraction?.text) job.extraction.key = 'style';
      save();
    }
    const failures = selected.filter(node => mediaKinds.has(node.kind) && (job.resources[node.id]?.error || job.analyses[node.id]?.errors?.length));
    job.warnings = [...job.document.warnings, ...failures.map(node => `素材 ${selected.indexOf(node) + 1} 处理未完成：${job.resources[node.id]?.error || job.analyses[node.id].errors.join('；')}`)];
    if (job.extraction?.error) job.warnings.push('内容提取待完成：' + job.extraction.error);
    const both = job.options.extraction.mode === 'both' && selected.some(node => ['video', 'image'].includes(node.kind));
    const waitingForReports = (both || job.reprocessing) && !job.page && job.extraction?.error;
    const separate = job.extraction?.reports?.length && (!job.page || job.reportWrites);
    if (!waitingForReports) {
      job.status = 'saving'; progress(separate ? '正在分别保存两份 Notion 文档…' : '正在按原文顺序保存到 Notion，并核验内容…');
      if (separate) await this.writeReports(job, selected, save, signal);
      else await this.notion.write(job, selected, save, signal);
    }
    if (job.options.keepLocal) this.exportLocal(job, selected);
    job.status = failures.length || job.document.incomplete || job.extraction?.error ? 'partial' : 'completed';
    job.message = job.status === 'completed' ? (job.reprocessing ? '已复用本地资料生成制作拆解，并关联原 Notion 页面。' : separate ? '两份 Notion 文档已分别保存并核验。' : '已保存到 Notion，正文和媒体顺序已核验。') :
      waitingForReports ? job.reprocessing ? '已保留重新识别进度，制作拆解完成后再保存新文档。' : '已保留下载与识别进度，分析完成后将分别保存两份文档。' :
      job.extraction?.deferred ? '已保存已获取的内容；' + job.extraction.error :
      '已保存已获取的内容；' + (failures.length ? '部分素材下载、识别或上传未完成，请查看具体原因后重试。' : job.extraction?.error ? 'AI 总结未完成，请查看具体原因后重试。' : '原网页内容尚未完整获取，请检查原网页后重试。'); save();
    if (job.status === 'completed' && !job.options.keepLocal) this.releaseWorkingFiles(job);
    this.emit('finished', { id: job.id, title: job.document.title, status: job.status, url: job.page?.url, pageId: job.page?.id, pages: job.pages });
    if (job.status === 'completed') {
      this.latestCompletion = { id: job.id, title: job.document.title, page: job.page, pages: job.pages };
      if (!this.settings.keepHistory) this.forgetCompleted(job);
    }
  }
  async writeReports(job, nodes, save, signal) {
    const reports = job.extraction.reports;
    job.reportWrites ||= {};
    for (const report of reports) {
      const state = job.reportWrites[report.key] ||= {};
      const shared = { id: `${job.id}:${report.key}`, createdAt: job.createdAt, options: job.options, selectedIds: job.selectedIds,
        document: { ...job.document, title: `${job.document.title} · ${report.name}` }, resources: job.resources,
        analyses: job.analyses, warnings: job.warnings, extraction: report, layout: job.layout };
      // The writer keeps separate page checkpoints while the original media and recognition stay on the parent job.
      const writeJob = Object.assign(Object.create(shared), state);
      const saveReport = () => {
        Object.assign(state, writeJob);
        job.pages = reports.flatMap(({ key, name }) => {
          const page = job.reportWrites[key]?.page;
          return page ? [{ ...page, key, name }] : [];
        });
        job.page = job.pages[0];
        job.message = `正在保存「${report.name}」${writeJob.message ? ' · ' + writeJob.message : '…'}`;
        save();
      };
      await this.notion.write(writeJob, nodes, saveReport, signal);
      saveReport();
    }
  }
  async prepareReprocessing(job, nodes, save, progress, signal) {
    for (const node of nodes.filter(node => node.kind === 'video')) {
      signal.throwIfAborted();
      const resource = job.resources[node.id], asset = resource?.asset;
      if (!asset?.path) throw Error('本地原视频缺失，无法重新识别画面；不会自动重新下载。');
      const before = checkRetainedAsset(asset);
      // Each report owns its working files, so deleting or retrying it cannot affect the original collection.
      if (!inside(job.exportDirectory, asset.path)) {
        progress('正在复用本地视频和已有识别资料…');
        const directory = path.join(job.exportDirectory, '素材', node.id); fs.mkdirSync(directory, { recursive: true });
        const output = path.join(directory, path.basename(asset.path));
        await fs.promises.copyFile(asset.path, output); signal.throwIfAborted(); checkRetainedAsset(asset);
        const stat = fs.statSync(output);
        if (stat.size !== before.size) throw Error('本地视频复制尚未完成，请重试；未重新下载。');
        resource.asset = { ...asset, path: output, bytes: stat.size, modified: stat.mtimeMs }; save();
      }
      if (!(resource.asset.duration > 0)) {
        Object.assign(resource.asset, await this.media.probe(resource.asset.path, signal)); save();
      }
    }
  }
  async processMedia(job, nodes, limit, save, progress, signal) {
    const entries = nodes.flatMap((node, index) => mediaKinds.has(node.kind) ? [{ node, index }] : []);
    const work = [];
    let processing = false;
    const markProcessing = () => { if (processing) return; processing = true; job.status = 'processing'; save(); };
    for (const { node, index } of entries) {
      const resource = job.resources[node.id] ||= {}, analysis = job.analyses[node.id] ||= {};
      analysis.errors = [];
      if (!resource.asset?.path || !fs.existsSync(resource.asset.path)) {
        delete resource.asset;
        resource.error ||= job.reprocessing ? '本地原视频缺失，已停止重新蒸馏；不会自动重新下载。' : '素材下载未完成或文件已缺失，请继续／重试补齐下载。'; save(); continue;
      }
      delete resource.error;
      const label = `素材 ${index + 1}/${nodes.length} · `;
      const nodeProgress = message => progress(label + message);
      work.push((async () => {
        try {
          const current = resource.asset;
          const legacyTranscript = this.media.operator && current.audio !== false && analysis.transcript && !analysis.transcript.operator?.complete;
          if (job.options.transcribe && ['audio', 'video'].includes(node.kind) && (!analysis.transcript || legacyTranscript)) {
            markProcessing();
            if (legacyTranscript) {
              (analysis.transcriptHistory ||= []).push({ at: new Date().toISOString(), reason: 'standalone-gpu-operator-upgrade', result: analysis.transcript });
              delete analysis.transcript; save();
            }
            try { analysis.transcript = await this.media.transcript(current, { signal, progress: nodeProgress }); }
            catch (error) { signal.throwIfAborted(); analysis.errors.push(safeError(error)); } save();
          }
          let ocrError;
          const denseOcr = job.options.extraction.mode !== 'off' && job.options.denseOcr;
          if (node.kind === 'video' && typeof this.media.ocr === 'function' && (!analysis.ocr || denseOcr && !analysis.ocr.dense)) {
            markProcessing();
            try { analysis.ocr = await this.media.ocr(current, { signal, progress: nodeProgress, dense: !!denseOcr, workers: job.options.ocrWorkers }); }
            catch (error) { signal.throwIfAborted(); ocrError = safeError(error); analysis.errors.push(ocrError); } save();
          }
          const wantsVision = job.options.vision && (job.options.visionEngine === 'local' ? node.kind === 'video' : ['image', 'video'].includes(node.kind));
          if (wantsVision && !analysis.vision) {
            markProcessing();
            const style = ['style', 'both'].includes(job.options.extraction.mode);
            const frames = !style && analysis.ocr?.frames?.length && analysis.ocr.frames.every(item => fs.existsSync(item.frame)) ? analysis.ocr.frames : undefined;
            try { analysis.vision = await this.media.vision(current, { signal, progress: nodeProgress, engine: job.options.visionEngine, frames,
              ocrText: analysis.ocr?.text, recognizedFramePaths: analysis.ocr?.recognizedFramePaths, style, workers: job.options.ocrWorkers, onOcr: ocr => {
                analysis.ocr = ocr;
                if (ocrError && !denseOcr) analysis.errors.splice(analysis.errors.lastIndexOf(ocrError), 1);
                save();
              } }); }
            catch (error) { signal.throwIfAborted(); analysis.errors.push(safeError(error)); } save();
          }
          if (node.kind === 'video' && job.options.extraction.mode !== 'off' && typeof this.media.verifyFrameEvidence === 'function') {
            const ocr = analysis.ocr?.text || analysis.vision?.ocrText, vision = analysis.vision?.text;
            const fingerprint = hash(JSON.stringify([ocr, vision]));
            if ((ocr || vision) && analysis.frameVerification?.fingerprint !== fingerprint) {
              delete analysis.frameVerification;
              try {
                const result = await this.media.verifyFrameEvidence(current, { ocr, vision, signal, progress: nodeProgress, workers: job.options.ocrWorkers });
                if (result) analysis.frameVerification = { ...result, fingerprint };
              } catch { signal.throwIfAborted(); nodeProgress('邻帧补扫未完成，继续使用已取得的识别结果。'); }
              save();
            }
          }
          if (job.reprocessing) return;
          if (!resource.parts) { markProcessing(); resource.parts = await this.media.prepareUpload(current, job.options, limit, { signal, progress: nodeProgress }); save(); }
          resource.uploads ||= [];
          for (let i = 0; i < resource.parts.length; i++) {
            job.status = 'uploading'; nodeProgress(`正在上传${node.kind === 'image' ? '图片' : node.kind === 'video' ? '视频' : '音频'} ${i + 1}/${resource.parts.length}…`);
            resource.uploads[i] ||= {};
            if (!resource.uploads[i].uploaded) await this.notion.upload(resource.parts[i], job, resource.uploads[i], save, signal);
          }
          if (processing) { job.status = 'processing'; save(); }
        } catch (error) { signal.throwIfAborted(); resource.error = safeError(error); save(); }
      })());
    }
    await Promise.allSettled(work);
    signal.throwIfAborted();
  }
  forgetCompleted(job) {
    try {
      clearCompleted(this.root, this.directory, job.id);
      const receipt = { id: job.id, version: 1, createdAt: job.createdAt, url: job.url, dedupe: job.dedupe, status: 'completed', message: '已保存到 Notion，本地临时记录已清理。',
        options: job.options, page: job.page, pages: job.pages, document: { title: job.document?.title || job.url, nodes: [] }, historyCleared: true,
        hasVideo: job.document && selectedNodes(job.document, job.options, job.selectedIds).some(node => node.kind === 'video'),
        ...(job.exportOwned ? { exportOwned: true, exportDirectory: job.exportDirectory, exportBaseDirectory: job.exportBaseDirectory } : {}), ...(job.localSource ? { localSource: { name: job.localSource.name } } : {}) };
      this.jobs.set(job.id, receipt);
      const receipts = [...this.jobs.values()].filter(value => value.historyCleared); for (const old of receipts.slice(0, Math.max(0, receipts.length - 30))) this.jobs.delete(old.id);
    } catch { this.lastError = '内容已保存到 Notion，但本地临时记录尚未清理，请检查文件占用或目录权限。'; }
  }
  exportLocal(job, nodes) {
    const directory = prepareLocalOutput(job, this.downloadsDirectory);
    // Recover older tasks whose downloads were still in the private working tree.
    for (const node of nodes) {
      const asset = job.resources[node.id]?.asset; if (!asset?.path || !fs.existsSync(asset.path)) continue;
      const relative = path.relative(directory, asset.path);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) continue;
      const output = path.join(directory, '素材', node.id, path.basename(asset.path)); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(asset.path, output); asset.path = output;
    }
    writeLocalOutput(job);
  }
  releaseWorkingFiles(job) {
    const directory = path.join(this.location(job), 'working');
    if (!fs.existsSync(directory)) return;
    try {
      const real = fs.realpathSync(directory), parent = fs.realpathSync(this.location(job));
      if (path.dirname(real) !== parent || path.basename(real) !== 'working') throw Error('收集缓存路径无效。');
      const check = current => { for (const entry of fs.readdirSync(current, { withFileTypes: true })) { if (entry.isSymbolicLink()) throw Error('收集缓存包含链接。'); if (entry.isDirectory()) check(path.join(current, entry.name)); } };
      check(real); fs.rmSync(real, { recursive: true }); job.cacheReleased = true; this.save(job);
    } catch { job.message += ' 临时缓存尚未清理，已保留文件。'; this.save(job); }
  }
  select(id, { ids, options = {}, allowPartial = false } = {}) {
    const job = this.jobs.get(id);
    if (!job || !['awaiting_selection', 'needs_login'].includes(job.status)) throw Error('此任务当前不能修改选择。');
    const chosen = preferences(options, job.options); selectedNodes(job.document, chosen, ids);
    if (!chosen.destination) throw Error('请选择保存到哪个数据库或父页面。');
    const key = dedupeKey(job.url, chosen);
    if ([...this.jobs.values()].some(other => other.id !== job.id && other.dedupe === key)) throw Error('同一来源与保存位置已有收集任务，请在任务列表中继续或打开原记录。');
    job.options = chosen; job.dedupe = key;
    job.selectedIds = ids; job.allowPartial = allowPartial === true; job.previewOnly = false; this.save(job); this.enqueue(job); return { id };
  }
  cancel(id, { pause = false } = {}) {
    const job = this.jobs.get(id); if (!job) throw Error('任务不存在。');
    this.queue = this.queue.filter(value => value !== id);
    this.processingQueue = this.processingQueue.filter(value => value !== id);
    const reason = Object.assign(Error(pause ? '用户暂停全部任务。' : '用户停止任务。'), pause ? { code: 'COLLECTION_PAUSED' } : {});
    if (this.downloading?.id === id) this.downloading.controller.abort(reason);
    if (this.running?.id === id) this.running.controller.abort(reason);
    if (this.running?.id !== id && this.downloading?.id !== id && job.status !== 'completed') {
      job.status = pause ? 'paused' : 'cancelled'; job.message = pause ? '已暂停；已下载素材和已完成进度保留。' : '已停止，文件和已有页面保留。'; this.save(job);
    }
    return { id };
  }
  pauseAll() {
    if (this.pauseTask) return this.pauseTask;
    if (this.closed) throw Error('应用正在退出，任务进度已保留。');
    const ids = [...new Set([...this.queue, ...this.processingQueue, ...[this.downloading?.id, this.running?.id].filter(Boolean)])];
    const tasks = [this.downloadTask, this.processingTask]; this.pausing = true;
    this.pauseTask = Promise.resolve().then(async () => {
      try {
        for (const id of ids) this.cancel(id, { pause: true });
        await Promise.allSettled(tasks);
        const paused = ids.filter(id => this.jobs.get(id)?.status === 'paused').length;
        return { paused, message: paused ? `已暂停 ${paused} 个任务，已下载素材和已完成进度保留。` : '当前没有需要暂停的任务。' };
      } finally {
        this.pausing = false; this.pauseTask = null; this.emit('change');
        this.pumpDownloads(); this.pump(); this.releaseIdleMedia();
      }
    });
    this.emit('change'); return this.pauseTask;
  }
  async resumeAll() {
    if (this.pauseTask) await this.pauseTask;
    if (this.closed) throw Error('应用正在退出，任务进度已保留。');
    const jobs = [...this.jobs.values()].filter(job => !job.historyCleared && resumableStates.has(job.status) && !this.busy(job.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of jobs) this.retry(job.id);
    const awaitingSelection = [...this.jobs.values()].filter(job => !job.historyCleared && job.status === 'awaiting_selection').length;
    const message = jobs.length ? `已继续 ${jobs.length} 个任务，按顺序补齐未完成步骤。` : '当前没有可继续的任务。';
    return { resumed: jobs.length, awaitingSelection, message: message + (awaitingSelection ? ` 另有 ${awaitingSelection} 个任务需要先选择内容。` : '') };
  }
  retry(id) {
    const job = this.jobs.get(id);
    if (!job || !resumableStates.has(job.status) || this.busy(id)) throw Error('此任务当前不需要重试。');
    // A resumed task follows the engine currently configured, while keeping the
    // job's own destination, extraction and per-collection vision choice.
    job.options.visionEngine = this.settings.visionEngine;
    job.options.ocrWorkers = this.settings.ocrWorkers;
    if (job.document?.incomplete && !job.page) { delete job.document; job.warnings = []; }
    this.enqueue(job); return { id };
  }
  deleteTask(id) {
    const job = this.jobs.get(id);
    if (!job) throw Error('任务不存在或已经删除。');
    if (!deletableStates.has(job.status) || this.busy(id)) throw Error('请先停止任务并等待处理结束，再删除此任务。');
    const exported = ownedExport(job); // Validate ownership and links before deleting anything.
    if (exported) fs.rmSync(exported, { recursive: true });
    clearCompleted(this.root, this.directory, id);
    this.jobs.delete(id); this.emit('change');
    return { id, pageRetained: !!job.page, message: '已删除本机任务及相关下载、转写和识别文件。' + (job.page ? ' 已保存的 Notion 页面保留。' : '') };
  }
  async prepare() {
    if (this.preparing) return { message: '组件正在准备中。' };
    this.preparing = true; this.emit('change');
    try { await this.binaries.prepare({ progress: value => { this.lastError = value; this.emit('change'); } }); this.lastError = ''; return { message: '媒体下载与压缩组件已就绪。' }; }
    finally { this.preparing = false; this.emit('change'); }
  }
  reread(id) {
    const job = this.jobs.get(id);
    if (!job || job.page || activeStates.has(job.status)) throw Error('只能重新读取尚未写入 Notion 的空闲任务。');
    if (job.localSource) job.document = localDocument(checkLocal(job.localSource)); else delete job.document;
    delete job.selectedIds; job.resources = {}; job.analyses = {}; job.warnings = [];
    this.save(job); this.enqueue(job); return { id };
  }
  async createLibrary(workspaceId, parentId) {
    if (this.configError) throw Error(this.configError);
    const created = await this.notion.createLibrary(workspaceId, parentId, AbortSignal.timeout(120000));
    const target = destination(created), favorites = this.settings.favorites.filter(d => d.id !== target.id || d.workspaceId !== target.workspaceId);
    favorites.push(target); await this.configure({ destination: target, favorites });
    return { destination: target, url: created.url, message: '资料收集库已就绪，并设为默认保存位置。' };
  }
  async request(action, input = {}) {
    const allowed = { state: [], configure: ['settings'], workspaces: [], destinations: ['workspaceId', 'query', 'cursors'], create: ['input', 'options', 'preview', 'force'],
      select: ['id', 'ids', 'options', 'allowPartial'], cancel: ['id'], retry: ['id'], 'pause-all': [], 'resume-all': [], 'delete-task': ['id'], reread: ['id'], accounts: ['verify'], login: ['site'], prepare: [], 'create-library': ['workspaceId', 'parentId'],
      'video-hint': ['input'], redistill: ['id', 'directory', 'preference', 'destination', 'visionEngine'] };
    try {
      if (!Object.hasOwn(allowed, action) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed[action].includes(k))) throw Error('无法识别此项收集操作。');
      let result;
      if (action === 'state') result = this.status();
      else if (action === 'configure') result = await this.configure(input.settings);
      else if (action === 'workspaces') result = await this.notion.workspaces(AbortSignal.timeout(45000));
      else if (action === 'destinations') result = await this.notion.search(input.workspaceId, input.query, input.cursors, AbortSignal.timeout(60000));
      else if (action === 'create') result = await this.create(input);
      else if (action === 'redistill') result = this.redistill(input);
      else if (action === 'select') result = this.select(input.id, input);
      else if (action === 'cancel') result = this.cancel(input.id);
      else if (action === 'retry') result = this.retry(input.id);
      else if (action === 'pause-all') result = await this.pauseAll();
      else if (action === 'resume-all') result = await this.resumeAll();
      else if (action === 'delete-task') result = this.deleteTask(input.id);
      else if (action === 'reread') result = this.reread(input.id);
      else if (action === 'accounts') { if (input.verify !== undefined && typeof input.verify !== 'boolean') throw Error('登录检测选项无效。'); result = await this.browser.accounts(AbortSignal.timeout(45000), { verify: input.verify === true }); }
      else if (action === 'login') { if (typeof input.site !== 'string' || input.site.length > 8192) throw Error('网站地址无效。'); result = await this.browser.login(input.site, AbortSignal.timeout(60000)); }
      else if (action === 'prepare') result = await this.prepare();
      else if (action === 'create-library') result = await this.createLibrary(input.workspaceId, input.parentId);
      else if (action === 'video-hint') result = isLikelyVideoInput(input.input);
      return { ok: true, result };
    } catch (error) { return { ok: false, error: safeError(error) }; }
  }
  close() {
    if (this.closed) return this.closing;
    this.closed = true; this.running?.controller.abort(Error('应用退出，任务进度保留。')); this.downloading?.controller.abort(Error('应用退出，任务进度保留。'));
    this.closing = Promise.allSettled([this.downloadTask, this.processingTask, this.mediaIdleTask, this.pauseTask])
      .then(() => Promise.allSettled([this.media.closeOcrSession?.(), this.media.unloadLocalModel?.()]));
    return this.closing;
  }
}
module.exports = { CollectionService, activeStates, safeError };
