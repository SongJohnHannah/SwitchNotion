const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { defaults, preferences, destination, extractUrls, selectedNodes, mediaKinds, atomicJson, hash, layoutNodes } = require('./model.cjs');
const { CollectionBinaries } = require('./binaries.cjs');
const { CollectionBrowser } = require('./browser.cjs');
const { CollectionMedia } = require('./media.cjs');
const { CollectionNotion } = require('./notion.cjs');
const { CollectionExtraction } = require('./extraction.cjs');
const { parseInputs, describeLocal, checkLocal, localDocument } = require('./local-media.cjs');
const { clearCompleted, ownedExport } = require('./history.cjs');
const { templates } = require('./prompts.cjs');
const { prepareLocalOutput, writeLocalOutput } = require('./local-output.cjs');
const activeStates = new Set(['queued', 'reading', 'downloading', 'processing', 'uploading', 'saving']);
const deletableStates = new Set(['failed', 'partial', 'cancelled', 'interrupted', 'needs_login', 'awaiting_selection']);
const dedupeKey = (url, options) => hash(JSON.stringify([url, options.destination, options.types, options.transcribe, options.vision, options.compress, options.quality, options.keepLocal, options.extraction]));
const safeError = error => {
  const text = String(error?.message || '操作未完成，请检查连接后重试。');
  if (/(?:sk-|ntn_|secret_)[\w-]{8}|Bearer\s|Cookie\s*[:=]/i.test(text)) return '连接或处理失败，请在配置中检查后重试。';
  return /^[\u3400-\u9fff]|^(Notion|DeepSeek|媒体|收集|资源|目标|此|本地|请选择|请先|无法|没有|下载)/.test(text) ? text.slice(0, 500) : '操作未完成，请检查网络、登录与组件状态后重试。';
};
class CollectionService extends EventEmitter {
  constructor({ root, downloadsDirectory = path.join(os.homedir(), 'Downloads'), speech, provider, binaries, browser, media, notion, extraction } = {}) {
    super(); this.root = root; this.downloadsDirectory = downloadsDirectory; this.directory = path.join(root, 'collection'); this.settingsFile = path.join(this.directory, 'settings.local.json');
    this.settings = preferences(); this.jobs = new Map(); this.queue = []; this.running = null; this.closed = false; this.lastError = ''; this.preparing = false;
    if (fs.existsSync(this.settingsFile)) try {
      const saved = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')), value = saved.settings || saved;
      if (saved.platform && saved.platform !== process.platform) { value.browserExecutable = ''; value.browserProfile = ''; value.outputDirectory = ''; }
      this.settings = preferences(value);
    } catch { this.configError = '收集配置无法读取，已保留原文件，请检查后恢复。'; }
    this.binaries = binaries || new CollectionBinaries({ root });
    this.browser = browser || new CollectionBrowser({ root, getSettings: () => this.settings, binaries: this.binaries });
    this.media = media || new CollectionMedia({ root, browser: this.browser, binaries: this.binaries, speech, provider });
    this.notion = notion || new CollectionNotion({ root });
    this.extractor = extraction || new CollectionExtraction({ provider });
    const jobsDirectory = path.join(this.directory, 'jobs');
    if (fs.existsSync(jobsDirectory)) for (const name of fs.readdirSync(jobsDirectory)) {
      if (!/^[a-f\d-]{36}$/i.test(name)) continue;
      try {
        const file = path.join(jobsDirectory, name, 'job.json');
        if (fs.lstatSync(path.dirname(file)).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()) continue;
        const job = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (job.id !== name || job.version !== 1 || !job.options) continue;
        job.options = preferences({ ...job.options, ...(!job.options.extraction ? { extraction: { mode: 'off' } } : {}) });
        if (job.localSource) { if (!path.isAbsolute(job.localSource.path) || !/^[a-f\d]{64}$/.test(job.localSource.signature)) continue; }
        else extractUrls(job.url);
        if (activeStates.has(job.status)) { job.status = 'interrupted'; job.message = '上次运行已中断，已保留文件和写入进度，可继续。'; }
        this.jobs.set(job.id, job);
        if (job.status === 'completed' && !this.settings.keepHistory) this.forgetCompleted(job);
      } catch { this.lastError = '部分任务记录无法读取，原文件已保留。'; }
    }
  }
  get active() { return Number(!!this.running) + this.queue.length + Number(this.preparing); }
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
    return { active: this.active, lastError: this.lastError, configError: this.configError || '', settings: structuredClone(this.settings), defaultDownloadDirectory: path.join(this.downloadsDirectory, 'NotionSwitch'),
      binaries: this.binaries.status(), preparing: this.preparing, promptTemplates: templates, latestCompletion: this.latestCompletion || null,
      jobs: [...this.jobs.values()].filter(job => !job.historyCleared && (this.settings.keepHistory || job.status !== 'completed')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(job => ({ id: job.id, url: job.url, local: !!job.localSource, title: job.document?.title || job.url,
        status: job.status, canDelete: deletableStates.has(job.status) && this.running?.id !== job.id && !this.queue.includes(job.id), message: job.message, createdAt: job.createdAt, page: job.page, options: job.options, warnings: job.warnings || [],
        selectedIds: job.selectedIds, preview: job.document ? { incomplete: job.document.incomplete, requiresLogin: job.document.requiresLogin,
          nodes: job.document.nodes.map(n => ({ id: n.id, kind: n.kind, text: n.text.slice(0, 600), caption: n.caption.slice(0,600), level: n.level })) } : null })) };
  }
  async configure(input) {
    if (this.configError) throw Error(this.configError);
    const next = preferences(input, this.settings);
    if (Object.hasOwn(input, 'destination') && next.destination) await this.notion.verifyTarget(next.destination, AbortSignal.timeout(30000));
    this.settings = next; atomicJson(this.settingsFile, { version: 1, platform: process.platform, settings: next });
    if (!next.keepHistory) for (const job of this.jobs.values()) if (job.status === 'completed' && !job.historyCleared) this.forgetCompleted(job);
    this.emit('settings'); this.emit('change'); return { message: '内容收集设置已保存，新任务使用新设置。', settings: next };
  }
  async create({ input, options = {}, preview = false, force = false }) {
    if (this.configError) throw Error(this.configError);
    const chosen = preferences(options, this.settings);
    if (!preview && !chosen.destination) throw Error('请先选择保存到哪个 Notion 数据库或父页面。');
    const results = [];
    const sources = parseInputs(input).map(source => source.kind === 'local' ? { source: describeLocal(source.path) } : { url: source.url });
    for (const entry of sources) {
      const url = entry.url || 'local-media:' + entry.source.signature;
      const key = dedupeKey(url, chosen);
      const existing = !force && [...this.jobs.values()].find(job => job.dedupe === key);
      if (existing) {
        if (['cancelled', 'failed', 'interrupted', 'partial'].includes(existing.status)) this.retry(existing.id);
        if (existing.status === 'completed') this.latestCompletion = { id: existing.id, title: existing.document?.title || existing.url, page: existing.page };
        results.push({ id: existing.id, existing: true, status: existing.status, page: existing.page }); continue;
      }
      const job = { version: 1, id: randomUUID(), url, dedupe: key, createdAt: new Date().toISOString(), status: 'queued', message: '等待读取内容…',
        options: structuredClone(chosen), previewOnly: preview, resources: {}, analyses: {}, warnings: [], layout: 'media-at-end',
        ...(entry.source ? { localSource: entry.source, document: localDocument(entry.source) } : {}) };
      this.jobs.set(job.id, job); this.save(job); this.enqueue(job); results.push({ id: job.id });
    }
    return { jobs: results };
  }
  enqueue(job) { if (this.closed || this.queue.includes(job.id) || this.running?.id === job.id) return; job.status = 'queued'; this.save(job); this.queue.push(job.id); void this.pump(); }
  async pump() {
    if (this.running || this.closed) return;
    const id = this.queue.shift(); if (!id) return;
    const job = this.jobs.get(id), controller = new AbortController(); this.running = { id, controller };
    try { await this.process(job, controller.signal); }
    catch (error) { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.message = controller.signal.aborted ? '已停止后续处理；已保存的内容和进度保留。' : safeError(error); this.save(job); }
    finally { this.running = null; this.emit('change'); if (!this.closed) void this.pump(); }
  }
  async process(job, signal) {
    const save = () => this.save(job);
    const progress = message => { job.message = message; save(); };
    if (!job.document) {
      job.status = 'reading'; progress('正在识别链接中的正文、图片、视频和音频…');
      job.document = await this.browser.inspect(job.url, { signal, progress }); job.warnings = [...job.document.warnings]; save();
    }
    if ((job.document.requiresLogin || job.document.incomplete) && !job.allowPartial) { job.status = 'needs_login'; progress('尚未取得完整内容，请登录或在原网页展开正文后重新读取；也可手动保存已获取的部分。'); return; }
    if (job.previewOnly) { job.status = 'awaiting_selection'; progress('已识别内容，请选择要保存的项目与位置。'); return; }
    if (!job.options.destination) throw Error('请先选择保存位置。');
    const selected = layoutNodes(selectedNodes(job.document, job.options, job.selectedIds), job.layout);
    if (!selected.length) throw Error('请至少选择一项要保存的内容。');
    if (job.options.keepLocal) { prepareLocalOutput(job, this.downloadsDirectory); save(); }
    const { limit } = await this.notion.verifyTarget(job.options.destination, signal);
    for (const node of selected) {
      if (!mediaKinds.has(node.kind)) continue; signal.throwIfAborted();
      const resource = job.resources[node.id] ||= {}, analysis = job.analyses[node.id] ||= {};
      delete resource.error; analysis.errors = [];
      try {
        if (!resource.asset || !fs.existsSync(resource.asset.path)) {
          job.status = 'downloading'; save();
          if (job.options.keepLocal && !ownedExport(job)) throw Error('资料文件夹已被手动删除，请停止任务或重新收集。');
          const directory = job.options.keepLocal ? path.join(job.exportDirectory, '素材', String(selected.indexOf(node) + 1).padStart(2, '0') + '-' + ({ image: '图片', video: '视频', audio: '音频' }[node.kind])) : path.join(this.location(job), 'working', node.id);
          resource.asset = job.localSource ? await this.media.importLocal(job.localSource, directory, { signal, progress }) : await this.media.acquire({ ...node, sourceUrl: job.document.url }, directory, { signal, progress }); save();
        }
        if (job.options.transcribe && ['audio', 'video'].includes(node.kind) && !analysis.transcript) {
          job.status = 'processing'; save();
          try { analysis.transcript = await this.media.transcript(resource.asset, { signal, progress }); }
          catch (error) { signal.throwIfAborted(); analysis.errors.push(safeError(error)); } save();
        }
        if (job.options.vision && ['image', 'video'].includes(node.kind) && !analysis.vision) {
          job.status = 'processing'; save();
          try { analysis.vision = await this.media.vision(resource.asset, { signal, progress }); }
          catch (error) { signal.throwIfAborted(); analysis.errors.push(safeError(error)); } save();
        }
        if (!resource.parts) { resource.parts = await this.media.prepareUpload(resource.asset, job.options, limit, { signal, progress }); save(); }
        resource.uploads ||= [];
        for (let i = 0; i < resource.parts.length; i++) {
          job.status = 'uploading'; progress(`正在上传${node.kind === 'image' ? '图片' : node.kind === 'video' ? '视频' : '音频'} ${i + 1}/${resource.parts.length}…`);
          resource.uploads[i] ||= {};
          if (!resource.uploads[i].uploaded) await this.notion.upload(resource.parts[i], job, resource.uploads[i], save, signal);
        }
      } catch (error) { signal.throwIfAborted(); resource.error = safeError(error); save(); }
    }
    if (job.options.extraction.mode !== 'off') {
      job.status = 'processing'; save();
      try { job.extraction = await this.extractor.run(job, selected, { signal, progress, save }); }
      catch (error) { signal.throwIfAborted(); job.extraction = { error: safeError(error) }; } save();
    }
    const failures = selected.filter(node => mediaKinds.has(node.kind) && (job.resources[node.id]?.error || job.analyses[node.id]?.errors?.length));
    job.warnings = [...job.document.warnings, ...failures.map(node => `素材 ${selected.indexOf(node) + 1} 尚待补全：${job.resources[node.id]?.error || job.analyses[node.id].errors.join('；')}`)];
    if (job.extraction?.error) job.warnings.push('内容提取待完成：' + job.extraction.error);
    job.status = 'saving'; progress('正在按原文顺序保存到 Notion，并核验内容…');
    await this.notion.write(job, selected, save, signal);
    if (job.options.keepLocal) this.exportLocal(job, selected);
    job.status = failures.length || job.document.incomplete || job.extraction?.error ? 'partial' : 'completed';
    job.message = job.status === 'completed' ? '已保存到 Notion，正文和媒体顺序已核验。' : '已保存获取到的内容；有未完成项目，可补登录或配置后重试。'; save();
    if (job.status === 'completed' && !job.options.keepLocal) this.releaseWorkingFiles(job);
    this.emit('finished', { id: job.id, title: job.document.title, status: job.status, url: job.page?.url, pageId: job.page?.id });
    if (job.status === 'completed') {
      this.latestCompletion = { id: job.id, title: job.document.title, page: job.page };
      if (!this.settings.keepHistory) this.forgetCompleted(job);
    }
  }
  forgetCompleted(job) {
    try {
      clearCompleted(this.root, this.directory, job.id);
      const receipt = { id: job.id, version: 1, createdAt: job.createdAt, url: job.url, dedupe: job.dedupe, status: 'completed', message: '已保存到 Notion，本地临时记录已清理。',
        options: job.options, page: job.page, document: { title: job.document?.title || job.url, nodes: [] }, historyCleared: true, ...(job.localSource ? { localSource: { name: job.localSource.name } } : {}) };
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
  cancel(id) {
    const job = this.jobs.get(id); if (!job) throw Error('任务不存在。');
    this.queue = this.queue.filter(value => value !== id);
    if (this.running?.id === id) this.running.controller.abort(Error('用户停止任务。'));
    else if (job.status !== 'completed') { job.status = 'cancelled'; job.message = '已停止，文件和已有页面保留。'; this.save(job); }
    return { id };
  }
  retry(id) {
    const job = this.jobs.get(id);
    if (!job || !['failed', 'partial', 'cancelled', 'interrupted', 'needs_login'].includes(job.status)) throw Error('此任务当前不需要重试。');
    if (job.document?.incomplete && !job.page) { delete job.document; job.warnings = []; }
    this.enqueue(job); return { id };
  }
  deleteTask(id) {
    const job = this.jobs.get(id);
    if (!job) throw Error('任务不存在或已经删除。');
    if (!deletableStates.has(job.status) || this.running?.id === id || this.queue.includes(id)) throw Error('请先停止任务并等待处理结束，再删除此任务。');
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
      select: ['id', 'ids', 'options', 'allowPartial'], cancel: ['id'], retry: ['id'], 'delete-task': ['id'], reread: ['id'], accounts: [], login: ['site'], prepare: [], 'create-library': ['workspaceId', 'parentId'] };
    try {
      if (!Object.hasOwn(allowed, action) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed[action].includes(k))) throw Error('无法识别此项收集操作。');
      let result;
      if (action === 'state') result = this.status();
      else if (action === 'configure') result = await this.configure(input.settings);
      else if (action === 'workspaces') result = await this.notion.workspaces(AbortSignal.timeout(45000));
      else if (action === 'destinations') result = await this.notion.search(input.workspaceId, input.query, input.cursors, AbortSignal.timeout(60000));
      else if (action === 'create') result = await this.create(input);
      else if (action === 'select') result = this.select(input.id, input);
      else if (action === 'cancel') result = this.cancel(input.id);
      else if (action === 'retry') result = this.retry(input.id);
      else if (action === 'delete-task') result = this.deleteTask(input.id);
      else if (action === 'reread') result = this.reread(input.id);
      else if (action === 'accounts') result = await this.browser.accounts(AbortSignal.timeout(60000));
      else if (action === 'login') { if (typeof input.site !== 'string' || input.site.length > 8192) throw Error('网站地址无效。'); result = await this.browser.login(input.site, AbortSignal.timeout(60000)); }
      else if (action === 'prepare') result = await this.prepare();
      else if (action === 'create-library') result = await this.createLibrary(input.workspaceId, input.parentId);
      return { ok: true, result };
    } catch (error) { return { ok: false, error: safeError(error) }; }
  }
  close() { this.closed = true; this.running?.controller.abort(Error('应用退出，任务进度保留。')); }
}
module.exports = { CollectionService, activeStates, safeError };
