import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SettingsService } = require('../src/settings-service.cjs');
const { NotionRouter, registryName } = require('../src/notion-routing.cjs');
const { ProviderRouter } = require('../src/provider.cjs');
const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', W2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture(t, extra = {}) {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-settings-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = [];
  const fetchImpl = async (url, options) => {
    const key = options.headers.authorization.slice(7), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method || 'GET', key, body });
    if (extra.fetch) { const response = await extra.fetch({ url, options, key }); if (response) return response; }
    if (url === 'https://api.deepseek.com/models') return key === 'fixture-deepseek' ? json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }) : new Response('private sk-' + 'upstream-fixture-secret', { status: 401 });
    assert.ok(url.startsWith('https://api.notion.com/v1/'));
    const workspace = key === 'fixture-one' || key === 'fixture-one-rotated' ? W1 : key === 'fixture-two' ? W2 : null;
    if (!workspace) return new Response('private ntn_' + 'upstream_fixture_secret', { status: 401 });
    if (url.endsWith('/users/me')) return json({ type: 'bot', bot: { workspace_id: workspace, workspace_name: workspace === W1 ? '真实工作区甲' : '真实工作区乙' } });
    if (url.endsWith('/search')) return json({ results: [{ id: '11111111-1111-4111-8111-111111111111' }], has_more: false, next_cursor: null });
    throw Error('unexpected endpoint');
  };
  return { root, fetchImpl, calls, service: new SettingsService({ root, fetchImpl, intervalMs: 0 }) };
}
const result = response => { assert.equal(response.ok, true, response.error); return response.result; };

test('GUI adds named workspaces using only a key, persists automatic identity and returns no secrets or advanced options', async t => {
  const f = fixture(t);
  assert.equal(result(await f.service.request('state')).workspaces.length, 0);
  const added = result(await f.service.request('workspace.save', { name: '我的笔记', apiKey: 'fixture-one' }));
  const auto = result(await f.service.request('workspace.save', { name: '', apiKey: 'fixture-two' }));
  assert.equal(auto.workspace.name, '真实工作区乙');
  const reopened = new SettingsService({ root: f.root, fetchImpl: f.fetchImpl, intervalMs: 0 });
  const state = result(await reopened.request('state'));
  assert.deepEqual(state.workspaces.map(w => w.name), ['我的笔记', '真实工作区乙']);
  assert.equal(state.workspaces[0].workspaceName, '真实工作区甲');
  const serialized = JSON.stringify(state);
  for (const forbidden of ['fixture-one', 'fixture-two', 'workspaceId', W1, 'readOnly', 'pageIds', 'searchBatchSize']) assert.equal(serialized.includes(forbidden), false);
  const session = await new NotionRouter({ root: f.root, fetchImpl: f.fetchImpl, intervalMs: 0 }).open();
  assert.equal(session.context.workspaces[0].name, '我的笔记');
  const tested = result(await f.service.request('workspace.test', { id: added.workspace.id }));
  assert.equal(tested.status, 'connected');
  assert.ok(f.calls.every(c => ['GET', 'POST'].includes(c.method)));
});

test('GUI blank key edit retains secret, key rotation stays in the same workspace, and wrong workspace key never overwrites', async t => {
  const f = fixture(t), added = result(await f.service.request('workspace.save', { apiKey: 'fixture-one' }));
  result(await f.service.request('workspace.save', { id: added.workspace.id, name: '新名称', apiKey: '' }));
  let profiles = JSON.parse(fs.readFileSync(path.join(f.root, registryName), 'utf8')).connections;
  assert.equal(profiles[0].apiKey === 'fixture-one', true);
  const before = fs.readFileSync(path.join(f.root, registryName), 'utf8');
  const wrong = await f.service.request('workspace.save', { id: added.workspace.id, name: 'must not save', apiKey: 'fixture-two' });
  assert.equal(wrong.ok, false); assert.match(wrong.error, /另一个工作区/);
  assert.equal(fs.readFileSync(path.join(f.root, registryName), 'utf8') === before, true);
  result(await f.service.request('workspace.save', { id: added.workspace.id, name: '已换密钥', apiKey: 'fixture-one-rotated' }));
  profiles = JSON.parse(fs.readFileSync(path.join(f.root, registryName), 'utf8')).connections;
  assert.equal(profiles[0].apiKey === 'fixture-one-rotated', true); assert.equal(profiles[0].workspaceId, W1);
  const duplicate = await f.service.request('workspace.save', { name: 'duplicate', apiKey: 'fixture-one' });
  assert.equal(duplicate.ok, false); assert.match(duplicate.error, /已经添加/);
});

test('GUI removal affects local connection only, preserves other workspace and makes no Notion requests', async t => {
  const f = fixture(t), a = result(await f.service.request('workspace.save', { apiKey: 'fixture-one' }));
  result(await f.service.request('workspace.save', { apiKey: 'fixture-two' }));
  const count = f.calls.length;
  result(await f.service.request('workspace.remove', { id: a.workspace.id }));
  assert.equal(f.calls.length, count);
  const state = result(await f.service.request('state')); assert.deepEqual(state.workspaces.map(w => w.workspaceName), ['真实工作区乙']);
  const router = new NotionRouter({ root: f.root, fetchImpl: f.fetchImpl, intervalMs: 0 });
  const session = await router.open({ nativeContext: { workspace_id: W1 } });
  await assert.rejects(session.execute('search_pages', { query: '', scope: 'title' }), /尚未配置有效连接/);
});

test('GUI rejects invalid secrets and malicious fields without exposing upstream bodies or parser details', async t => {
  const f = fixture(t);
  const bad = await f.service.request('workspace.save', { apiKey: 'bad-key' });
  assert.equal(bad.ok, false); assert.equal(JSON.stringify(bad).includes('upstream_fixture_secret'), false);
  const injection = await f.service.request('workspace.save', { apiKey: 'fixture-one', workspaceId: W2 });
  assert.equal(injection.ok, false);
  assert.equal((await f.service.request('constructor')).ok, false);
  assert.equal((await f.service.request('workspace.remove', { id: 'not-found' })).ok, false);
  const malformed = '{"version":2,"connections":[{"apiKey":"ntn_' + 'parser_fixture_secret"}';
  fs.writeFileSync(path.join(f.root, registryName), malformed);
  const broken = await f.service.request('state');
  assert.equal(broken.ok, false); assert.equal(JSON.stringify(broken).includes('ntn_' + 'parser_fixture_secret'), false);
});

test('GUI DeepSeek validation uses only official models endpoint and preserves saved key on invalid replacement', async t => {
  const f = fixture(t);
  result(await f.service.request('deepseek.save', { apiKey: 'fixture-deepseek', model: 'deepseek-flash' }));
  const router = new ProviderRouter({ root: f.root });
  assert.equal(router.status().mode, 'deepseek'); assert.equal(router.status().keyConfigured, true);
  assert.equal(router.config().maxTokens, 'max');
  assert.equal(router.status().maxOutputTokens, 393216);
  const state = result(await f.service.request('state'));
  assert.equal(JSON.stringify(state).includes('fixture-deepseek'), false);
  const keyBefore = fs.readFileSync(path.join(f.root, 'deepseek-api-key.txt'), 'utf8');
  const invalid = await f.service.request('deepseek.save', { apiKey: 'bad-deepseek', model: 'deepseek-v4-pro' });
  assert.equal(invalid.ok, false); assert.equal(JSON.stringify(invalid).includes('upstream-fixture-secret'), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'deepseek-api-key.txt'), 'utf8') === keyBefore, true);
  result(await f.service.request('deepseek.save', { apiKey: '', model: 'deepseek-v4-pro' }));
  assert.equal(router.config().model, 'deepseek-v4-pro');
  assert.ok(f.calls.every(c => c.url === 'https://api.deepseek.com/models' && c.method === 'GET'));
});

test('GUI operations serialize concurrent saves and preserve existing local page and read-only restrictions', async t => {
  const f = fixture(t);
  await Promise.all([f.service.request('workspace.save', { apiKey: 'fixture-one' }), f.service.request('workspace.save', { apiKey: 'fixture-two' })]);
  const state = result(await f.service.request('state')); assert.equal(state.workspaces.length, 2);
  const file = path.join(f.root, registryName), data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.connections[0].readOnly = true; data.connections[0].pageIds = ['11111111-1111-4111-8111-111111111111'];
  fs.writeFileSync(file, JSON.stringify(data));
  result(await f.service.request('workspace.save', { id: state.workspaces[0].id, name: '保留权限', apiKey: '' }));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).connections[0];
  assert.equal(saved.readOnly, true); assert.deepEqual(saved.pageIds, data.connections[0].pageIds);
});
