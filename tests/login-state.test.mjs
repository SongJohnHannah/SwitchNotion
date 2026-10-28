import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
const { LoginService, inspectLogin, stageLogin, readStagedMetadata, applyStagedLogin, waitForProcessExit, PARTITIONS } = createRequire(import.meta.url)('../src/login-state.cjs');
const { createDesktopPlatform } = createRequire(import.meta.url)('../src/platform/index.cjs');
const windows = createDesktopPlatform({ id: 'win32' });
const COOKIE_SECRET = 'fixture-cookie-secret-do-not-emit', CRYPT_SECRET = 'fixture-crypt-secret-do-not-emit';
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function rootOnly(t) {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-login-service-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function filesBelow(directory, prefix = '') {
  if (!fs.existsSync(directory)) return {};
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(prefix, entry.name), file = path.join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(filesBelow(file, relative)) : [[relative, digest(file)]];
  }));
}
function cookieDatabase(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY,value LONGVARCHAR); CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,expires_utc INTEGER NOT NULL);');
  db.prepare('INSERT INTO meta VALUES (?,?)').run('version', '24');
  const insert = db.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?)');
  for (const row of rows) insert.run(13320000000000123n, row.host, row.name || 'token_v2', row.value || '', Buffer.from(row.payload || COOKIE_SECRET), row.expires ?? 20000000000000000n);
  db.close();
}
function fixture(t, { valid = true } = {}) {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'test-login-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), parent); fs.rmSync(directory, { recursive: true, force: true }); });
  const root = path.join(directory, 'state'), sourceRoot = path.join(directory, 'source'), profile = path.join(root, 'profile');
  fs.mkdirSync(sourceRoot, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: CRYPT_SECRET }, original_preferences: { secretFixture: 'must-not-copy' } }));
  fs.writeFileSync(path.join(sourceRoot, 'page-content.db'), 'source-page-content-must-not-copy');
  cookieDatabase(path.join(sourceRoot, PARTITIONS[0]), [
    { host: '.notion.so', expires: valid ? 20000000000000000n : 1n },
    { host: 'deep.subdomain.notion.com', name: 'preferences' },
    { host: 'notion.com', name: 'workspace' },
    { host: 'evilnotion.com' }, { host: 'notion.com.evil.example' }, { host: '.accounts.example' }
  ]);
  fs.writeFileSync(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'old-local-encryption-fixture' }, user_preferences: { theme: 'dark' } }));
  fs.writeFileSync(path.join(profile, 'page-content.db'), 'target-page-content-must-remain');
  for (const relative of PARTITIONS) cookieDatabase(path.join(profile, relative), [{ host: '.notion.so', payload: 'old-cookie-fixture' }]);
  return { root, sourceRoot, profile, directory, platform: windows };
}
function allCookies(file) { const db = new DatabaseSync(file, { readOnly: true }); try { const statement = db.prepare('SELECT * FROM cookies'); statement.setReadBigInts(true); return statement.all(); } finally { db.close(); } }

test('Mac sync uses Keychain-encrypted Notion cookies, preserves Local State and backs up the target', async t => {
  const root = rootOnly(t), sourceRoot = path.join(root, 'fixture-source'), separateRoot = path.join(root, 'state');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(path.join(separateRoot, 'profile'), { recursive: true });
  const platform = createDesktopPlatform({ id: 'darwin', arch: 'arm64', home: root });
  const parts = ['Partitions/notion/Cookies', 'Cookies'];
  cookieDatabase(path.join(sourceRoot, parts[0]), [{ host: '.notion.so', payload: 'v10fixture-encrypted' }, { host: '.example.com', payload: 'v10other' }]);
  for (const part of parts) cookieDatabase(path.join(separateRoot, 'profile', part), [{ host: '.notion.so', payload: 'v10old' }, { host: '.example.com', payload: 'v10keep' }]);
  fs.writeFileSync(path.join(separateRoot, 'profile', 'Local State'), 'local-state-unchanged');
  fs.writeFileSync(path.join(separateRoot, 'profile', 'page-content.db'), 'page-data-unchanged');
  const input = { root: separateRoot, sourceRoot, platform }, sourceBefore = filesBelow(sourceRoot), targetBefore = filesBelow(path.join(separateRoot, 'profile'));
  const staged = stageLogin(input);
  assert.deepEqual(filesBelow(sourceRoot), sourceBefore);
  assert.deepEqual(filesBelow(path.join(separateRoot, 'profile')), targetBefore);
  assert.equal(fs.existsSync(path.join(separateRoot, 'login-staging', staged.stageId, 'Local State')), false);
  assert.equal(readStagedMetadata({ root: separateRoot, platform, stageId: staged.stageId }).partitions.length, 2);
  const applied = await applyStagedLogin({ root: separateRoot, platform, stageId: staged.stageId, parentPid: 424242, waitForExit: async () => {} });
  for (const part of parts) {
    assert.deepEqual(allCookies(path.join(separateRoot, 'profile', part)).map(row => row.host_key).sort(), ['.example.com', '.notion.so']);
    assert.equal(digest(path.join(separateRoot, 'login-backups', applied.backupId, part)), targetBefore[part]);
  }
  assert.equal(fs.readFileSync(path.join(separateRoot, 'profile', 'Local State'), 'utf8'), 'local-state-unchanged');
  assert.equal(fs.readFileSync(path.join(separateRoot, 'profile', 'page-content.db'), 'utf8'), 'page-data-unchanged');
  assert.equal(fs.existsSync(path.join(separateRoot, 'profile', '.notion-switch-use-original-keychain')), true);
  assert.equal(applied.serverValidated, false);
});

test('Mac sync restores the existing profile when applying fails', async t => {
  const root = rootOnly(t), sourceRoot = path.join(root, 'fixture-source'), separateRoot = path.join(root, 'state');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(path.join(separateRoot, 'profile'), { recursive: true });
  const platform = createDesktopPlatform({ id: 'darwin', arch: 'arm64', home: root }), part = 'Partitions/notion/Cookies';
  cookieDatabase(path.join(sourceRoot, part), [{ host: '.notion.com', payload: 'v10fixture-encrypted' }]);
  cookieDatabase(path.join(separateRoot, 'profile', part), [{ host: '.notion.so', payload: 'v10previous' }]);
  const before = filesBelow(path.join(separateRoot, 'profile')), staged = stageLogin({ root: separateRoot, sourceRoot, platform });
  await assert.rejects(applyStagedLogin({ root: separateRoot, platform, stageId: staged.stageId, parentPid: 424242, waitForExit: async () => {}, beforeInstall: (_relative, index) => { if (index === 1) throw Error('fixture failure'); } }), /已尝试恢复/);
  assert.deepEqual(filesBelow(path.join(separateRoot, 'profile')), before);
});

test('Mac sync rejects unrecognized cookie encryption', t => {
  const root = rootOnly(t), sourceRoot = path.join(root, 'fixture-source'), separateRoot = path.join(root, 'state');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(separateRoot);
  cookieDatabase(path.join(sourceRoot, 'Partitions/notion/Cookies'), [{ host: '.notion.so', payload: 'v20unknown' }]);
  const platform = createDesktopPlatform({ id: 'darwin', arch: 'arm64', home: root });
  assert.throws(() => stageLogin({ root: separateRoot, sourceRoot, platform }), /加密状态不受支持/);
});

test('login staging reads original SQLite without changing source or target and filters every cookie domain', t => {
  const f = fixture(t), sourceBefore = filesBelow(f.sourceRoot), targetBefore = filesBelow(f.profile);
  const stage = stageLogin(f);
  assert.deepEqual(filesBelow(f.sourceRoot), sourceBefore); assert.deepEqual(filesBelow(f.profile), targetBefore);
  assert.equal(stage.hasLogin, true); assert.equal(stage.partitions.length, 2);
  for (const relative of PARTITIONS) {
    const rows = allCookies(path.join(f.root, 'login-staging', stage.stageId, relative));
    assert.deepEqual(rows.map(row => row.host_key).sort(), ['.notion.so', 'deep.subdomain.notion.com', 'notion.com'].sort());
    assert.equal(rows[0].creation_utc === 13320000000000123n, true);
  }
  const stagedState = JSON.parse(fs.readFileSync(path.join(f.root, 'login-staging', stage.stageId, 'Local State'), 'utf8'));
  assert.deepEqual(Object.keys(stagedState), ['os_crypt']);
  assert.equal(stagedState.os_crypt.encrypted_key === CRYPT_SECRET, true);
  assert.equal(fs.existsSync(path.join(f.root, 'login-staging', stage.stageId, 'page-content.db')), false);
  assert.equal(JSON.stringify(stage).includes(COOKIE_SECRET) || JSON.stringify(stage).includes(CRYPT_SECRET), false);
  assert.equal(readStagedMetadata({ root: f.root, stageId: stage.stageId, platform: windows }).stageId, stage.stageId);
});

test('absent or expired token prevents staging and never overwrites target profile', t => {
  const f = fixture(t, { valid: false }), before = filesBelow(f.profile);
  assert.throws(() => stageLogin(f), /未发现有效/);
  assert.deepEqual(filesBelow(f.profile), before);
  assert.equal(fs.existsSync(path.join(f.root, 'login-staging')), false);
});

test('apply waits for prototype exit, keeps local rollback backup, and preserves unrelated target data', async t => {
  const f = fixture(t), sourceBefore = filesBelow(f.sourceRoot), targetBefore = filesBelow(f.profile), stage = stageLogin(f);
  let waited = false;
  const result = await applyStagedLogin({ root: f.root, stageId: stage.stageId, platform: windows, parentPid: 424242, waitForExit: async pid => { assert.equal(pid, 424242); assert.deepEqual(filesBelow(f.profile), targetBefore); waited = true; } });
  assert.equal(waited, true); assert.equal(result.status, 'applied'); assert.deepEqual(filesBelow(f.sourceRoot), sourceBefore);
  const state = JSON.parse(fs.readFileSync(path.join(f.profile, 'Local State'), 'utf8'));
  assert.equal(state.os_crypt.encrypted_key === CRYPT_SECRET, true); assert.deepEqual(state.user_preferences, { theme: 'dark' }); assert.equal(Object.hasOwn(state, 'original_preferences'), false);
  assert.equal(fs.readFileSync(path.join(f.profile, 'page-content.db'), 'utf8') === 'target-page-content-must-remain', true);
  const backup = path.join(f.root, 'login-backups', result.backupId);
  assert.equal(digest(path.join(backup, 'Local State')) === targetBefore['Local State'], true);
  for (const relative of PARTITIONS) assert.equal(digest(path.join(backup, relative)) === targetBefore[relative], true);
  const saved = fs.readFileSync(path.join(f.root, 'login-sync-result.json'), 'utf8');
  assert.equal(saved.includes(COOKIE_SECRET) || saved.includes(CRYPT_SECRET), false);
  const status = inspectLogin(f); assert.equal(status.hasLogin, true); assert.equal(status.serverValidated, false);
});

test('a failed apply rolls every changed login file back and exposes no secret in the result', async t => {
  const f = fixture(t), before = filesBelow(f.profile), stage = stageLogin(f);
  await assert.rejects(applyStagedLogin({ root: f.root, stageId: stage.stageId, platform: windows, parentPid: 424242, waitForExit: async () => {}, beforeInstall: (_relative, index) => { if (index === 1) throw Error(COOKIE_SECRET); } }), /已尝试恢复/);
  assert.deepEqual(filesBelow(f.profile), before);
  const saved = fs.readFileSync(path.join(f.root, 'login-sync-result.json'), 'utf8');
  assert.equal(JSON.parse(saved).status, 'rolled-back'); assert.equal(saved.includes(COOKIE_SECRET) || saved.includes(CRYPT_SECRET), false);
});

test('locked source asks to exit original Notion without any target change', t => {
  const f = fixture(t), before = filesBelow(f.profile), sourceFile = path.join(f.sourceRoot, PARTITIONS[0]);
  const blocker = new DatabaseSync(sourceFile); blocker.exec('BEGIN EXCLUSIVE');
  try { assert.throws(() => stageLogin(f), /完全退出原版 Notion/); assert.deepEqual(filesBelow(f.profile), before); }
  finally { blocker.exec('ROLLBACK'); blocker.close(); }
});

test('Windows EACCES and EPERM source-cookie errors give the close-original instruction', t => {
  const f = fixture(t), before = filesBelow(f.profile);
  for (const code of ['EACCES', 'EPERM']) {
    assert.throws(() => stageLogin({ ...f, readCookieFile: () => { const error = new Error(COOKIE_SECRET); error.code = code; throw error; } }), error => error.loginCode === 'source_locked' && error.message.includes('完全退出原版 Notion') && !error.message.includes(COOKIE_SECRET));
  }
  assert.deepEqual(filesBelow(f.profile), before);
});

test('busy AI rejects synchronization before launching helpers or requesting restart', async t => {
  const root = rootOnly(t); let helperCalls = 0, restarts = 0;
  const service = new LoginService({ root, platform: windows, isBusy: () => true, runHelper: async () => { helperCalls++; }, onRestart: () => { restarts++; } });
  await assert.rejects(service.sync(), /AI 正在生成/); assert.equal(helperCalls, 0); assert.equal(restarts, 0);
});

test('GUI metadata is allow-listed and restart happens only after the detached worker acknowledges staging', async t => {
  const root = rootOnly(t), stageId = randomUUID(), events = [];
  const service = new LoginService({ root, platform: windows, runHelper: async action => {
    events.push(action);
    return action === 'stage' ? { stageId, secret: COOKIE_SECRET } : { sourceAvailable: true, sourceHasLogin: true, hasLogin: false, os_crypt: CRYPT_SECRET, cookies: [{ value: COOKIE_SECRET }], lastSync: { status: 'applied', at: 'fixture-time', message: COOKIE_SECRET } };
  }, getTargetLoginStatus: async () => ({ hasLogin: true, cookie: COOKIE_SECRET }), launchApply: async id => { assert.equal(id, stageId); events.push('worker-ready'); }, onRestart: () => { events.push('restart'); } });
  const status = await service.status(); assert.equal(status.hasLogin, true); assert.equal(status.serverValidated, false);
  assert.equal(JSON.stringify(status).includes(COOKIE_SECRET) || JSON.stringify(status).includes(CRYPT_SECRET), false);
  const result = await service.sync(); assert.equal(result.restarting, true); assert.deepEqual(events, ['status', 'stage', 'worker-ready', 'restart']);
  assert.equal(JSON.stringify(result).includes(COOKIE_SECRET) || JSON.stringify(result).includes(stageId), false);
  await assert.rejects(service.sync(), /不要重复点击/);
});

test('apply worker uses hidden detached IPC and cannot restart before the exact stage acknowledgment', async t => {
  const root = rootOnly(t), stageId = randomUUID(), child = new EventEmitter();
  let sent, restarts = 0, detached = false;
  child.connected = true; child.disconnect = () => { child.connected = false; }; child.unref = () => { detached = true; };
  const service = new LoginService({ root, platform: windows, currentPid: 424242, runHelper: async () => ({ stageId }), onRestart: () => { restarts++; }, spawnImpl: (executable, args, options) => { sent = { executable, args, options }; return child; } });
  service.runtime = () => ({ executable: process.execPath, helper: 'fixture-login-helper.cjs' });
  const running = service.sync();
  for (let index = 0; index < 20 && !sent; index++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(restarts, 0); assert.equal(sent.options.windowsHide, true); assert.equal(sent.options.detached, true); assert.deepEqual(sent.options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.equal(sent.args.includes(stageId), true); assert.equal(sent.args.includes('424242'), true);
  child.emit('message', { type: 'login-sync-ready', stageId });
  await running;
  assert.equal(restarts, 1); assert.equal(detached, true); assert.equal(child.connected, false);
  child.emit('error', new Error(COOKIE_SECRET)); // Late child errors cannot crash the parent or leak values.
});

test('helper failures are sanitized and an active process prevents target overwrite', async t => {
  const f = fixture(t), before = filesBelow(f.profile), stage = stageLogin(f);
  const service = new LoginService({ root: f.root, platform: windows, runHelper: async () => { throw Error(COOKIE_SECRET); } });
  await assert.rejects(service.sync(), error => !error.message.includes(COOKIE_SECRET));
  assert.equal(service.syncing, false);
  await assert.rejects(applyStagedLogin({ root: f.root, stageId: stage.stageId, platform: windows, parentPid: 424242, waitForExit: async () => { await waitForProcessExit(424242, { timeoutMs: 0, isAlive: () => true }); } }), /尚未完全退出/);
  assert.deepEqual(filesBelow(f.profile), before);
  await assert.rejects(applyStagedLogin({ root: f.root, stageId: '../outside', platform: windows, parentPid: 424242, waitForExit: async () => {} }), /暂存资料不完整/);
});
