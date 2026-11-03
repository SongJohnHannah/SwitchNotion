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

test('Notion launch bypasses the system proxy for Notion domains only while the skip-VPN switch is on', t => {
  const dir = fixture(t), root = path.join(dir, 'state'); fs.mkdirSync(root);
  const platform = createDesktopPlatform({ id: 'win32', home: dir, env: { LOCALAPPDATA: dir, APPDATA: path.join(dir, 'roaming') }, registry: () => [] });
  const source = install(platform, path.join(dir, 'Programs', 'Notion'));
  platform.stageInstallation({ source, container: path.join(root, 'runtime'), copy: (a, b) => fs.cpSync(a, b, { recursive: true }) });
  let launched;
  const launch = () => platform.launchRuntime({ container: path.join(root, 'runtime'), stateRoot: root, env: { FIXTURE: 'kept' }, stdio: 'ignore', spawnImpl: (...args) => { launched = args; return 'child'; } });
  launch();
  assert.deepEqual(launched[1], ['--enable-logging=stderr']);
  assert.equal(launched[2].env.NO_PROXY, undefined);
  assert.equal(launched[2].env.FIXTURE, 'kept');
  fs.writeFileSync(path.join(root, 'notion-accelerator.local.json'), JSON.stringify({ bypassVpn: true }));
  launch();
  assert.ok(launched[1].includes('--proxy-bypass-list=*.notion.so;*.notion.com;*.notion.site;notion.so;notion.com;notion.site'));
  assert.match(launched[2].env.NO_PROXY, /\.notion\.so/);
  assert.equal(launched[2].env.FIXTURE, 'kept');
  fs.writeFileSync(path.join(root, 'notion-accelerator.local.json'), JSON.stringify({ autoIp: true, bestIp: '208.103.161.16' }));
  launch();
  const rules = launched[1].find(arg => arg.startsWith('--host-resolver-rules='));
  assert.ok(rules && rules.includes('MAP api.notion.com 208.103.161.16'));
  assert.equal(rules.includes('api.pgncs.notion.so'), false);
  assert.ok(launched[1].some(arg => arg.startsWith('--proxy-bypass-list=')));
  assert.match(launched[2].env.NO_PROXY, /\.notion\.so/);
});

test('macOS discovery uses app bundles without Windows commands or Windows archive hashes', t => {
  const dir = fixture(t), root = path.join(dir, 'state'); fs.mkdirSync(root);
  const platform = createDesktopPlatform({ id: 'darwin', arch: 'arm64', home: dir, env: {}, execFileSync: () => { throw Error('must not execute commands'); } });
  const source = install(platform, path.join(dir, 'Applications', 'Notion.app'));
  assert.deepEqual(platform.discoverInstallation(root), source);
  assert.deepEqual(platform.findInstallation(source.executable, root), source);
  const layout = platform.runtimeLayout(path.join(root, 'runtime'));
  assert.equal(layout.appRoot, path.join(root, 'runtime', 'SwitchNotion.app'));
  assert.equal(layout.archive, path.join(layout.appRoot, 'Contents', 'Resources', 'app.asar'));
  fs.mkdirSync(path.join(root, 'legacy', 'Notion.app'), { recursive: true });
  assert.equal(platform.runtimeLayout(path.join(root, 'legacy')).appRoot, path.join(root, 'legacy', 'Notion.app'));
  assert.equal(platform.login.strategy, 'macos-keychain-copy'); assert.equal(platform.capabilities.syncLogin, true);
  assert.equal(platform.compatibility.reviewedBuilds['7.40.1'], '48154144947412453a987b55cc1725c5a4dbf66f7b90ea919384d061cde2716f');
  assert.notEqual(platform.compatibility.reviewedBuilds['7.40.1'], createDesktopPlatform({ id: 'win32' }).compatibility.reviewedBuilds['7.40.1']);
  assert.equal(platform.samePath(path.join(dir, 'A'), path.join(dir, 'a')), false);
  assert.doesNotThrow(() => platform.configureAppIdentity({}));
});

test('Windows process identity distinguishes reused PIDs and preserves uncertainty for inaccessible Notion processes', () => {
  const executable = path.resolve('.notion-switch/runtime/Notion.exe');
  let result, failure, calls = 0;
  const platform = createDesktopPlatform({ id: 'win32', execFileSync: (command, args, options) => {
    calls++; assert.equal(command, 'powershell.exe'); assert.equal(options.windowsHide, true);
    assert.ok(args.at(-1).includes('ProcessId = 5572'));
    if (failure) throw failure;
    return JSON.stringify(result);
  } });
  result = { Name: 'MacmDNSResponder.exe', ExecutablePath: null };
  assert.equal(platform.processMatchesExecutable(5572, executable), false);
  result = { Name: 'Notion.exe', ExecutablePath: executable.toUpperCase() };
  assert.equal(platform.processMatchesExecutable(5572, executable), true);
  result = { Name: 'Notion.exe', ExecutablePath: path.resolve('other/Notion.exe') };
  assert.equal(platform.processMatchesExecutable(5572, executable), false);
  result = { Name: 'Notion.exe', ExecutablePath: null };
  assert.equal(platform.processMatchesExecutable(5572, executable), null);
  result = null; assert.equal(platform.processMatchesExecutable(5572, executable), false);
  failure = Error('process inspection denied');
  assert.equal(platform.processMatchesExecutable(5572, executable), null);
  const before = calls;
  assert.equal(platform.processMatchesExecutable('5572; exit', executable), null);
  assert.equal(calls, before);
});

test('unsupported Mac preparation, rollback, launch and login do not copy, mutate or start helpers', async t => {
  const root = fixture(t), platform = createDesktopPlatform({ id: 'darwin', arch: 'x64', home: root });
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
