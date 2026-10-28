import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { stageMac } from '../scripts/package-macos.mjs';
import { zipDirectory } from '../scripts/portable-zip.mjs';
import { verifyPackagedImagePreview } from './helpers/packaged-image-preview.mjs';
import { verifyPackagedReferences, verifyPackagedInlineReferences, verifyPackagedAiBlockSources, verifyPackagedFormulaPreview, verifyPackagedAutofill, verifyPackagedDatabaseBuild, verifyPackagedInstructionSelection, verifyPackagedConversationScope, verifyPackagedWebSources, verifyPackagedResearchScope, verifyPackagedNativeWebResearch } from './helpers/packaged-references.mjs';
const project = path.resolve(import.meta.dirname, '..');

test('Mac package is relocatable, reuses Notion icon and preserves double-click executable bits without bundling private data', async t => {
  const dist = path.join(project, 'dist'); fs.mkdirSync(dist, { recursive: true });
  const base = fs.mkdtempSync(path.join(dist, 'test-mac-package-'));
  t.after(() => { assert.equal(path.dirname(base), dist); fs.rmSync(base, { recursive: true, force: true }); });
  const result = stageMac({ destination: path.join(base, 'Switch Notion M1') });
  assert.equal(result.includesNotion, false); assert.equal(result.includesUserData, false); assert.equal(result.notarized, false);
  assert.match(fs.readFileSync(path.join(result.app,'Contents/Resources/project/docs/MAC-CHECKLIST-ACCEPTANCE-2026-10-29.md'),'utf8'), /C10 建库菜单位置/);
  const plist = fs.readFileSync(path.join(result.app, 'Contents/Info.plist'), 'utf8');
  assert.equal(path.basename(result.app), 'SwitchNotion.app');
  assert.match(plist, /<key>CFBundleName<\/key><string>SwitchNotion<\/string>/);
  assert.match(plist, /<key>CFBundleDisplayName<\/key><string>SwitchNotion<\/string>/); assert.ok(plist.includes('notion.icns'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.directory, 'package-manifest.json'))).name, 'SwitchNotion');
  for (const name of ['Switch Notion 启动.command', 'Switch Notion 配置.command']) {
    assert.ok(fs.readFileSync(path.join(result.directory, name), 'utf8').includes('/SwitchNotion.app/Contents/Resources/project'));
  }
  assert.deepEqual(fs.readFileSync(path.join(result.app, 'Contents/Resources/notion.icns')), fs.readFileSync(path.join(project, 'assets/notion.icns')));
  const entry = fs.readFileSync(path.join(result.app, 'Contents/MacOS/SwitchNotion'), 'utf8');
  assert.ok(entry.includes('../Resources/project')); assert.ok(entry.includes('$HOME/Library/Application Support/Switch Notion'));
  assert.ok(!entry.includes(project));
  assert.deepEqual(fs.readFileSync(path.join(result.app, 'Contents/Resources/project/src/runtime-bootstrap.cjs')), fs.readFileSync(path.join(project, 'src/runtime-bootstrap.cjs')));
  await verifyPackagedImagePreview(path.join(result.app, 'Contents/Resources/project/src'), path.join(base, 'Mac 用户资料', 'Application Support', 'Switch Notion'));
  await verifyPackagedReferences(path.join(result.app, 'Contents/Resources/project/src'), path.join(base, 'Mac 用户资料', '引用 state'));
  await verifyPackagedInlineReferences(path.join(result.app, 'Contents/Resources/project/src'), path.join(base, 'Mac 用户资料', '浮动引用 state'));
  await verifyPackagedAiBlockSources(path.join(result.app, 'Contents/Resources/project/src'));
  await verifyPackagedFormulaPreview(path.join(result.app, 'Contents/Resources/project/src'));
  await verifyPackagedAutofill(path.join(result.app, 'Contents/Resources/project/src'), path.join(base, 'Mac 用户资料', '填充 state'));
  await verifyPackagedDatabaseBuild(path.join(result.app, 'Contents/Resources/project/src'));
  verifyPackagedInstructionSelection(path.join(result.app, 'Contents/Resources/project/src'));
  await verifyPackagedConversationScope(path.join(result.app, 'Contents/Resources/project/src'));
  await verifyPackagedWebSources(path.join(result.app, 'Contents/Resources/project/src'), path.join(base, 'Mac 用户资料', 'Application Support', '网页 sources'));
  await verifyPackagedResearchScope(path.join(result.app, 'Contents/Resources/project/src'), path.join(base, 'Mac 用户资料', '研究 scope'));
  await verifyPackagedNativeWebResearch(path.join(result.app, 'Contents/Resources/project/src'), path.join(base, 'Mac 用户资料', '网页研究 conversations'));
  const archive = path.join(base, 'mac.zip'); zipDirectory({ directory: result.directory, output: archive });
  const bytes = fs.readFileSync(archive), end = bytes.length - 22, start = bytes.readUInt32LE(end + 16), count = bytes.readUInt16LE(end + 10);
  let at = start; const modes = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50);
    const length = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32);
    const name = bytes.subarray(at + 46, at + 46 + length).toString('utf8');
    modes.set(name, bytes.readUInt32LE(at + 38) >>> 16 & 0o777);
    assert.ok(!name.split('/').some(part => ['.notion-switch', 'research'].includes(part)));
    assert.ok(!/(?:deepseek-api-key|app\.asar|Notion\.exe|model\.bin)/.test(name));
    const local = bytes.readUInt32LE(at + 42), nameLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), compressed = bytes.readUInt32LE(at + 20);
    const data = inflateRawSync(bytes.subarray(local + 30 + nameLength + localExtra, local + 30 + nameLength + localExtra + compressed));
    assert.equal(data.length, bytes.readUInt32LE(at + 24));
    at += 46 + length + extra + comment;
  }
  for (const [name, mode] of modes) if (/\.command$|\.sh$|Contents\/MacOS\//.test(name)) assert.equal(mode, 0o755, name);
  assert.ok([...modes.keys()].some(name => name.endsWith('/Switch Notion 启动.command')));
  assert.ok([...modes.keys()].some(name => name.includes('/SwitchNotion.app/Contents/Info.plist')));
  assert.throws(() => stageMac({ destination: result.directory }), /新目录/);
});
