import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findNotion, notionDirectory } from '../scripts/source-discovery.mjs';
function fixture(t) {
  const parent = path.resolve('.notion-switch'), dir = fs.mkdtempSync(path.join(parent, 'test-discovery-')), root = path.join(dir, 'state'); fs.mkdirSync(root);
  t.after(() => { assert.equal(path.dirname(dir), parent); fs.rmSync(dir, { recursive: true, force: true }); });
  const install = name => { const p = path.join(dir, name); fs.mkdirSync(path.join(p, 'resources'), { recursive: true }); fs.writeFileSync(path.join(p, 'Notion.exe'), 'fixture'); fs.writeFileSync(path.join(p, 'resources/app.asar'), 'fixture'); return p; };
  return { dir, root, install };
}
test('fresh machines discover their own user installation rather than another computer path', t => {
  const f = fixture(t), local = path.join(f.dir, 'new-user'), installation = f.install('new-user/Programs/Notion');
  assert.equal(findNotion(f.root, { env: { LOCALAPPDATA: local }, home: f.dir, registry: () => { throw Error('no registry needed'); } }), installation);
});

test('redirected app-data environments still discover the installation in the actual user home', t => {
  const f = fixture(t), installed = f.install('user-home/AppData/Local/Programs/Notion');
  assert.equal(findNotion(f.root, { env: { LOCALAPPDATA: path.join(f.dir, 'redirected') }, home: path.join(f.dir, 'user-home'), registry: () => [] }), installed);
});
test('a selected custom installation or registry location is supported without choosing the isolated copy as source', t => {
  const f = fixture(t), installed = f.install('custom'), isolated = path.join(f.root, 'runtime');
  fs.cpSync(installed, isolated, { recursive: true });
  assert.equal(notionDirectory(path.join(isolated, 'Notion.exe'), f.root), null);
  assert.equal(findNotion(f.root, { env: {}, home: path.join(f.dir, 'missing'), registry: () => [path.join(installed, 'Notion.exe')] }), installed);
  fs.writeFileSync(path.join(f.root, 'installation.local.json'), JSON.stringify({ source: installed }));
  assert.equal(findNotion(f.root, { env: {}, registry: () => { throw Error('must use saved choice'); } }), installed);
});
test('no installation returns a missing result so the bootstrap can offer the official download page', t => {
  const f = fixture(t); assert.equal(findNotion(f.root, { env: {}, home: path.join(f.dir, 'missing'), registry: () => [] }), null);
  assert.equal(notionDirectory('relative/Notion.exe', f.root), null);
});
