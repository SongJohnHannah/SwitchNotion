import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareRuntime, acceptRuntime, rollbackRuntime, previousRuntime, updateStatus } from '../scripts/runtime-update.mjs';
import platformModule from '../src/platform/index.cjs';
import adapter from '../src/macos-adapter-loader.cjs';

function archive(version) {
  const code = 'const e=require("electron"); const boundaries=["session-created","web-contents-created","protocol.handle","session.fromPartition","whenReady","notion.com"];';
  const header = { files: {} }, content = []; let offset = 0;
  for (const [name, value] of Object.entries({ 'package.json': JSON.stringify({ name: 'Notion', productName: 'Notion', version, main: './.webpack/main', devDependencies: { electron: '44.9.1' } }), '.webpack/main/index.js': code })) {
    const bytes = Buffer.from(value), parts = name.split('/'); let node = header;
    for (const part of parts.slice(0, -1)) node = (node.files[part] ||= { files: {} });
    node.files[parts.at(-1)] = { offset: String(offset), size: bytes.length }; content.push(bytes); offset += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(header)), length = Math.ceil((json.length + 4) / 4) * 4, pickle = Buffer.alloc(length + 4), size = Buffer.alloc(8);
  pickle.writeUInt32LE(length); pickle.writeUInt32LE(json.length, 4); json.copy(pickle, 8); size.writeUInt32LE(4); size.writeUInt32LE(pickle.length, 4);
  return Buffer.concat([size, pickle, ...content]);
}
function fixture(t) {
  const parent = fs.realpathSync(path.resolve('.notion-switch')), directory = fs.mkdtempSync(path.join(parent, 'test-mac-adapter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'state'), source = path.join(directory, 'Notion.app'), sourceProject = path.join(directory, 'project');
  fs.mkdirSync(root); fs.mkdirSync(path.join(sourceProject, 'src'), { recursive: true });
  fs.copyFileSync('src/macos-adapter-loader.cjs', path.join(sourceProject, 'src/macos-adapter-loader.cjs'));
  const hook = path.join(sourceProject, 'src/desktop-hook.cjs'); fs.writeFileSync(hook, '// working adapter');
  const layout = appRoot => ({ appRoot, resources: path.join(appRoot, 'Contents/Resources'), archive: path.join(appRoot, 'Contents/Resources/app.asar'), executable: path.join(appRoot, 'Contents/MacOS/Notion') });
  const runtimeLayout = container => layout(path.join(container, 'SwitchNotion.app')); let signingCalls = 0;
  const platform = { ...platformModule.createDesktopPlatform({ id: 'win32' }), id: 'darwin', installationLayout: layout, runtimeLayout,
    findInstallation: candidate => fs.existsSync(layout(candidate).archive) ? layout(candidate) : null,
    stageInstallation({ source, container, copy }) { const target = runtimeLayout(container); copy(source.appRoot, target.appRoot); return target; },
    finalizeRuntime(target) { signingCalls++; fs.writeFileSync(path.join(target.resources, 'signature.fixture'), 'signed bundle ' + signingCalls); }
  };
  function build(version) { const target = layout(source); fs.mkdirSync(target.resources, { recursive: true }); fs.mkdirSync(path.dirname(target.executable), { recursive: true }); fs.writeFileSync(target.archive, archive(version)); fs.writeFileSync(target.executable, 'fixture executable'); }
  build('7.40.20');
  return { root, source, sourceProject, platform, hook, build, signingCalls: () => signingCalls, resourcesPath: runtimeLayout(path.join(root, 'runtime')).resources };
}
function bundleBytes(directory) {
  const result = {};
  function visit(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) visit(file); else result[path.relative(directory, file)] = fs.readFileSync(file).toString('base64'); } }
  visit(directory); return result;
}
test('Mac adapter updates preserve every signed bundle byte, load the selected verified snapshot and support rollback', t => {
  const f = fixture(t), first = prepareRuntime(f); acceptRuntime(f);
  const signed = bundleBytes(f.resourcesPath), firstHook = adapter.resolveMacAdapter(f);
  assert.ok(firstHook.includes(first.adapterHash)); assert.equal(fs.readFileSync(firstHook, 'utf8'), '// working adapter');
  fs.writeFileSync(f.hook, '// updated recording adapter');
  const second = prepareRuntime(f); assert.equal(second.signaturePreserved, true); assert.equal(second.pendingValidation, true);
  assert.equal(f.signingCalls(), 1); assert.deepEqual(bundleBytes(f.resourcesPath), signed);
  assert.notEqual(adapter.resolveMacAdapter(f), firstHook); assert.equal(previousRuntime(f).adapterHash, first.adapterHash);
  acceptRuntime(f); rollbackRuntime(f);
  assert.equal(adapter.resolveMacAdapter(f), firstHook); assert.deepEqual(bundleBytes(f.resourcesPath), signed);
  assert.equal(prepareRuntime(f).updateStatus, 'held');
  assert.equal(prepareRuntime({ ...f, force: true }).signaturePreserved, true);
});
test('an interrupted Mac adapter validation restores once without swapping or signing the bundle', t => {
  const f = fixture(t), first = prepareRuntime(f); acceptRuntime(f);
  fs.writeFileSync(f.hook, '// adapter whose startup did not finish'); prepareRuntime(f);
  const resumed = prepareRuntime(f);
  assert.equal(resumed.adapterHash, first.adapterHash); assert.equal(resumed.updateStatus, 'held'); assert.equal(f.signingCalls(), 1);
  assert.equal(fs.existsSync(path.join(f.root, 'runtime-previous')), false);
});
test('Mac official upgrades require an explicit update while adapter fixes still apply to the current bundle', t => {
  const f = fixture(t); prepareRuntime(f); acceptRuntime(f); const signed = bundleBytes(f.resourcesPath);
  f.build('7.40.21');
  assert.equal(prepareRuntime(f).updateStatus, 'deferred'); assert.match(updateStatus(f).message, /保留当前版本/);
  fs.writeFileSync(f.hook, '// fix against the installed Mac runtime');
  const fixed = prepareRuntime(f); assert.equal(fixed.version, '7.40.20'); assert.equal(fixed.signaturePreserved, true); acceptRuntime(f);
  assert.deepEqual(bundleBytes(f.resourcesPath), signed); assert.equal(f.signingCalls(), 1);
  const upgraded = prepareRuntime({ ...f, force: true }); assert.equal(upgraded.version, '7.40.21'); assert.equal(f.signingCalls(), 2); acceptRuntime(f);
  rollbackRuntime(f); assert.equal(adapter.resolveMacAdapter(f).includes(fixed.adapterHash), true); assert.deepEqual(bundleBytes(f.resourcesPath), signed);
});
test('Mac loader and updater reject altered snapshots, links, invalid roots and version pointers before loading any code', t => {
  const f = fixture(t), first = prepareRuntime(f); acceptRuntime(f);
  const file = adapter.resolveMacAdapter(f);
  fs.writeFileSync(file, '// altered after staging'); assert.throws(() => adapter.resolveMacAdapter(f), /完整性/);
  prepareRuntime(f); assert.equal(fs.readFileSync(adapter.resolveMacAdapter(f), 'utf8'), '// working adapter');
  assert.throws(() => adapter.resolveMacAdapter({ ...f, env: { NOTION_SWITCH_ROOT: path.dirname(f.root) } }), /目录校验/);
  fs.symlinkSync(f.hook, path.join(path.dirname(file), 'linked.cjs')); assert.throws(() => adapter.resolveMacAdapter(f), /链接/);
  fs.unlinkSync(path.join(path.dirname(file), 'linked.cjs'));
  const marker = path.join(f.root, 'prepared.json'); fs.writeFileSync(marker, JSON.stringify({ ...first, adapterHash: '../outside' }));
  assert.throws(() => adapter.resolveMacAdapter(f), /版本无效/);
});
test('failed adapter copy keeps the previous verified snapshot selected and the signed runtime untouched', t => {
  const f = fixture(t), first = prepareRuntime(f); acceptRuntime(f); const signed = bundleBytes(f.resourcesPath);
  fs.writeFileSync(f.hook, '// interrupted copy');
  const result = prepareRuntime({ ...f, copy: () => { throw Error('fixture copy failed'); } });
  assert.equal(result.updateStatus, 'blocked'); assert.equal(adapter.resolveMacAdapter(f).includes(first.adapterHash), true);
  assert.deepEqual(bundleBytes(f.resourcesPath), signed); assert.equal(f.signingCalls(), 1);
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('adapter-staging-')), false);
});
test('an incompatible official release cannot block adapter repairs or be installed implicitly', t => {
  const f = fixture(t); prepareRuntime(f); acceptRuntime(f); const signed = bundleBytes(f.resourcesPath);
  f.build('8.0.0'); fs.writeFileSync(f.hook, '// repair while official Notion is incompatible');
  assert.equal(prepareRuntime(f).signaturePreserved, true); acceptRuntime(f);
  assert.deepEqual(bundleBytes(f.resourcesPath), signed); assert.equal(updateStatus(f).compatible, false);
  assert.equal(prepareRuntime({ ...f, force: true }).updateStatus, 'blocked'); assert.equal(f.signingCalls(), 1);
});
test('a loader upgrade re-signs once and a failed migration stays held until explicitly retried', t => {
  const f = fixture(t), first = prepareRuntime(f); acceptRuntime(f);
  fs.appendFileSync(path.join(f.sourceProject, 'src/macos-adapter-loader.cjs'), '\n// revised bootstrap contract');
  const migrated = prepareRuntime(f); assert.notEqual(migrated.macBootstrapHash, first.macBootstrapHash); assert.equal(f.signingCalls(), 2);
  rollbackRuntime(f); assert.equal(prepareRuntime(f).updateStatus, 'held'); assert.equal(f.signingCalls(), 2);
  assert.equal(prepareRuntime({ ...f, force: true }).pendingValidation, true); assert.equal(f.signingCalls(), 3);
});
