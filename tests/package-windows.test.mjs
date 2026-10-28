import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stageWindows } from '../scripts/package-windows.mjs';
import { verifyPackagedImagePreview } from './helpers/packaged-image-preview.mjs';
import { verifyPackagedReferences, verifyPackagedInlineReferences, verifyPackagedAiBlockSources, verifyPackagedFormulaPreview, verifyPackagedAutofill, verifyPackagedDatabaseBuild, verifyPackagedInstructionSelection, verifyPackagedConversationScope, verifyPackagedWebSources, verifyPackagedResearchScope, verifyPackagedNativeWebResearch } from './helpers/packaged-references.mjs';
test('the portable package uses an allowlist, carries its runtime and licenses, and excludes private state and Notion binaries', async t => {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-package-')), project = path.join(root, 'project');
  fs.mkdirSync(project); t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  for (const folder of ['src', 'scripts', 'docs']) fs.cpSync(path.resolve(folder), path.join(project, folder), { recursive: true });
  for (const folder of ['.notion-switch', 'research']) fs.mkdirSync(path.join(project, folder));
  for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'WINDOWS-使用说明.md', 'MAC-使用说明.md', 'package.json', 'NotionSwitch 启动.vbs', 'NotionSwitch 配置.vbs', 'NotionSwitch 更新.vbs']) fs.copyFileSync(path.resolve(name), path.join(project, name));
  fs.writeFileSync(path.join(project, '.notion-switch/deepseek-api-key.txt'), 'fixture secret that must never ship');
  fs.writeFileSync(path.join(project, 'research/private.txt'), 'fixture private research');
  const binary = path.join(root, 'node.exe'), license = path.join(root, 'LICENSE'); fs.writeFileSync(binary, 'synthetic Node runtime'); fs.writeFileSync(license, 'synthetic license');
  const destination = path.join(project, 'dist/test/NotionSwitch');
  const manifest = stageWindows({ sourceProject: project, destination, nodeExecutable: binary, nodeLicense: license, launcherBuilder: dir => fs.writeFileSync(path.join(dir, 'NotionSwitch.exe'), 'fixture launcher') });
  assert.equal(fs.existsSync(path.join(destination, '.notion-switch')), false); assert.equal(fs.existsSync(path.join(destination, 'research')), false);
  assert.equal(fs.existsSync(path.join(destination, 'bin/node.exe')), true); assert.equal(fs.existsSync(path.join(destination, 'licenses/NODE-LICENSE.txt')), true);
  assert.equal(manifest.requiresOfficialNotion, true); assert.equal(manifest.includesUserData, false); assert.equal(manifest.license, 'MIT');
  assert.ok(manifest.files.some(item => item.file === 'NotionSwitch.exe'));
  assert.equal(manifest.files.some(item => /Notion\.exe|private\.txt|deepseek-api-key\.txt/.test(item.file)), false);
  const documents = ['WINDOWS-使用说明.md'], visited = new Set();
  while (documents.length) {
    const name = documents.shift(); if (visited.has(name)) continue; visited.add(name);
    const content = fs.readFileSync(path.join(destination, name), 'utf8');
    for (const [, target] of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^[a-z][a-z\d+.-]*:|^#/i.test(target)) continue;
      const linked = path.normalize(path.join(path.dirname(name), decodeURIComponent(target.split('#')[0])));
      assert.ok(fs.existsSync(path.join(destination, linked)), `${name} links to a missing packaged document: ${linked}`);
      if (/\.md$/i.test(linked)) documents.push(linked);
    }
  }
  assert.ok(visited.has(path.normalize('docs/WINDOWS-VALIDATION-CHECKLIST.md')));
  await verifyPackagedImagePreview(path.join(destination, 'src'), path.join(root, 'Windows 用户资料', 'image state'));
  await verifyPackagedReferences(path.join(destination, 'src'), path.join(root, 'Windows 用户资料', '引用 state'));
  await verifyPackagedInlineReferences(path.join(destination, 'src'), path.join(root, 'Windows 用户资料', '浮动引用 state'));
  await verifyPackagedAiBlockSources(path.join(destination, 'src'));
  await verifyPackagedFormulaPreview(path.join(destination, 'src'));
  await verifyPackagedAutofill(path.join(destination, 'src'), path.join(root, 'Windows 用户资料', '填充 state'));
  await verifyPackagedDatabaseBuild(path.join(destination, 'src'));
  verifyPackagedInstructionSelection(path.join(destination, 'src'));
  await verifyPackagedConversationScope(path.join(destination, 'src'));
  await verifyPackagedWebSources(path.join(destination, 'src'), path.join(root, 'Windows 用户资料', '网页 sources'));
  await verifyPackagedResearchScope(path.join(destination, 'src'), path.join(root, 'Windows 用户资料', '研究 scope'));
  await verifyPackagedNativeWebResearch(path.join(destination, 'src'), path.join(root, 'Windows 用户资料', '网页研究 conversations'));
  assert.throws(() => stageWindows({ sourceProject: project, destination: path.join(root, 'outside') }), /dist/);
});
