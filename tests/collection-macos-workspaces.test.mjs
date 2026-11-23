import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { MacCollectionNotion } from '../src/compat/macos-collection-notion.cjs';

function fixture() {
  const ids = [randomUUID(), randomUUID()], calls = [], writes = [];
  const profiles = ids.map((workspaceId, i) => ({ workspaceId, name: '合成工作区' + i }));
  const configs = ids.map((workspaceId, i) => ({ workspaceId, key: 'fixture-key-' + i, enabled: true, readOnly: false }));
  const session = { execute: async name => { writes.push(name); return { results: [], has_more: false }; } };
  const router = { identities: new Map(), profiles: () => profiles,
    client: p => ({ config: () => configs[profiles.indexOf(p)] }),
    prepare: async (_signal, id) => {
      calls.push(id); assert.equal(id, ids[1], 'The unavailable connection must not be probed');
      return { workspaces: [{ id, name: profiles[1].name, cfg: configs[1], client: { open: () => session } }], unavailable: [] };
    } };
  return { ids, calls, profiles, configs, router, writes, notion: new MacCollectionNotion({ root: '/fixture', router }) };
}

test('Mac lists configured choices without network probes or exposing credentials, then probes only the selected workspace', async () => {
  const f = fixture(), listed = await f.notion.workspaces();
  assert.deepEqual(listed.workspaces.map(w => w.id), f.ids);
  assert.ok(listed.workspaces.every(w => w.name.includes('待联网核验') && !w.verified));
  assert.equal(listed.autoSelectWorkspaceId, ''); assert.deepEqual(f.calls, []);
  assert.ok(!JSON.stringify(listed).includes('fixture-key'));
  await f.notion.search(f.ids[1], '合成测试', {}, new AbortController().signal);
  const target = { workspaceId: f.ids[1], id: randomUUID(), kind: 'page' };
  const connected = await f.notion.connect(target);
  assert.equal(connected.target.workspaceId, f.ids[1]);
  assert.deepEqual(f.calls, [f.ids[1], f.ids[1]]);
  assert.deepEqual(f.writes, ['search_pages', 'search_databases']);
});

test('Mac choices retain read-only state and only reuse a matching unexpired identity for automatic selection', async () => {
  const f = fixture(), key = createHash('sha256').update(f.configs[1].key).digest('hex');
  f.configs[0].readOnly = true;
  f.router.identities.set(key, { id: f.ids[1], name: 'Verified fixture', expiresAt: Date.now() + 60000 });
  let listed = await f.notion.workspaces();
  assert.equal(listed.workspaces[0].readOnly, true); assert.equal(listed.autoSelectWorkspaceId, f.ids[1]);
  f.configs[1].key = 'rotated-fixture-key';
  listed = await f.notion.workspaces(); assert.equal(listed.autoSelectWorkspaceId, ''); assert.equal(listed.workspaces[1].verified, false);
  f.configs[0].enabled = false; f.configs[1].key = '';
  await assert.rejects(f.notion.workspaces(), /未启用|密钥/);
  assert.deepEqual(f.calls, []);
});

test('choosing a Mac connection never bypasses identity failures, read-only grants or write guards', async () => {
  const f = fixture(), target = { workspaceId: f.ids[1], id: randomUUID(), kind: 'page' };
  f.router.prepare = async (_signal, id) => {
    assert.equal(id, f.ids[1]);
    return { workspaces: [], unavailable: [{ workspace_id: id, error: 'Notion 连接密钥所属工作区与配置不一致，已拒绝路由。' }] };
  };
  await assert.rejects(f.notion.search(f.ids[1], '', {}), /不一致/);
  await assert.rejects(f.notion.createPage({ id: randomUUID(), options: { destination: target } }, () => {}), /不一致/);
  assert.deepEqual(f.writes, []);
  const g = fixture(); g.configs[1].readOnly = true;
  await assert.rejects(g.notion.connect({ ...target, workspaceId: g.ids[1] }), /只读/);
  assert.deepEqual(g.writes, []);
  await assert.rejects(g.notion.search('invalid', '', {}), /有效/);
});

test('legacy Mac connections without a configured ID still require online discovery and respect cancellation', async () => {
  const id = randomUUID(); let probes = 0;
  const router = { identities: new Map(), profiles: () => [null], client: () => ({ config: () => ({ key: 'legacy-fixture', enabled: true }) }),
    prepare: async () => { probes++; return { workspaces: [{ id, name: 'Legacy fixture', cfg: { readOnly: false } }], unavailable: [] }; } };
  const notion = new MacCollectionNotion({ root: '/fixture', router });
  assert.equal((await notion.workspaces()).autoSelectWorkspaceId, id); assert.equal(probes, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(notion.workspaces(controller.signal)); assert.equal(probes, 1);
});

test('the production selector leaves pending Mac choices explicit while preserving Windows automatic selection', async () => {
  const source = fs.readFileSync(new URL('../src/collection/ui/collection.js', import.meta.url), 'utf8');
  const functionText = source.slice(source.indexOf('async function populateWorkspaces()'), source.indexOf('async function searchDestinations('));
  const id = randomUUID();
  for (const [mac, multiple] of [[false, false], [true, false], [false, true]]) {
    let searches = 0;
    const select = { options: [], dataset: {}, value: '', replaceChildren(option) { this.options = [option]; }, append(option) { this.options.push(option); } };
    const hints = { replaceChildren(node) { this.node = node; } };
    const workspaces = [{ id, name: '合成连接', readOnly: false }];
    if (multiple) workspaces.push({ id: randomUUID(), name: '另一工作区', readOnly: false });
    const data = { workspaces, ...(mac ? { autoSelectWorkspaceId: '', selectionHint: '选择后核验' } : {}) };
    const run = vm.runInNewContext('(' + functionText + ')', { chosen: null, $: id => id === 'workspace' ? select : hints,
      element: (tag, cls, text) => ({ tag, cls, text }), ensureState: async () => {}, request: async () => data,
      searchDestinations: async () => { searches++; }, updateDestinationSelection: () => {} });
    await run();
    assert.equal(select.options.length, workspaces.length + 1); assert.equal(select.options[1].value, id); assert.equal(select.options[1].disabled, false);
    assert.equal(select.value, mac || multiple ? '' : id); assert.equal(searches, mac || multiple ? 0 : 1);
    assert.equal(hints.node?.text, mac ? '选择后核验' : undefined);
  }
});

test('the destination list reuses a unique or remembered database and leaves ambiguous results explicit', async () => {
  const source = fs.readFileSync(new URL('../src/collection/ui/collection.js', import.meta.url), 'utf8');
  const functionText = source.slice(source.indexOf('async function searchDestinations('), source.indexOf('function updateDestinationSelection('));
  const workspaceId = randomUUID();
  const database = { workspaceId, id: randomUUID(), dataSourceId: randomUUID(), kind: 'database', label: '现有资料库' };
  const page = { workspaceId, id: randomUUID(), kind: 'page', label: '父页面' };
  const otherSource = { ...database, dataSourceId: randomUUID() };
  for (const [databases, nextCursor, expected, favorites = []] of [
    [[database], null, [database]],
    [[database, otherSource], null, []],
    [[database], 'more-databases', []],
    [[database, otherSource], 'more-databases', [otherSource], [otherSource]]
  ]) {
    const selected = [], calls = [], node = () => ({ dataset: {}, append() {}, replaceChildren() {}, setAttribute() {} });
    const controls = { workspace: { value: workspaceId }, 'destination-search': { value: '' } };
    const run = vm.runInNewContext(functionText + '\nsearchDestinations;', {
      searchVersion: 0, cursors: {}, destinationResults: [], chosen: null, previousDestination: null,
      state: { settings: { favorites } },
      $: id => controls[id] ??= node(), element: node, button: node, updateDestinationSelection() {},
      request: async (action, input) => { calls.push([action, input.workspaceId]); return { results: [page, ...databases], cursors: { page: 'more-pages', database: nextCursor }, hasMore: true }; },
      choose: async item => selected.push(item), message() {}
    });
    await run();
    assert.deepEqual(selected, expected);
    assert.deepEqual(calls, [['destinations', workspaceId]]);
  }
});

test('the collection service loads the compatibility class on Mac only and retains the Windows constructor', t => {
  const require = createRequire(import.meta.url), root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-platform-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(new URL('../src/collection/service.cjs', import.meta.url), 'utf8');
  class WindowsNotion {} class MacNotion {}
  for (const platform of ['win32', 'darwin']) {
    const module = { exports: {} }; let macImports = 0;
    const load = id => {
      if (id === '../compat/macos-collection-notion.cjs') { assert.equal(platform, 'darwin'); macImports++; return { MacCollectionNotion: MacNotion }; }
      if (id === './notion.cjs') return { CollectionNotion: WindowsNotion };
      return require(fileURLToPath(new URL('../src/collection/' + id, import.meta.url)));
    };
    const loader = id => id.startsWith('.') ? load(id) : require(id);
    vm.runInNewContext(source, { require: loader, module, process: { platform }, structuredClone, AbortController, AbortSignal });
    const service = new module.exports.CollectionService({ root, binaries: {}, browser: {}, media: {}, extraction: {} });
    assert.equal(service.notion instanceof (platform === 'darwin' ? MacNotion : WindowsNotion), true);
    assert.equal(macImports, platform === 'darwin' ? 1 : 0); service.close();
  }
});
