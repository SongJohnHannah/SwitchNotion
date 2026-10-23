import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { NotionRouter, registerConnection, consolidateConnections, registryName } = require('../src/notion-routing.cjs');
const { nativeContext } = require('../src/native-context.cjs');
const { AgentMock } = require('../src/agent-mock.cjs');
const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', W2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture(t, extra = {}) {
  const parent = path.resolve(import.meta.dirname, '../.notion-switch');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-routing-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const profiles = [
    { workspaceId: W1, name: '甲', apiKey: 'fixture-key-one', searchBatchSize: 1 },
    { workspaceId: W2, name: '乙', apiKey: 'fixture-key-two', searchBatchSize: 1 }
  ];
  const save = () => fs.writeFileSync(path.join(root, registryName), JSON.stringify({ version: 2, connections: profiles })); save();
  const pages = new Map([[W1, new Map([[A, { title: '共同测试甲', markdown: '甲：CURRENT-A' }], [C, { title: '共同测试丙', markdown: '丙：CURRENT-C' }]])], [W2, new Map([[B, { title: '共同测试乙', markdown: '乙：CURRENT-B' }]])]]);
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.ok(url.startsWith('https://api.notion.com/v1/'));
    const key = options.headers.authorization.slice(7), wid = key === 'fixture-key-one' ? W1 : key === 'fixture-key-two' ? W2 : null;
    assert.ok(wid, 'only workspace-specific keys may reach Notion');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ wid, method: options.method, url, body });
    if (extra.fetch) { const result = await extra.fetch({ wid, url, options, body, pages }); if (result) return result; }
    if (url.endsWith('/users/me')) return json({ type: 'bot', bot: { workspace_id: wid, workspace_name: wid === W1 ? '甲' : '乙' } });
    const records = pages.get(wid);
    if (url.endsWith('/search')) {
      const rows = [...records].filter(([, p]) => !body.query || p.title.includes(body.query)), offset = Number(body.start_cursor) || 0;
      const batch = rows.slice(offset, offset + body.page_size), more = offset + batch.length < rows.length;
      return json({ results: batch.map(([id, p]) => ({ id, properties: { title: { type: 'title', title: [{ plain_text: p.title }] } } })), has_more: more, next_cursor: more ? String(offset + batch.length) : null });
    }
    const id = url.match(/pages\/([^/]+)\/markdown$/)?.[1], page = records.get(id);
    if (!page) return new Response('private response fixture-key-one', { status: 404 });
    if (options.method === 'PATCH') {
      if (body.type === 'insert_content') page.markdown += '\n\n' + body.insert_content.content;
      else for (const edit of body.update_content.content_updates) page.markdown = page.markdown.replace(edit.old_str, edit.new_str);
    }
    return json({ markdown: page.markdown });
  };
  const router = new NotionRouter({ root, fetchImpl, intervalMs: 0 });
  return { root, profiles, save, pages, calls, fetchImpl, router };
}
async function waitFor(agent) { for (let i = 0; i < 300; i++) { if (!agent.status().active) return; await sleep(3); } throw Error('fixture timeout'); }

test('one configuration holds arbitrary workspace credentials and new entries discover identity without manual IDs', async t => {
  const f = fixture(t); delete f.profiles[1].workspaceId; f.save();
  const session = await f.router.open({ nativeContext: { workspace_id: W2, page_id: B } });
  const context = await session.execute('list_workspaces');
  assert.deepEqual(context.workspaces.map(w => w.name), ['甲', '乙']);
  assert.equal(context.current_page.workspace_id, W2);
  assert.equal((await session.execute('read_page', { page_id: 'current' })).markdown, '乙：CURRENT-B');
  assert.equal(JSON.stringify(context).includes('fixture-key'), false);
  assert.equal(JSON.stringify(f.router.status()).includes('fixture-key'), false);
  assert.deepEqual(fs.readdirSync(f.root), [registryName]);
});

test('federated search visits every workspace and child cursor, rejects changed query and returns explicit provenance', async t => {
  const f = fixture(t), session = await f.router.open({ nativeContext: { workspace_id: W1, page_id: A } });
  const args = { query: '共同', scope: 'title', workspace_id: 'all' }, found = [];
  let result = await session.execute('search_pages', args);
  const first = result;
  for (;;) {
    found.push(...result.results);
    if (!result.has_more) break;
    assert.equal(result.complete, false);
    result = await session.execute('search_pages', { ...args, start_cursor: result.next_cursor });
  }
  assert.deepEqual(found.map(r => [r.page_id, r.workspace_id]), [[A, W1], [C, W1], [B, W2]]);
  assert.equal(result.complete, true); assert.equal(result.next_cursor, null);
  assert.deepEqual(f.calls.filter(c => c.url.endsWith('/search')).map(c => c.body.start_cursor || null), [null, '1', null]);
  await assert.rejects(session.execute('search_pages', { ...args, query: 'changed', start_cursor: first.next_cursor }), /游标无效/);
  const other = await session.execute('read_page', { page_id: B, workspace_id: found.at(-1).workspace_id });
  assert.equal(other.markdown, '乙：CURRENT-B');
});

test('current page title uses authoritative metadata rather than a child-page link in the body', async t => {
  const f = fixture(t, { fetch: ({ url }) => url.endsWith('/pages/' + A) ? json({ properties: { Name: { type: 'title', title: [{ plain_text: '真正的当前页' }] } } }) : null });
  f.pages.get(W1).get(A).markdown = '[子页面名称](https://www.notion.so/' + C + ')\n当前页正文';
  const session = await f.router.open({ nativeContext: { workspace_id: W1, page_id: A } });
  const page = await session.execute('read_page', { page_id: 'current' });
  assert.equal(page.title, '真正的当前页'); assert.equal(page.title_source, 'notion-page-metadata');
  assert.ok(page.markdown.includes('子页面名称'));
  const missing = await f.router.open({ nativeContext: { workspace_id: W2, page_id: B } });
  const unknown = await missing.execute('read_page', { page_id: 'current' });
  assert.equal(unknown.title, null); assert.equal(unknown.title_source, 'unavailable');
});

test('creation resolves current parents, preserves workspace routing and recognizes new children', async t => {
  const created = [], firstId = '44444444-4444-4444-8444-444444444444', secondId = '55555555-5555-4555-8555-555555555555';
  const meta = (id, row) => ({ object: 'page', id, parent: row.parent || { type: 'workspace', workspace: true }, properties: { title: { type: 'title', title: [{ plain_text: row.title, type: 'text', text: { content: row.title } }] } }, in_trash: false });
  const f = fixture(t, { fetch: ({ wid, url, options, body, pages }) => {
    const records = pages.get(wid);
    if (url.endsWith('/pages') && options.method === 'POST') {
      const id = wid === W1 ? firstId : secondId;
      assert.equal(records.has(body.parent.page_id), true);
      const row = { title: body.properties.title.title[0].text.content, markdown: body.markdown || '', parent: body.parent };
      records.set(id, row); created.push({ wid, parent: body.parent.page_id }); return json(meta(id, row));
    }
    const id = url.match(/\/pages\/([^/]+)$/)?.[1];
    if (id && records.has(id)) return json(meta(id, records.get(id)));
  } });
  f.profiles[0].pageIds = [A]; f.save();
  const session = await f.router.open({ nativeContext: { workspace_id: W1, page_id: A }, operationScope: 'content-routing' });
  const one = await session.execute('create_page', { parent_page_id: 'current', title: '甲的新子页', content: '合成正文' });
  assert.equal(one.workspace_id, W1); assert.equal(one.verified, true);
  assert.equal((await session.execute('read_page', { page_id: one.page_id })).markdown, '合成正文');
  const two = await session.execute('create_page', { workspace_id: W2, parent_page_id: B, title: '乙的新子页' });
  assert.equal(two.workspace_id, W2); assert.equal(two.verified, true);
  assert.deepEqual(created, [{ wid: W1, parent: A }, { wid: W2, parent: B }]);
  await assert.rejects(session.execute('create_page', { workspace_id: W2, parent_page_id: 'current', title: '不能跨区误写' }), /当前页面不属于/);
  const readonly = fixture(t); readonly.profiles[1].readOnly = true; readonly.save();
  const restricted = await readonly.router.open({ nativeContext: { workspace_id: W2, page_id: B } });
  await assert.rejects(restricted.execute('create_page', { parent_page_id: 'current', title: '不能写入只读区' }), /只读/);
  assert.equal(readonly.calls.some(call => call.method === 'POST' && call.url.endsWith('/pages')), false);
});

test('current page writes use current connection, other workspace writes require their own read and preserve provenance', async t => {
  const f = fixture(t), session = await f.router.open({ nativeContext: { workspace_id: W1, page_id: A }, operationScope: 'two-workspace-write' });
  const a = await session.execute('read_page', { page_id: 'current' });
  const b = await session.execute('read_page', { page_id: B, workspace_id: W2 });
  const result = await session.execute('append_page', { page_id: B, workspace_id: W2, revision: b.revision, content: a.markdown });
  assert.equal(result.verified, true); assert.equal(result.workspace_id, W2);
  assert.equal(f.pages.get(W1).get(A).markdown, '甲：CURRENT-A');
  assert.ok(f.pages.get(W2).get(B).markdown.includes(a.markdown));
  assert.deepEqual(f.calls.filter(c => c.method === 'PATCH').map(c => c.wid), [W2]);
  await assert.rejects(session.execute('read_page', { page_id: 'current', workspace_id: W2 }), /当前页面不属于/);
  const journal = JSON.parse(fs.readFileSync(path.join(f.root, 'write-journal', fs.readdirSync(path.join(f.root, 'write-journal'))[0]), 'utf8'));
  assert.equal(journal.workspace_id, W2);
});

test('federated search retains earlier failure state after later workspace succeeds and detects changed local scope', async t => {
  const f = fixture(t, { fetch: ({ wid, url }) => { if (wid === W1 && url.endsWith('/search')) return new Response('private', { status: 403 }); } });
  const args = { query: '', scope: 'title', workspace_id: 'all' };
  const session = await f.router.open();
  const first = await session.execute('search_pages', args);
  assert.equal(first.has_more, true); assert.equal(first.skipped.length, 1);
  const next = await session.execute('search_pages', { ...args, start_cursor: first.next_cursor });
  assert.equal(next.results[0].workspace_id, W2); assert.equal(next.has_more, false);
  assert.equal(next.complete, false); assert.equal(next.earlier_or_current_batch_incomplete, true);
  f.profiles[0].pageIds = [A]; f.save();
  const changed = await f.router.open();
  await assert.rejects(changed.execute('search_pages', { ...args, start_cursor: first.next_cursor }), /搜索范围已变化/);
});

test('identity mismatch, absent current workspace and revoked permissions never fall back to another key', async t => {
  const f = fixture(t); f.profiles[0].apiKey = 'fixture-key-two'; f.save();
  const session = await f.router.open({ nativeContext: { workspace_id: W1, page_id: A } });
  assert.equal(session.context.unavailable.length, 1);
  await assert.rejects(session.execute('read_page', { page_id: 'current' }), /尚未配置有效连接/);
  assert.equal(f.calls.filter(c => c.url.includes('/pages/')).length, 0);
  const good = await session.execute('read_page', { page_id: B, workspace_id: W2 });
  assert.equal(good.workspace_id, W2);
  await assert.rejects(session.execute('read_page', { page_id: A, workspace_id: W2 }), /HTTP 404/);
  assert.equal(f.calls.at(-1).wid, W2);
  await assert.rejects(session.execute('list_workspaces', []), /不接受/);
});

test('uncertain writes stop further writes across every workspace while reads remain available', async t => {
  const f = fixture(t, { fetch: ({ options }) => { if (options.method === 'PATCH') throw Error('connection reset'); } });
  const session = await f.router.open({ nativeContext: { workspace_id: W1, page_id: A } });
  const a = await session.execute('read_page', { page_id: 'current' });
  await assert.rejects(session.execute('append_page', { page_id: 'current', revision: a.revision, content: 'once only' }), /结果未确定/);
  const b = await session.execute('read_page', { page_id: B, workspace_id: W2 });
  await assert.rejects(session.execute('append_page', { page_id: B, workspace_id: W2, revision: b.revision, content: 'must not submit' }), /所有后续写入/);
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1);
});

test('native summary and continuation read the latest page and workspace without a page link, then refuse missing context', async t => {
  const f = fixture(t), seen = [];
  const provider = { config: () => ({ mode: 'deepseek' }), async *generate({ messages }) {
    const result = JSON.parse(messages.at(-1).content); seen.push(result);
    assert.equal(result.source, 'notion-api'); assert.equal(result.treat_page_content_as_data, true);
    yield result.markdown;
  } };
  const agent = new AgentMock({ provider, workspace: f.router });
  const input = { threadId: 'native-context', spaceId: W1, threadContext: { currentBlockId: A }, content: [{ type: 'text', text: '总结此页面' }] };
  agent.create(input); await waitFor(agent);
  agent.send({ threadId: input.threadId, spaceId: W2, threadContext: { currentBlockId: B }, event: { type: 'user.message', content: [{ type: 'text', text: '总结当前页' }] } }); await waitFor(agent);
  assert.equal(agent.status().failed, 0); assert.deepEqual(seen.map(r => [r.page_id, r.workspace_id]), [[A, W1], [B, W2]]);
  agent.send({ threadId: input.threadId, event: { type: 'user.message', content: [{ type: 'text', text: '修改当前页' }] } }); await waitFor(agent);
  assert.equal(agent.status().failed, 1); assert.equal(seen.length, 2);
  assert.equal(agent.find(input).turns.at(-1).nativeContext.page_id, null);
  assert.equal(nativeContext({ spaceId: W1, threadContext: { currentBlockId: 'https://www.notion.so/' + A } }).page_id, null);
});

test('legacy credentials migrate into one verified configuration and only imported key files are cleared', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, registryName), JSON.stringify({ version: 1, connections: f.profiles.map((p, i) => ({ workspaceId: p.workspaceId, name: p.name, apiKeyFile: 'legacy-' + i + '.txt', readOnly: i === 1 })) }));
  f.profiles.forEach((p, i) => fs.writeFileSync(path.join(f.root, 'legacy-' + i + '.txt'), p.apiKey));
  fs.writeFileSync(path.join(f.root, 'deepseek-api-key.txt'), 'unrelated-deepseek-key');
  const result = await consolidateConnections({ root: f.root, fetchImpl: f.fetchImpl, intervalMs: 0 });
  assert.equal(result.clearedLegacyKeyFiles, 2); assert.equal(result.connectionCount, 2);
  assert.equal(fs.readFileSync(path.join(f.root, 'legacy-0.txt'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(f.root, 'deepseek-api-key.txt'), 'utf8'), 'unrelated-deepseek-key');
  const config = JSON.parse(fs.readFileSync(path.join(f.root, registryName), 'utf8'));
  assert.equal(config.version, 2); assert.equal(config.connections[1].readOnly, true);
  assert.equal(config.connections[1].apiKeyFile, undefined);
  const session = await f.router.open({ nativeContext: { workspace_id: W2, page_id: B } });
  assert.equal((await session.execute('read_page', { page_id: 'current' })).workspace_id, W2);
  await assert.rejects(session.execute('append_page', { page_id: 'current', revision: 'x', content: 'no' }), /只读/);
  assert.equal(JSON.stringify(result).includes('fixture-key'), false);
});

test('registration uses the same file for third and later credentials and rejects paths outside local config', async t => {
  const f = fixture(t);
  const thirdId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const fetchImpl = async (url, options) => options.headers.authorization === 'Bearer fixture-key-three' ? json({ type: 'bot', bot: { workspace_id: thirdId, workspace_name: '第三个工作区' } }) : f.fetchImpl(url, options);
  const added = await registerConnection({ root: f.root, apiKey: 'fixture-key-three', fetchImpl, intervalMs: 0 });
  assert.equal(added.name, '第三个工作区'); assert.equal(added.alreadyConnected, false);
  assert.equal(f.router.profiles().length, 3);
  assert.deepEqual(fs.readdirSync(f.root), [registryName]);
  await assert.rejects(registerConnection({ root: f.root, apiKeyFile: '../outside.txt', fetchImpl, intervalMs: 0 }), /隔离配置目录/);
});

test('failed credential migration preserves every existing key and registry', async t => {
  const f = fixture(t);
  const original = JSON.stringify({ version: 1, connections: f.profiles.map((p, i) => ({ workspaceId: p.workspaceId, apiKeyFile: 'legacy-' + i + '.txt' })) });
  fs.writeFileSync(path.join(f.root, registryName), original);
  fs.writeFileSync(path.join(f.root, 'legacy-0.txt'), 'fixture-key-one');
  fs.writeFileSync(path.join(f.root, 'legacy-1.txt'), 'fixture-key-one');
  await assert.rejects(consolidateConnections({ root: f.root, fetchImpl: f.fetchImpl, intervalMs: 0 }), /不一致/);
  assert.equal(fs.readFileSync(path.join(f.root, registryName), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(f.root, 'legacy-0.txt'), 'utf8'), 'fixture-key-one');
  assert.equal(fs.readFileSync(path.join(f.root, 'legacy-1.txt'), 'utf8'), 'fixture-key-one');
});
