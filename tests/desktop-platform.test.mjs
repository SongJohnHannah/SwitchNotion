import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import platformModule from '../src/platform/index.cjs';
import { prepareRuntime, rollbackRuntime, acceptRuntime, updateStatus } from '../scripts/runtime-update.mjs';
import { inspectDesktop } from '../scripts/desktop-compat.mjs';
import { createRequire } from 'node:module';
const { createDesktopPlatform } = platformModule;
const { LoginService, stageLogin, readStagedMetadata, applyStagedLogin, inspectLogin } = createRequire(import.meta.url)('../src/login-state.cjs');
const { UpdateService } = createRequire(import.meta.url)('../src/update-service.cjs');

function fixture(t) {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-platform-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function install(platform, directory) {
  const layout = platform.installationLayout(directory);
  fs.mkdirSync(layout.resources, { recursive: true }); fs.mkdirSync(path.dirname(layout.executable), { recursive: true });
  fs.writeFileSync(layout.executable, 'synthetic executable'); fs.writeFileSync(layout.archive, 'synthetic ASAR');
  return layout;
}
const unsupported = error => error.code === 'PLATFORM_CAPABILITY_UNAVAILABLE';

test('Windows discovery, staging and launch share one layout and preserve isolated environment', t => {
  const dir = fixture(t), root = path.join(dir, 'state'); fs.mkdirSync(root);
  const platform = createDesktopPlatform({ id: 'win32', home: dir, env: { LOCALAPPDATA: dir, APPDATA: path.join(dir, 'roaming') }, registry: () => [] });
  const source = install(platform, path.join(dir, 'Programs', 'Notion'));
  assert.deepEqual(platform.discoverInstallation(root), source);
  assert.deepEqual(platform.findInstallation(source.executable, root), source);
  const target = platform.stageInstallation({ source, container: path.join(root, 'runtime'), copy: (a, b) => fs.cpSync(a, b, { recursive: true }) });
  assert.equal(platform.findInstallation(target.appRoot, root), null);
  let launched;
  const child = platform.launchRuntime({ container: path.join(root, 'runtime'), stateRoot: root, env: { FIXTURE: 'preserved', NOTION_SWITCH_ROOT: 'wrong' }, stdio: 'ignore', spawnImpl: (...args) => { launched = args; return 'child'; } });
  assert.equal(child, 'child'); assert.equal(launched[0], target.executable);
  assert.equal(launched[2].cwd, target.appRoot); assert.equal(launched[2].windowsHide, true);
  assert.equal(launched[2].env.FIXTURE, 'preserved'); assert.equal(launched[2].env.NOTION_SWITCH_ROOT, root);
  assert.equal(platform.login.sourceRoot, path.join(dir, 'roaming', 'Notion'));
  assert.equal(platform.isNodeExecutable(process.execPath), true);
});

test('macOS discovery uses app bundles without Windows commands or Windows archive hashes', t => {
  const dir = fixture(t), root = path.join(dir, 'state'); fs.mkdirSync(root);
  const platform = createDesktopPlatform({ id: 'darwin', home: dir, env: {}, execFileSync: () => { throw Error('must not execute commands'); } });
  const source = install(platform, path.join(dir, 'Applications', 'Notion.app'));
  assert.deepEqual(platform.discoverInstallation(root), source);
  assert.deepEqual(platform.findInstallation(source.executable, root), source);
  const layout = platform.runtimeLayout(path.join(root, 'runtime'));
  assert.equal(layout.appRoot, path.join(root, 'runtime', 'Notion.app'));
  assert.equal(layout.archive, path.join(layout.appRoot, 'Contents', 'Resources', 'app.asar'));
  assert.equal(platform.login.strategy, 'interactive'); assert.equal(platform.capabilities.syncLogin, false);
  assert.deepEqual(platform.compatibility.reviewedBuilds, {});
  assert.throws(() => inspectDesktop(Buffer.from('unread'), platform.compatibility), /尚未审核/);
  assert.equal(platform.samePath(path.join(dir, 'A'), path.join(dir, 'a')), false);
  assert.doesNotThrow(() => platform.configureAppIdentity({}));
});

test('unsupported Mac preparation, rollback, launch and login do not copy, mutate or start helpers', async t => {
  const root = fixture(t), platform = createDesktopPlatform({ id: 'darwin', home: root });
  const missing = path.join(root, 'must-not-create'); let called = false;
  const fail = () => { called = true; throw Error('unexpected side effect'); };
  assert.throws(() => prepareRuntime({ root: missing, platform, copy: fail }), unsupported);
  assert.equal(fs.existsSync(missing), false);
  assert.throws(() => rollbackRuntime({ root, platform }), unsupported);
  assert.throws(() => acceptRuntime({ root, platform }), unsupported);
  assert.throws(() => platform.stageInstallation({ source: {}, container: missing, copy: fail }), unsupported);
  assert.throws(() => platform.launchRuntime({ container: root, stateRoot: root, spawnImpl: fail }), unsupported);
  assert.throws(() => platform.finalizeRuntime({}), unsupported);
  const input = { root, platform, readCookieFile: fail };
  assert.throws(() => stageLogin(input), error => error.loginCode === 'platform_unsupported');
  assert.throws(() => readStagedMetadata(input), error => error.loginCode === 'platform_unsupported');
  await assert.rejects(applyStagedLogin({ ...input, waitForExit: fail }), error => error.loginCode === 'platform_unsupported');
  assert.equal(inspectLogin(input).syncSupported, false);
  const service = new LoginService({ root, platform, runHelper: fail, launchApply: fail, getTargetLoginStatus: async () => true });
  const status = await service.status();
  assert.equal(status.hasLogin, true); assert.equal(status.syncSupported, false); assert.equal(status.loginStrategy, 'interactive');
  await assert.rejects(service.sync(), error => error.loginCode === 'platform_unsupported');
  const updates = new UpdateService({ root, platform, load: async () => ({ updateStatus: options => updateStatus(options) }), spawnImpl: fail });
  assert.equal((await updates.request('update.status')).result.compatible, false);
  assert.equal((await updates.request('update.rollback')).ok, false);
  assert.equal((await updates.request('update.apply')).ok, false);
  assert.equal(called, false); assert.deepEqual(fs.readdirSync(root), []);
});

test('unsupported systems return a stable capability error', () => {
  assert.throws(() => createDesktopPlatform({ id: 'linux' }), unsupported);
});
