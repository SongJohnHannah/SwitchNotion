import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareRootLaunchers } from '../scripts/prepare-root-launchers.mjs';
test('uncompressed root launchers include both systems, keep code current and preserve user data across regeneration', t => {
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-root-launchers-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  for (const dir of ['src', 'scripts', 'assets']) fs.cpSync(path.resolve(dir), path.join(root, dir), { recursive: true });
  for (const file of ['package.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'MAC-使用说明.md', 'Switch Notion 启动.command', 'Switch Notion 配置.command']) fs.copyFileSync(path.resolve(file), path.join(root, file));
  fs.mkdirSync(path.join(root, '.notion-switch')); fs.writeFileSync(path.join(root, '.notion-switch/private.txt'), 'untouched private state');
  const binary = path.join(root, 'fixture-node.exe'), license = path.join(root, 'fixture-license.txt');
  fs.writeFileSync(binary, 'fixture Node'); fs.writeFileSync(license, 'fixture license');
  const options = { sourceProject: root, host: 'win32', nodeExecutable: binary, nodeLicense: license,
    compile: file => fs.writeFileSync(file, 'MZ fixture launcher') };
  const result = prepareRootLaunchers(options);
  assert.equal(result.compressed, false); assert.equal(path.dirname(result.mac), root); assert.equal(path.dirname(result.windows), root);
  assert.equal(fs.readFileSync(path.join(root, 'bin/node.exe'), 'utf8'), 'fixture Node');
  const entry = fs.readFileSync(path.join(result.mac, 'Contents/MacOS/SwitchNotion'), 'utf8');
  assert.ok(entry.includes('adjacent=')); assert.ok(entry.includes('.notion-switch/mac-arm64')); assert.ok(entry.includes('Application Support/Switch Notion'));
  assert.equal(fs.existsSync(path.join(result.mac, 'Contents/Resources/project/.notion-switch')), false);
  prepareRootLaunchers(options); assert.equal(fs.readFileSync(path.join(root, '.notion-switch/private.txt'), 'utf8'), 'untouched private state');
  fs.writeFileSync(path.join(result.mac, 'Contents/Resources/user-added.txt'), 'do not destroy');
  assert.throws(() => prepareRootLaunchers(options), /被修改过/); assert.equal(fs.existsSync(path.join(result.mac, 'Contents/Resources/user-added.txt')), true);
});
