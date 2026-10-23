import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareRuntime, acceptRuntime, rollbackRuntime, updateStatus } from '../scripts/runtime-update.mjs';
import { inspectDesktop } from '../scripts/desktop-compat.mjs';
import { sha256, readArchive } from '../scripts/asar.mjs';
import { launchLock } from '../scripts/launch-lock.mjs';
import { waitForRuntime } from '../scripts/runtime-health.mjs';

// Synthetic ASARs exercise the real archive parser and staging/swap behavior.
// No Electron or Notion process is started by these tests.
function asar(files) {
  const header = { files: {} }; let offset = 0; const content = [];
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.from(text), parts = name.split('/'); let node = header;
    for (const dir of parts.slice(0, -1)) node = (node.files[dir] ||= { files: {} });
    node.files[parts.at(-1)] = { offset: String(offset), size: bytes.length }; offset += bytes.length; content.push(bytes);
  }
  const json = Buffer.from(JSON.stringify(header)), length = Math.ceil((json.length + 4) / 4) * 4, pickle = Buffer.alloc(length + 4), size = Buffer.alloc(8);
  pickle.writeUInt32LE(length); pickle.writeUInt32LE(json.length, 4); json.copy(pickle, 8); size.writeUInt32LE(4); size.writeUInt32LE(pickle.length, 4);
  return Buffer.concat([size, pickle, ...content]);
}
const main = 'const e=require("electron"); const contracts=["session-created","web-contents-created","protocol.handle","session.fromPartition","whenReady","notion.com"];';
function build(source, version, code = main, metadata = {}) {
  const bytes = asar({ 'package.json': JSON.stringify({ name: 'Notion', productName: 'Notion', version, main: './.webpack/main', devDependencies: { electron: '44.9.1' }, ...metadata }), '.webpack/main/index.js': code });
  fs.mkdirSync(path.join(source, 'resources'), { recursive: true }); fs.writeFileSync(path.join(source, 'resources/app.asar'), bytes); fs.writeFileSync(path.join(source, 'Notion.exe'), 'synthetic executable'); return bytes;
}
function fixture(t) {
  const parent = path.resolve('.notion-switch'), dir = fs.mkdtempSync(path.join(parent, 'test-update-')), root = path.join(dir, 'state'), source = path.join(dir, 'installed'), sourceProject = path.join(dir, 'project');
  t.after(() => { assert.equal(path.dirname(dir), parent); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(root); fs.mkdirSync(path.join(sourceProject, 'src'), { recursive: true }); fs.writeFileSync(path.join(sourceProject, 'src/desktop-hook.cjs'), '// fixture hook');
  return { root, source, sourceProject };
}
test('compatible future patch versions stage automatically, preserve user data, validate and support rollback without an update loop', t => {
  const f = fixture(t), original = build(f.source, '7.40.20');
  for (const file of ['profile/Local State', 'deepseek-api-key.txt', 'conversations.local.json']) { fs.mkdirSync(path.dirname(path.join(f.root, file)), { recursive: true }); fs.writeFileSync(path.join(f.root, file), 'untouched fixture data'); }
  const first = prepareRuntime(f); assert.equal(first.compatibility, 'structural'); assert.equal(first.pendingValidation, true);
  assert.ok(readArchive(fs.readFileSync(path.join(f.root, 'runtime/resources/app.asar'))).read('.webpack/main/index.js').toString().startsWith('require(require('));
  assert.equal(sha256(fs.readFileSync(path.join(f.source, 'resources/app.asar'))), sha256(original));
  acceptRuntime(f); assert.equal(prepareRuntime(f).updateStatus, 'current');
  build(f.source, '7.40.21', main + '\n// unrelated Notion update');
  assert.equal(updateStatus(f).available, true); assert.equal(prepareRuntime(f).version, '7.40.21'); acceptRuntime(f);
  assert.equal(updateStatus(f).previousVersion, '7.40.20');
  rollbackRuntime(f); assert.equal(prepareRuntime(f).updateStatus, 'held');
  assert.equal(updateStatus(f).prototypeVersion, '7.40.20'); assert.equal(prepareRuntime({ ...f, force: true }).version, '7.40.21');
  for (const file of ['profile/Local State', 'deepseek-api-key.txt', 'conversations.local.json']) assert.equal(fs.readFileSync(path.join(f.root, file), 'utf8'), 'untouched fixture data');
});
test('failed staging and incompatible releases keep the current runtime and original installation intact', t => {
  const f = fixture(t); build(f.source, '7.40.20'); prepareRuntime(f); acceptRuntime(f);
  const before = fs.readFileSync(path.join(f.root, 'runtime/resources/app.asar'));
  const newer = build(f.source, '7.40.21');
  const failed = prepareRuntime({ ...f, copy: () => { throw Error('synthetic copy failure'); } });
  assert.equal(failed.updateStatus, 'blocked'); assert.deepEqual(fs.readFileSync(path.join(f.root, 'runtime/resources/app.asar')), before);
  assert.equal(sha256(fs.readFileSync(path.join(f.source, 'resources/app.asar'))), sha256(newer));
  build(f.source, '8.0.0'); assert.equal(prepareRuntime(f).updateStatus, 'blocked'); assert.equal(updateStatus(f).compatible, false);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'runtime/resources/app.asar')), before);
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('runtime-staging-')), false);
});
test('an interrupted validation rolls back once and prevents automatic reinstallation of the rejected build', t => {
  const f = fixture(t); build(f.source, '7.40.20'); prepareRuntime(f); acceptRuntime(f);
  build(f.source, '7.40.21'); prepareRuntime(f);
  const resumed = prepareRuntime(f); assert.equal(resumed.version, '7.40.20'); assert.equal(resumed.updateStatus, 'held');
});
test('changed hook boundaries, Electron major versions and path traversal are rejected', () => {
  const make = (metadata, code = main) => asar({ 'package.json': JSON.stringify({ name: 'Notion', productName: 'Notion', version: '7.50.0', main: './.webpack/main', devDependencies: { electron: '44.9.1' }, ...metadata }), '.webpack/main/index.js': code });
  assert.throws(() => inspectDesktop(make({}, main.replace('protocol.handle', 'different API'))), /接入点/);
  assert.throws(() => inspectDesktop(make({ devDependencies: { electron: '45.0.0' } })), /Electron/);
  assert.throws(() => inspectDesktop(make({ main: '../outside.js' })), /启动入口/);
});
test('live prototypes and concurrent launchers are never overwritten', t => {
  const f = fixture(t); build(f.source, '7.40.20'); fs.writeFileSync(path.join(f.root, 'control.json'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => prepareRuntime(f), /尚未退出/); assert.equal(fs.existsSync(path.join(f.root, 'runtime')), false);
  const release = launchLock(f.root); assert.throws(() => launchLock(f.root), /正在准备启动/); release(); launchLock(f.root)();
});
test('startup validation requires the expected process and a ready isolated window', async t => {
  const f = fixture(t), pid = process.pid; fs.writeFileSync(path.join(f.root, 'control.json'), JSON.stringify({ pid, port: 12345, token: 'fixture-only' }));
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ pid, appReady: true, windows: [{}] })); };
  assert.equal(await waitForRuntime({ root: f.root, pid, fetchImpl }), true); assert.equal(calls, 1);
  assert.equal(await waitForRuntime({ root: f.root, pid, fetchImpl, alive: () => false }), false);
  assert.equal(await waitForRuntime({ root: f.root, pid: undefined, fetchImpl }), false);
});
