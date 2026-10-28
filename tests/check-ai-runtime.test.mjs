import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import platformModule from '../src/platform/index.cjs';
import { checkAiRuntime } from '../scripts/check-ai-runtime.mjs';
const sourceFiles = ['desktop-hook.cjs', 'client-compat.cjs', 'native-inline.cjs', 'native-mock.cjs', 'compat/inline-documents.cjs'];
function fixture(t, id = 'darwin', explicit = true) {
  const parent = path.resolve('.notion-switch'), base = fs.mkdtempSync(path.join(parent, 'test-ai-runtime-'));
  t.after(() => { assert.equal(path.dirname(base), parent); fs.rmSync(base, { recursive: true, force: true }); });
  const projectDirectory = path.join(base, '项目 空格'), root = explicit ? path.join(base, '用户 甲', 'Library', 'Application Support', 'Switch Notion') : path.join(projectDirectory, '.notion-switch', ...(id === 'darwin' ? ['mac-arm64'] : []));
  const platform = platformModule.createDesktopPlatform({ id, arch: id === 'darwin' ? 'arm64' : 'x64', env: {}, home: base, execFileSync: () => assert.fail('No system commands') });
  const target = path.join(platform.runtimeLayout(path.join(root, 'runtime')).resources, 'notion-switch');
  const write = (base, name, data) => { const file = path.join(base, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  const source = path.join(projectDirectory, 'src');
  for (const name of sourceFiles) for (const folder of [source, target]) write(folder, name, 'synthetic source ' + name);
  for (const folder of [source, target]) {
    write(folder, 'vendor/document-parser.manifest.json', JSON.stringify([{ name: 'unpdf', files: [{ file: 'dist/pdfjs.mjs' }] }]));
    write(folder, 'vendor/web-parser.manifest.json', JSON.stringify([{ name: 'entities', files: [{ file: 'lib/index.js' }] }]));
    write(folder, 'vendor/unpdf/dist/pdfjs.mjs', 'synthetic PDF resource'); write(folder, 'vendor/entities/lib/index.js', 'synthetic HTML resource');
  }
  write(root, 'prepared.json', JSON.stringify({ platform: id }));
  return { projectDirectory, root, platform, env: {}, source, target, write };
}

for (const id of ['darwin', 'win32']) test(`read-only AI disk comparison uses ${id} runtime layout and explicit Unicode profile`, async t => {
  const f = fixture(t, id), readOnly = { ...fs, writeFileSync: () => assert.fail('Read-only audit cannot write'), mkdirSync: () => assert.fail('Read-only audit cannot prepare a runtime') };
  const report = await checkAiRuntime({ ...f, fsImpl: readOnly, fetchImpl: () => assert.fail('No control record, no network') });
  assert.equal(report.ok, true); assert.equal(report.filesCompared, sourceFiles.length + 4); assert.equal(report.identical, report.filesCompared); assert.equal(report.control.reachable, false);
});

test('Mac source mode defaults to its own mac-arm64 state instead of the Windows project profile', async t => {
  const f = fixture(t, 'darwin', false), { root, ...args } = f;
  assert.equal((await checkAiRuntime(args)).ok, true);
  assert.equal((await checkAiRuntime({ ...args, env: { NOTION_SWITCH_ROOT: root } })).ok, true);
});

test('missing modules and resource-only changes are reported without overwriting the current runtime', async t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.target, 'native-inline.cjs')); f.write(f.target, 'vendor/unpdf/dist/pdfjs.mjs', 'older PDF resource');
  const report = await checkAiRuntime(f); assert.equal(report.ok, false);
  assert.deepEqual(report.missing, ['native-inline.cjs']); assert.deepEqual(report.changed, ['vendor/unpdf/dist/pdfjs.mjs']);
  assert.equal(fs.readFileSync(path.join(f.target, 'vendor/unpdf/dist/pdfjs.mjs'), 'utf8'), 'older PDF resource');
});

test('new source helpers outside the original entry list are included before synchronization can pass', async t => {
  const f = fixture(t); f.write(f.source, 'future/new-reference-helper.cjs', 'synthetic future source');
  const report = await checkAiRuntime(f); assert.equal(report.ok, false); assert.deepEqual(report.missing, ['future/new-reference-helper.cjs']);
});

test('matching files without a valid runtime marker cannot claim that the isolated program is ready', async t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.root, 'prepared.json'));
  const report = await checkAiRuntime({ ...f, fetchImpl: () => assert.fail('No valid runtime marker, no control query') });
  assert.equal(report.identical, report.filesCompared); assert.equal(report.ok, false); assert.equal(report.runtimeRecordValid, false);
});

test('a copied Windows profile on Mac cannot connect to its old control record or claim a matching runtime', async t => {
  const f = fixture(t); f.write(f.root, 'prepared.json', JSON.stringify({ platform: 'win32' }));
  f.write(f.root, 'control.json', JSON.stringify({ port: 12345, token: 'a'.repeat(64) }));
  const report = await checkAiRuntime({ ...f, fetchImpl: () => assert.fail('Wrong-platform state must not connect') });
  assert.equal(report.ok, false); assert.equal(report.runtimePlatformMatches, false);
});

test('live status is a fixed authenticated GET, reports only safe fields and never requests quit or restart', async t => {
  const f = fixture(t), token = 'b'.repeat(64); f.write(f.root, 'control.json', JSON.stringify({ port: 12345, token }));
  const report = await checkAiRuntime({ ...f, fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:12345/status'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, 'Bearer ' + token);
    return new Response(JSON.stringify({ appReady: true, activeTurns: 2, compatibility: { unsupportedAssets: ['example'] }, token, privateText: 'must-not-print' }));
  } });
  assert.equal(report.control.activeTurns, 2); assert.equal(report.control.unsupportedFrontendAssets, 1); assert.ok(!JSON.stringify(report).includes(token)); assert.ok(!JSON.stringify(report).includes('must-not-print'));
});

test('invalid manifests and relative profile arguments fail without reading outside declared source directories', async t => {
  const f = fixture(t); f.write(f.source, 'vendor/document-parser.manifest.json', JSON.stringify([{ name: 'unpdf', files: [{ file: '../../private.txt' }] }]));
  const report = await checkAiRuntime(f); assert.equal(report.ok, false); assert.deepEqual(report.invalidSource, ['vendor/document-parser.manifest.json']);
  assert.ok(!JSON.stringify(report).includes('private.txt')); await assert.rejects(checkAiRuntime({ ...f, root: 'relative-state' }), /绝对路径/);
});
