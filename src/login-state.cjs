const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { createDesktopPlatform } = require('./platform/index.cjs');

const PARTITIONS = ['Partitions/notion/Network/Cookies', 'Network/Cookies'];
const MAC_PARTITIONS = ['Partitions/notion/Cookies', 'Cookies'];
const MAC_KEYCHAIN_MARKER = '.notion-switch-use-original-keychain';
const SIDECARS = ['-wal', '-shm', '-journal'];
const STAGE_ID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const messages = {
  platform_unsupported: '此平台尚不支持复制本机登录资料，请直接在隔离 Notion 窗口中登录。',
  source_missing: '未找到原版 Notion 的本机登录资料，请先安装并登录原版 Notion。',
  source_locked: '原版 Notion 正占用登录数据库。请保存内容并完全退出原版 Notion，再点击“同步登录”；不需要删除或迁移原版资料。',
  no_login: '未发现有效的 Notion 登录 Cookie。请先在原版 Notion 登录，再重试同步。',
  encryption_missing: '原版 Notion 的本机加密状态不受支持，尚未修改隔离登录资料。',
  busy: 'AI 正在生成或修改页面，请等待完成或停止后再同步登录。',
  syncing: '正在准备登录同步，请稍候，不要重复点击。',
  stage_invalid: '本机登录同步暂存资料不完整，请重新点击同步登录。',
  root_invalid: '登录同步目录校验失败，尚未修改登录资料。',
  helper_unavailable: '本机登录同步组件无法启动，请通过项目内启动入口重新打开 NotionSwitch 后重试。',
  parent_running: 'NotionSwitch 尚未完全退出，未替换登录数据库。请重新打开配置窗口后重试。',
  target_locked: '隔离 Notion 的登录数据库仍被占用，未替换登录资料。请退出隔离原型后重试。',
  apply_failed: '登录同步未完成，已尝试恢复原有登录资料；请在配置窗口查看结果后重试。',
  rollback_failed: '登录同步未完成，自动恢复也未全部完成。本机已保留备份，请联系开发者恢复登录资料。',
  stage_failed: '读取本机 Notion 登录资料失败，尚未修改隔离登录资料。'
};
function failure(code) { const error = new Error(messages[code] || messages.stage_failed); error.loginCode = code; return error; }
function safeError(error, fallback = 'stage_failed') { return failure(Object.hasOwn(messages, error?.loginCode) ? error.loginCode : fallback); }
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const isWithin = (root, candidate) => { const relative = path.relative(root, candidate); return !relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
function checkedRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw failure('root_invalid');
  const root = path.resolve(value);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory() || !samePath(fs.realpathSync(root), root)) throw failure('root_invalid');
  return root;
}
function within(root, ...parts) {
  const result = path.resolve(root, ...parts);
  if (!isWithin(root, result)) throw failure('root_invalid');
  let cursor = result;
  while (isWithin(root, cursor) && !samePath(cursor, root)) {
    if (fs.lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw failure('root_invalid');
    cursor = path.dirname(cursor);
  }
  return result;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function writeJson(file, value) {
  const temporary = file + '.tmp-' + randomUUID();
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flush: true });
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const locked = error => [5, 6, 14].includes(error?.errcode) || ['EACCES', 'EPERM', 'SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error?.code) || /busy|locked|unable to open database file|access.*denied|permission.*denied/i.test(String(error?.message || ''));
const sqlite = () => require('node:sqlite').DatabaseSync;
function rows(database, sql, values = []) { const statement = database.prepare(sql); statement.setReadBigInts(true); return statement.all(...values); }
function openReadOnly(file) { const database = new (sqlite())(file, { readOnly: true }); database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000'); return database; }
const notionHost = host => typeof host === 'string' && ['notion.so', 'notion.com'].some(domain => host.toLowerCase() === domain || host.toLowerCase().endsWith('.' + domain));
function validToken(row, now = Date.now()) {
  if (row.name !== 'token_v2' || !notionHost(row.host_key)) return false;
  const payload = typeof row.value === 'string' && row.value.length || row.encrypted_value?.byteLength;
  if (!payload) return false;
  let expiry; try { expiry = BigInt(row.expires_utc || 0); } catch { return false; }
  return expiry === 0n || expiry > BigInt(now) * 1000n + 11644473600000000n;
}
function readCookies(file, now = Date.now()) {
  if (!fs.existsSync(file)) return null;
  let database;
  try {
    database = openReadOnly(file);
    const tables = rows(database, "SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('meta','cookies')");
    if (tables.length !== 2 || tables.some(table => !/^CREATE\s+TABLE\s/i.test(table.sql))) throw failure('encryption_missing');
    const columns = rows(database, 'PRAGMA table_info(cookies)').map(column => column.name);
    if (['host_key', 'name', 'value', 'encrypted_value'].some(column => !columns.includes(column))) throw failure('encryption_missing');
    const cookies = rows(database, "SELECT * FROM cookies WHERE lower(host_key) IN ('notion.so','.notion.so','notion.com','.notion.com') OR lower(host_key) LIKE '%.notion.so' OR lower(host_key) LIKE '%.notion.com'");
    const metaColumns = rows(database, 'PRAGMA table_info(meta)').map(column => column.name);
    return { tables, columns, cookies, totalCookies: Number(rows(database, 'SELECT count(*) AS total FROM cookies')[0].total), metaColumns, meta: rows(database, 'SELECT * FROM meta'), userVersion: Number(rows(database, 'PRAGMA user_version')[0].user_version), hasLogin: cookies.some(row => validToken(row, now)) };
  } catch (error) { if (locked(error)) throw failure('source_locked'); throw safeError(error); }
  finally { database?.close(); }
}
function encryption(directory) {
  const file = path.join(directory, 'Local State');
  if (!fs.existsSync(file)) throw failure('source_missing');
  const state = readJson(file), value = state.os_crypt;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['encrypted_key', 'app_bound_encrypted_key'].some(key => typeof value[key] === 'string' && value[key].length)) throw failure('encryption_missing');
  return value;
}
function requireLoginSync(platform) { if (!platform.capabilities.syncLogin || !['windows-local-copy', 'macos-keychain-copy'].includes(platform.login.strategy)) throw failure('platform_unsupported'); }
const usesMacKeychain = platform => platform.login.strategy === 'macos-keychain-copy';
const partitionsFor = platform => usesMacKeychain(platform) ? MAC_PARTITIONS : PARTITIONS;
function sourceDirectory(platform) { if (!platform.login.sourceRoot) throw failure('source_missing'); return platform.login.sourceRoot; }
function inspectDirectory(directory, now, platform) {
  const result = { available: fs.existsSync(directory), hasLogin: false, known: true, locked: false, encryptionAvailable: false };
  if (!result.available) return result;
  if (usesMacKeychain(platform)) result.encryptionAvailable = true;
  else try { encryption(directory); result.encryptionAvailable = true; } catch {}
  for (const relative of partitionsFor(platform)) {
    try { const content = readCookies(path.join(directory, relative), now); result.hasLogin ||= !!content?.hasLogin; }
    catch (error) { result.known = false; result.locked ||= error.loginCode === 'source_locked'; }
  }
  return result;
}
function safeResult(root) {
  try {
    const saved = readJson(within(root, 'login-sync-result.json'));
    const status = ['applied', 'rolled-back', 'failed', 'rollback-failed', 'applying'].includes(saved.status) ? saved.status : 'failed';
    return { status, at: typeof saved.at === 'string' ? saved.at : undefined, message: status === 'applied' ? '本机登录资料已同步，仍需打开 Notion 确认会话是否有效。' : status === 'rolled-back' ? '本次同步失败，原有隔离登录资料已恢复。' : status === 'applying' ? '上次同步尚未记录完成，请重新同步或联系开发者。' : messages[saved.errorCode] || messages.apply_failed };
  } catch { return undefined; }
}
function inspectLogin({ root, platform = createDesktopPlatform(), sourceRoot, now = Date.now() }) {
  root = checkedRoot(root);
  if (!platform.capabilities.syncLogin) return { syncSupported: false, loginStrategy: platform.login.strategy, sourceAvailable: false, sourceHasLogin: null, hasLogin: null, targetLoginKnown: false, serverValidated: false };
  sourceRoot ||= sourceDirectory(platform);
  const original = inspectDirectory(path.resolve(sourceRoot), now, platform), target = inspectDirectory(within(root, 'profile'), now, platform);
  return { sourceAvailable: original.available, sourceHasLogin: original.known ? original.hasLogin && original.encryptionAvailable : null, sourceLocked: original.locked, hasLogin: target.known ? target.hasLogin && target.encryptionAvailable : null, targetLoginKnown: target.known, serverValidated: false, lastSync: safeResult(root) };
}
function writeCookieDatabase(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new (sqlite())(file);
  try {
    database.exec('PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE');
    for (const table of content.tables) database.exec(table.sql);
    for (const [table, columns, data] of [['meta', content.metaColumns, content.meta], ['cookies', content.columns, content.cookies]]) {
      const quote = name => '"' + name.replaceAll('"', '""') + '"';
      const insert = database.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      for (const row of data) insert.run(...columns.map(column => row[column]));
    }
    database.exec(`PRAGMA user_version = ${content.userVersion}; COMMIT`);
  } catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
  finally { database.close(); if (fs.existsSync(file)) fs.chmodSync(file, 0o600); }
}
function stageLogin({ root, platform = createDesktopPlatform(), sourceRoot, now = Date.now(), readCookieFile = readCookies }) {
  requireLoginSync(platform); sourceRoot ||= sourceDirectory(platform);
  root = checkedRoot(root); sourceRoot = path.resolve(sourceRoot);
  if (isWithin(root, sourceRoot) || isWithin(sourceRoot, root) || !fs.existsSync(sourceRoot)) throw failure('source_missing');
  const stageId = randomUUID(), directory = within(root, 'login-staging', stageId), parts = partitionsFor(platform), mac = usesMacKeychain(platform);
  try {
    let crypt, contents;
    try { if (!mac) crypt = encryption(sourceRoot); contents = parts.map(relative => readCookieFile(path.join(sourceRoot, relative), now)); }
    catch (error) { if (locked(error)) throw failure('source_locked'); throw error; }
    const fallback = contents.find(content => content?.hasLogin);
    if (!fallback) throw failure('no_login');
    if (mac && contents.filter(Boolean).flatMap(content => content.cookies).some(cookie => cookie.encrypted_value?.byteLength && Buffer.from(cookie.encrypted_value).subarray(0, 3).toString() !== 'v10')) throw failure('encryption_missing');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const partitions = [];
    for (let index = 0; index < parts.length; index++) {
      const relative = parts[index], content = contents[index]?.hasLogin ? contents[index] : fallback;
      const file = within(root, 'login-staging', stageId, relative);
      writeCookieDatabase(file, content);
      partitions.push({ relative, notionCookieCount: content.cookies.length, sha256: hashFile(file) });
    }
    let keyMetadata = { strategy: 'macos-keychain-copy' };
    if (!mac) {
      const stateFile = within(root, 'login-staging', stageId, 'Local State');
      fs.writeFileSync(stateFile, JSON.stringify({ os_crypt: crypt }), { mode: 0o600, flush: true });
      keyMetadata = { localStateSha256: hashFile(stateFile) };
    }
    writeJson(within(root, 'login-staging', stageId, 'manifest.json'), { version: 1, stageId, at: new Date(now).toISOString(), partitions, ...keyMetadata });
    return { stageId, partitions: partitions.map(({ relative, notionCookieCount }) => ({ relative, notionCookieCount })), hasLogin: true, sourceOpenedReadOnly: true, onlyNotionDomains: true, decrypted: false, pageDatabasesCopied: false, serverValidated: false };
  } catch (error) {
    if (fs.existsSync(directory)) { within(root, 'login-staging', stageId); fs.rmSync(directory, { recursive: true, force: true }); }
    throw safeError(error);
  }
}
function readStagedMetadata({ root, stageId, platform = createDesktopPlatform() }) {
  requireLoginSync(platform);
  root = checkedRoot(root);
  if (!STAGE_ID.test(stageId || '')) throw failure('stage_invalid');
  try {
    const directory = within(root, 'login-staging', stageId), manifest = readJson(within(root, 'login-staging', stageId, 'manifest.json')), parts = partitionsFor(platform);
    if (manifest.version !== 1 || manifest.stageId !== stageId || !Array.isArray(manifest.partitions) || manifest.partitions.length !== parts.length) throw failure('stage_invalid');
    for (let index = 0; index < parts.length; index++) {
      const relative = parts[index], metadata = manifest.partitions[index], file = within(root, 'login-staging', stageId, relative);
      if (metadata.relative !== relative || metadata.sha256 !== hashFile(file)) throw failure('stage_invalid');
      const content = readCookies(file);
      if (!content?.hasLogin || content.totalCookies !== content.cookies.length || content.cookies.some(row => !notionHost(row.host_key)) || content.cookies.length !== metadata.notionCookieCount) throw failure('stage_invalid');
      if (usesMacKeychain(platform) && content.cookies.some(cookie => cookie.encrypted_value?.byteLength && Buffer.from(cookie.encrypted_value).subarray(0, 3).toString() !== 'v10')) throw failure('stage_invalid');
    }
    if (usesMacKeychain(platform)) { if (manifest.strategy !== 'macos-keychain-copy') throw failure('stage_invalid'); }
    else {
      if (manifest.localStateSha256 !== hashFile(within(root, 'login-staging', stageId, 'Local State'))) throw failure('stage_invalid');
      encryption(directory);
    }
    return { stageId, partitions: manifest.partitions.map(({ relative, notionCookieCount }) => ({ relative, notionCookieCount })) };
  } catch { throw failure('stage_invalid'); }
}
async function waitForProcessExit(pid, { timeoutMs = 30000, intervalMs = 200, isAlive = value => { try { process.kill(value, 0); return true; } catch (error) { return error.code === 'EPERM'; } } } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) throw failure('parent_running');
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) { if (Date.now() >= deadline) throw failure('parent_running'); await sleep(intervalMs); }
}
function assertTargetUnlocked(file) {
  if (!fs.existsSync(file)) return;
  let database;
  try { database = new (sqlite())(file); database.exec('PRAGMA busy_timeout = 1000; BEGIN EXCLUSIVE; ROLLBACK'); }
  catch { throw failure('target_locked'); }
  finally { database?.close(); }
}
function install(file, source, temporaryFiles) {
  const temporary = file + '.notion-switch-' + randomUUID() + '.tmp'; temporaryFiles.push(temporary);
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL); fs.renameSync(temporary, file);
}
async function mergedMacCookies(file, source, temporaryFiles) {
  if (!fs.existsSync(file)) return source;
  const temporary = file + '.notion-switch-merge-' + randomUUID() + '.tmp'; temporaryFiles.push(temporary);
  const original = openReadOnly(file);
  try { await require('node:sqlite').backup(original, temporary); } finally { original.close(); }
  fs.chmodSync(temporary, 0o600);
  const content = readCookies(source), database = new (sqlite())(temporary);
  try {
    const columns = rows(database, 'PRAGMA table_info(cookies)').map(column => column.name);
    if (!content || columns.length !== content.columns.length || content.columns.some(column => !columns.includes(column))) throw failure('stage_invalid');
    database.exec('BEGIN IMMEDIATE');
    database.exec("DELETE FROM cookies WHERE lower(host_key) IN ('notion.so','.notion.so','notion.com','.notion.com') OR lower(host_key) LIKE '%.notion.so' OR lower(host_key) LIKE '%.notion.com'");
    const quote = name => '"' + name.replaceAll('"', '""') + '"';
    const insert = database.prepare(`INSERT INTO cookies (${content.columns.map(quote).join(',')}) VALUES (${content.columns.map(() => '?').join(',')})`);
    for (const cookie of content.cookies) insert.run(...content.columns.map(column => cookie[column]));
    database.exec('COMMIT');
  } catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
  finally { database.close(); }
  return temporary;
}
async function applyStagedLogin({ root, stageId, parentPid, platform = createDesktopPlatform(), waitForExit = waitForProcessExit, beforeInstall = () => {} }) {
  requireLoginSync(platform);
  root = checkedRoot(root);
  const stage = readStagedMetadata({ root, stageId, platform });
  await waitForExit(parentPid);
  const profile = within(root, 'profile'), backupId = randomUUID(), backup = within(root, 'login-backups', backupId), temporaryFiles = [], mac = usesMacKeychain(platform), parts = partitionsFor(platform);
  const targets = [...parts.flatMap(relative => [relative, ...SIDECARS.map(suffix => relative + suffix)]), ...(mac ? [MAC_KEYCHAIN_MARKER] : ['Local State'])];
  const previous = targets.map(relative => ({ relative, exists: fs.existsSync(within(root, 'profile', relative)) }));
  let changed = false;
  const record = value => writeJson(within(root, 'login-sync-result.json'), { version: 1, stageId, backupId, at: new Date().toISOString(), sourceOpenedReadOnly: true, onlyNotionDomains: true, decrypted: false, pageDatabasesCopied: false, serverValidated: false, ...value });
  try {
    for (const relative of parts) assertTargetUnlocked(within(root, 'profile', relative));
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const item of previous) if (item.exists) { const file = within(root, 'login-backups', backupId, item.relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(within(root, 'profile', item.relative), file); }
    writeJson(within(root, 'login-backups', backupId, 'manifest.json'), { version: 1, stageId, files: previous });
    let replacement;
    if (!mac) {
      const statePath = within(root, 'profile', 'Local State'), targetState = fs.existsSync(statePath) ? readJson(statePath) : {};
      replacement = within(root, 'login-staging', stageId, 'Local State.merged');
      fs.writeFileSync(replacement, JSON.stringify({ ...targetState, os_crypt: encryption(within(root, 'login-staging', stageId)) }), { mode: 0o600, flush: true });
    }
    const macSources = new Map();
    if (mac) for (const relative of parts) macSources.set(relative, await mergedMacCookies(within(root, 'profile', relative), within(root, 'login-staging', stageId, relative), temporaryFiles));
    record({ status: 'applying' });
    for (const [index, relative] of [...parts, ...(mac ? [] : ['Local State'])].entries()) {
      const file = within(root, 'profile', relative); fs.mkdirSync(path.dirname(file), { recursive: true });
      changed = true; beforeInstall(relative, index);
      if (relative !== 'Local State') for (const suffix of SIDECARS) { const sidecar = within(root, 'profile', relative + suffix); if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar); }
      install(file, relative === 'Local State' ? replacement : mac ? macSources.get(relative) : within(root, 'login-staging', stageId, relative), temporaryFiles);
    }
    if (mac) fs.writeFileSync(within(root, 'profile', MAC_KEYCHAIN_MARKER), 'Notion\n', { mode: 0o600, flush: true });
    const result = { status: 'applied', partitions: stage.partitions, hasLogin: true }; record(result);
    return { ...result, backupId, serverValidated: false };
  } catch (error) {
    let restored = true;
    if (changed) for (const item of previous) {
      try {
        const file = within(root, 'profile', item.relative);
        if (item.exists) { fs.mkdirSync(path.dirname(file), { recursive: true }); install(file, within(root, 'login-backups', backupId, item.relative), temporaryFiles); }
        else if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch { restored = false; }
    }
    const code = !restored ? 'rollback_failed' : error.loginCode === 'target_locked' ? 'target_locked' : 'apply_failed';
    try { record({ status: changed && restored ? 'rolled-back' : !restored ? 'rollback-failed' : 'failed', errorCode: code }); } catch {}
    throw failure(code);
  } finally { for (const temporary of temporaryFiles) { if (isWithin(profile, temporary) && fs.existsSync(temporary)) { try { within(root, path.relative(root, temporary)); fs.unlinkSync(temporary); } catch {} } } }
}

class LoginService {
  constructor({ root, platform = createDesktopPlatform(), isBusy = () => false, onRestart = () => {}, getTargetLoginStatus, runHelper, launchApply, currentPid = process.pid, spawnImpl = spawn, execFileImpl = execFile } = {}) {
    this.platform = platform;
    this.root = checkedRoot(root); this.isBusy = isBusy; this.onRestart = onRestart; this.getTargetLoginStatus = getTargetLoginStatus; this.currentPid = currentPid; this.spawnImpl = spawnImpl; this.execFileImpl = execFileImpl; this.syncing = false;
    this.runHelper = runHelper || this.external.bind(this);
    this.launchApply = launchApply || this.startApplyWorker.bind(this);
  }
  runtime() {
    try {
      const file = within(this.root, 'launcher.local.json'), settings = readJson(file), executable = settings.nodeExecutable;
      if (!this.platform.isNodeExecutable(executable)) throw failure('helper_unavailable');
      const project = usesMacKeychain(this.platform) ? fs.realpathSync(settings.projectDirectory) : path.dirname(this.root), helper = path.join(project, 'scripts', 'login-helper.cjs'), reopen = path.join(project, 'scripts', 'open-settings.mjs');
      if (!fs.statSync(helper).isFile() || !fs.statSync(reopen).isFile()) throw failure('helper_unavailable');
      return { executable, helper };
    } catch { throw failure('helper_unavailable'); }
  }
  external(action) {
    requireLoginSync(this.platform);
    const { executable, helper } = this.runtime();
    return new Promise((resolve, reject) => {
      this.execFileImpl(executable, [helper, action, '--root', this.root], { windowsHide: true, timeout: 30000, maxBuffer: 65536, env: { ...process.env, NODE_NO_WARNINGS: '1' } }, (error, stdout) => {
        try { const result = JSON.parse(stdout || '{}'); if (!result.ok) throw failure(Object.hasOwn(messages, result.code) ? result.code : 'helper_unavailable'); if (error) throw failure('helper_unavailable'); resolve(result.result); }
        catch (caught) { reject(safeError(caught, 'helper_unavailable')); }
      });
    });
  }
  startApplyWorker(stageId) {
    requireLoginSync(this.platform);
    const { executable, helper } = this.runtime();
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(executable, [helper, 'apply-and-restart', '--root', this.root, '--stage', stageId, '--parent-pid', String(this.currentPid)], { windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
      let settled = false;
      const timeout = setTimeout(() => finish(false), 10000);
      const finish = accepted => {
        if (settled) return; settled = true; clearTimeout(timeout);
        child.removeAllListeners('message'); child.removeAllListeners('error'); child.removeAllListeners('exit'); child.on('error', () => {});
        if (child.connected) { try { child.disconnect(); } catch {} } child.unref();
        accepted ? resolve() : reject(failure('helper_unavailable'));
      };
      child.once('message', message => finish(message?.type === 'login-sync-ready' && message.stageId === stageId));
      child.once('error', () => finish(false)); child.once('exit', () => finish(false));
    });
  }
  async status() {
    const support = { syncSupported: this.platform.capabilities.syncLogin, loginStrategy: this.platform.login.strategy };
    let data; try { data = support.syncSupported ? await this.runHelper('status') : {}; } catch (error) { return { ...support, sourceAvailable: false, sourceHasLogin: null, hasLogin: null, targetLoginKnown: false, syncing: this.syncing, serverValidated: false, message: safeError(error, 'helper_unavailable').message }; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...support, sourceAvailable: false, sourceHasLogin: null, hasLogin: null, targetLoginKnown: false, syncing: this.syncing, serverValidated: false, message: messages.helper_unavailable };
    let hasLogin = typeof data.hasLogin === 'boolean' ? data.hasLogin : null;
    if (this.getTargetLoginStatus) { try { const current = await this.getTargetLoginStatus(); hasLogin = typeof current === 'boolean' ? current : typeof current?.hasLogin === 'boolean' ? current.hasLogin : null; } catch { hasLogin = null; } }
    const last = data.lastSync;
    return { ...support, sourceAvailable: data.sourceAvailable === true, sourceHasLogin: typeof data.sourceHasLogin === 'boolean' ? data.sourceHasLogin : null, hasLogin, targetLoginKnown: hasLogin !== null, syncing: this.syncing, serverValidated: false,
      ...(last && ['applied', 'rolled-back', 'failed', 'rollback-failed', 'applying'].includes(last.status) ? { lastSync: { status: last.status, at: typeof last.at === 'string' ? last.at : undefined, message: last.status === 'applied' ? '本机登录资料已同步，打开 Notion 确认会话是否有效。' : last.status === 'rolled-back' ? '同步失败，原有登录资料已恢复。' : messages.apply_failed } } : {}),
      message: !support.syncSupported ? messages.platform_unsupported : data.sourceLocked ? messages.source_locked : hasLogin ? '已检测到隔离原型的本机登录 Cookie；检测不代表服务器会话仍然有效。' : '可同步原版 Notion 的本机登录；不复制页面数据库或密码，也不向服务器发送登录资料。' };
  }
  async sync() {
    requireLoginSync(this.platform);
    if (this.syncing) throw failure('syncing');
    if (await this.isBusy()) throw failure('busy');
    this.syncing = true;
    let restarting = false;
    try {
      const stage = await this.runHelper('stage');
      if (!STAGE_ID.test(stage?.stageId || '')) throw failure('stage_invalid');
      if (await this.isBusy()) throw failure('busy');
      await this.launchApply(stage.stageId);
      if (await this.isBusy()) throw failure('busy');
      await this.onRestart(); restarting = true;
      return { restarting: true, message: '登录资料已在本机准备完成，正在重启 NotionSwitch 以完成同步。' };
    } catch (error) { throw safeError(error, 'helper_unavailable'); }
    finally { if (!restarting) this.syncing = false; }
  }
}

module.exports = { LoginService, inspectLogin, stageLogin, readStagedMetadata, applyStagedLogin, waitForProcessExit, safeError, PARTITIONS };
