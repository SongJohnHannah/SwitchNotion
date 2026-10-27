import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import platformModule from '../src/platform/index.cjs';
import runtimeModule from '../src/platform/macos-runtime.cjs';
import { ensureMacInstallation } from '../scripts/launch-macos.mjs';
import { prepareRuntime, acceptRuntime, rollbackRuntime, updateStatus } from '../scripts/runtime-update.mjs';
import { inspectDesktop } from '../scripts/desktop-compat.mjs';
import { readArchive, sha256 } from '../scripts/asar.mjs';
const { createDesktopPlatform } = platformModule;

function archive(version = '7.40.20') {
  const source = 'const electron=require("electron");const hooks=["session-created","web-contents-created","protocol.handle","session.fromPartition","whenReady","notion.com"];';
  const files = { 'package.json': JSON.stringify({ name: 'Notion', productName: 'Notion', version, main: './.webpack/main', devDependencies: { electron: '44.9.1' } }), '.webpack/main/index.js': source };
  const header = { files: {} }; let offset = 0; const content = [];
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(value), parts = name.split('/'); let node = header;
    for (const part of parts.slice(0, -1)) node = (node.files[part] ||= { files: {} });
    node.files[parts.at(-1)] = { offset: String(offset), size: bytes.length }; offset += bytes.length; content.push(bytes);
  }
  const json = Buffer.from(JSON.stringify(header)), length = Math.ceil((json.length + 4) / 4) * 4;
  const pickle = Buffer.alloc(length + 4), size = Buffer.alloc(8); pickle.writeUInt32LE(length); pickle.writeUInt32LE(json.length, 4); json.copy(pickle, 8); size.writeUInt32LE(4); size.writeUInt32LE(pickle.length, 4);
  return Buffer.concat([size, pickle, ...content]);
}
function fixture(t) {
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'test-mac-launch-')), root = path.join(directory, 'state'), project = path.join(directory, 'project');
  fs.mkdirSync(root); fs.mkdirSync(path.join(project, 'src'), { recursive: true }); fs.writeFileSync(path.join(project, 'src/desktop-hook.cjs'), '// isolated fixture');
  t.after(() => { assert.equal(path.dirname(directory), parent); fs.rmSync(directory, { recursive: true, force: true }); });
  const calls = []; let failSign = false;
  const execFileSync = (tool, args) => {
    calls.push({ tool, args });
    if (tool.endsWith('ditto')) { fs.cpSync(args[0], args[1], { recursive: true }); return ''; }
    if (tool.endsWith('plutil')) {
      const file = args.at(-1), value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (args[0] === '-convert') return JSON.stringify(value);
      if (args[0] === '-remove') delete value[args[1]];
      else value[args[1]] = args[2] === '-json' ? JSON.parse(args[3]) : args[3];
      fs.writeFileSync(file, JSON.stringify(value)); return '';
    }
    if (tool.endsWith('codesign')) { if (failSign && args.includes('--force')) throw Error('fixture signing failure'); return ''; }
    throw Error('unexpected native command');
  };
  const platform = createDesktopPlatform({ id: 'darwin', arch: 'arm64', home: directory, env: {}, execFileSync });
  const source = platform.installationLayout(path.join(directory, 'Applications/Notion.app'));
  fs.mkdirSync(source.resources, { recursive: true }); fs.mkdirSync(path.dirname(source.executable), { recursive: true });
  const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf); macho.writeUInt32LE(0x0100000c, 4);
  fs.writeFileSync(source.executable, macho);
  function install(version) {
    const bytes = archive(version); fs.writeFileSync(source.archive, bytes);
    fs.writeFileSync(path.join(source.resources, 'app-update.yml'), 'provider: generic\nurl: https://fixture.invalid/official-installer');
    fs.writeFileSync(path.join(source.appRoot, 'Contents/Info.plist'), JSON.stringify({ CFBundleName: 'Notion', CFBundleIdentifier: 'notion.id', CFBundleDisplayName: 'Notion',
      CFBundleURLTypes: ['notion'], ElectronTeamID: 'LBQJ96FQ8D', CFBundleIconFile: 'electron.icns',
      ElectronAsarIntegrity: { 'Resources/app.asar': { algorithm: 'SHA256', hash: runtimeModule.headerHash(bytes) } } }));
    return bytes;
  }
  install('7.40.20');
  return { root, source, sourceProject: project, platform, calls, install, failSign: () => { failSign = true; } };
}

test('M1 launch prepares a separate bundle, updates ASAR integrity and identity, preserves icon and signs before promotion', t => {
  const f = fixture(t), original = fs.readFileSync(f.source.archive), beforePlist = fs.readFileSync(path.join(f.source.appRoot, 'Contents/Info.plist'));
  const result = prepareRuntime({ ...f, source: f.source.appRoot });
  const staged = f.platform.runtimeLayout(path.join(f.root, 'runtime'));
  assert.equal(result.pendingValidation, true); assert.equal(result.platform, 'darwin');
  const info = JSON.parse(fs.readFileSync(path.join(staged.appRoot, 'Contents/Info.plist'), 'utf8'));
  assert.equal(info.CFBundleDisplayName, 'Switch Notion'); assert.equal(info.CFBundleName, 'Notion'); assert.equal(info.CFBundleIdentifier, 'com.notionswitch.desktop');
  assert.equal(info.CFBundleIconFile, 'electron.icns'); assert.equal(info.CFBundleURLTypes, undefined);
  assert.equal(fs.existsSync(path.join(staged.resources, 'app-update.yml')), false);
  assert.equal(fs.existsSync(path.join(f.source.resources, 'app-update.yml')), true);
  assert.equal(info.ElectronAsarIntegrity['Resources/app.asar'].hash, runtimeModule.headerHash(fs.readFileSync(staged.archive)));
  assert.ok(readArchive(fs.readFileSync(staged.archive)).read('.webpack/main/index.js').toString().startsWith('require(require('));
  assert.deepEqual(fs.readFileSync(f.source.archive), original); assert.deepEqual(fs.readFileSync(path.join(f.source.appRoot, 'Contents/Info.plist')), beforePlist);
  assert.ok(f.calls.some(c => c.args.includes('=anchor apple generic and certificate leaf[subject.OU] = "LBQJ96FQ8D"'))); assert.ok(f.calls.some(c => c.args.includes('--force')));
  let launch;
  f.platform.launchRuntime({ container: path.join(f.root, 'runtime'), stateRoot: f.root, spawnImpl: (...args) => { launch = args; } });
  assert.equal(launch[0], staged.executable); assert.equal(launch[2].env.NOTION_SWITCH_ROOT, f.root);
});

test('signature failure preserves the working Mac runtime and never changes the official source', t => {
  const f = fixture(t), options = { ...f, source: f.source.appRoot }; prepareRuntime(options); acceptRuntime(options);
  const app = f.platform.runtimeLayout(path.join(f.root, 'runtime')), before = fs.readFileSync(app.archive);
  const next = f.install('7.40.21'); f.failSign();
  assert.equal(prepareRuntime(options).updateStatus, 'blocked');
  assert.deepEqual(fs.readFileSync(app.archive), before); assert.equal(sha256(fs.readFileSync(f.source.archive)), sha256(next));
});

test('M1 updates and rollback preserve signed bundle metadata and local state across full runtime swaps', t => {
  const f = fixture(t), options = { ...f, source: f.source.appRoot };
  prepareRuntime(options); acceptRuntime(options);
  const runtime = f.platform.runtimeLayout(path.join(f.root, 'runtime'));
  const previous = f.platform.runtimeLayout(path.join(f.root, 'runtime-previous'));
  const original = fs.readFileSync(runtime.archive);
  const local = path.join(f.root, 'profile', 'fixture-session');
  fs.mkdirSync(path.dirname(local)); fs.writeFileSync(local, 'fixture local state');
  const next = f.install('7.40.21');
  assert.equal(prepareRuntime(options).pendingValidation, true);
  assert.deepEqual(fs.readFileSync(previous.archive), original);
  assert.equal(fs.existsSync(previous.executable), true);
  const info = JSON.parse(fs.readFileSync(path.join(runtime.appRoot, 'Contents/Info.plist'), 'utf8'));
  assert.equal(info.CFBundleIdentifier, 'com.notionswitch.desktop');
  assert.equal(info.ElectronAsarIntegrity['Resources/app.asar'].hash, runtimeModule.headerHash(fs.readFileSync(runtime.archive)));
  acceptRuntime(options);
  assert.equal(updateStatus(options).prototypeVersion, '7.40.21');
  assert.equal(updateStatus(options).previousVersion, '7.40.20');
  rollbackRuntime(options);
  assert.deepEqual(fs.readFileSync(runtime.archive), original);
  assert.equal(updateStatus(options).prototypeVersion, '7.40.20');
  assert.equal(prepareRuntime(options).updateStatus, 'held');
  assert.equal(prepareRuntime({ ...options, force: true }).version, '7.40.21');
  acceptRuntime(options);
  assert.equal(fs.readFileSync(local, 'utf8'), 'fixture local state');
  assert.deepEqual(fs.readFileSync(f.source.archive), next);
});

test('a corrupt source integrity header is rejected before copying the Mac bundle', t => {
  const f = fixture(t), plist = path.join(f.source.appRoot, 'Contents/Info.plist');
  const info = JSON.parse(fs.readFileSync(plist)); info.ElectronAsarIntegrity['Resources/app.asar'].hash = 'invalid'; fs.writeFileSync(plist, JSON.stringify(info));
  assert.throws(() => prepareRuntime({ ...f, source: f.source.appRoot }), /完整性/);
  assert.equal(f.calls.some(c => c.tool.endsWith('ditto')), false);
});

test('an Intel-only Notion executable is rejected before signing or copying', t => {
  const f = fixture(t), macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf); macho.writeUInt32LE(0x01000007, 4);
  fs.writeFileSync(f.source.executable, macho);
  assert.throws(() => prepareRuntime({ ...f, source: f.source.appRoot }), /Intel/);
  assert.equal(f.calls.some(c => c.tool.endsWith('ditto') || c.tool.endsWith('codesign')), false);
});

test('bundle link validation preserves internal framework links and rejects references outside the app', () => {
  let outside = false;
  const root = path.resolve('fixture-app'), link = path.join(root, 'Framework');
  const fsImpl = { realpathSync: file => file === root ? root : outside ? path.resolve('outside') : path.join(root, 'Versions/A'),
    readdirSync: () => [{ name: path.basename(link), isSymbolicLink: () => true }] };
  runtimeModule.validateBundleLinks(root, fsImpl); outside = true;
  assert.throws(() => runtimeModule.validateBundleLinks(root, fsImpl), /外部/);
});

test('Mac scanning uses the current platform automatically and needs no selection dialog when Notion exists', t => {
  const f = fixture(t);
  assert.equal(ensureMacInstallation({ root: f.root, platform: f.platform, exec: () => { throw Error('unexpected dialog'); } }), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'installation.local.json'))).source, f.source.appRoot);
});

test('missing Mac Notion offers the official website and cancellation without launching a runtime', t => {
  const f = fixture(t), calls = [], platform = { ...f.platform, discoverInstallation: () => null };
  const result = ensureMacInstallation({ root: f.root, platform, exec: (tool, args) => { calls.push({ tool, args }); return tool.endsWith('osascript') ? '打开官网' : ''; } });
  assert.equal(result, false); assert.ok(calls.some(c => c.tool.endsWith('/open') && c.args[0] === 'https://www.notion.com/desktop'));
  assert.equal(fs.existsSync(path.join(f.root, 'prepared.json')), false);
});

const actual = path.resolve('research/mac-desktop/inspect/Notion Installer/Notion.app/Contents/Resources/app.asar');
test('official Mac 7.40.1 ASAR passes its own reviewed hash and native hook contracts', fs.existsSync(actual) ? {} : { skip: 'Optional private official Mac audit cache unavailable' }, () => {
  const bytes = fs.readFileSync(actual), platform = createDesktopPlatform({ id: 'darwin', arch: 'arm64' });
  assert.equal(inspectDesktop(bytes, platform.compatibility).compatibility, 'reviewed');
  assert.equal(runtimeModule.headerHash(bytes), '60ce8e73a3c935b8bfb0abaf2cf7b723e4a8a9d4defd8d769ec0b6161d618f48');
});
