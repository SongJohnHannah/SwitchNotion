import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSources, explicitUrls } = require('../src/web-sources.cjs');
const { createPublicFetcher, publicUrl, publicAddress, requestOnce } = require('../src/web-fetch.cjs');
const { extractContent } = require('../src/web-content.cjs');
const { parseDocument } = require('../src/web-parser.cjs');
const { SettingsService } = require('../src/settings-service.cjs');
const id = n => 'ad00aa00-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
const content = [{ type: 'text', text: '请核对 https://example.com/article 的公开内容。' }];
function fixture(t, fetchPublic) {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-web-'));
  const sources = new WebSources({ root, fetchPublic, now: () => 1793155200000 });
  t.after(() => { sources.close(); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, sources, open: extra => sources.open({ userId: id(1), spaceId: id(2), content, ...extra }) };
}
const html = text => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from('<title>合成网页</title><main>' + text + '</main>'), url: 'https://example.com/article', redirects: [] });

test('research web sessions require an internal purpose plus an audited native config and honor both switches', async t => {
  let reads = 0; const f = fixture(t, async () => { reads++; return html('纯内存研究样例'); });
  const request = { purpose: 'research', input: { type: 'workflow', isAgentResearchRequest: true, useWebSearch: true } };
  assert.equal(await f.open(request), null); f.sources.save({ enabled: 'enabled' });
  assert.equal(await f.open({ ...request, purpose: undefined }), null);
  assert.equal(await f.open({ ...request, input: { type: 'workflow' } }), null);
  assert.equal(await f.open({ ...request, input: { type: 'calendar_agent' } }), null);
  assert.equal(await f.open({ ...request, input: { ...request.input, useWebSearch: false } }), null);
  for (const input of [request.input, { type: 'researcher', useWebSearch: true }]) {
    const session = await f.open({ ...request, input });
    assert.match((await session.execute('read_web_page', { url: 'https://example.com/article' })).text, /纯内存研究样例/); session.close();
  }
  assert.equal(reads, 2); assert.equal(f.sources.sessions.size, 0);
});

test('public URL and address validation rejects local aliases, reserved ranges, credentials, schemes and ports', () => {
  for (const url of ['file:///tmp/a', 'data:text/plain,x', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://10.1.2.3/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/', 'http://100.64.0.1/', 'https://user:password@example.com/', 'https://example.com:3000/',
    'https://localhost./', 'https://a.local/', 'https://a.home.arpa/', 'https://a.internal/', 'http://203.0.113.1/', 'https://example.com\\@127.0.0.1/']) assert.throws(() => publicUrl(url), /Notion 联网/);
  for (const ip of ['0.0.0.0', '127.0.0.1', '224.0.0.1', '198.18.0.1', '198.51.100.1', '192.0.2.1', 'fc00::1', 'fe80::1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '2001::1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700::1111'), true);
  assert.equal(publicUrl('https://example.com:443/a#part').href, 'https://example.com/a');
});

test('DNS addresses are validated and pinned and every redirect is checked before a new request', async () => {
  const requests = [], resolved = [], fetchPublic = createPublicFetcher({ lookup: async host => { resolved.push(host); return [{ address: host === 'private.example' ? '127.0.0.1' : '8.8.8.8', family: 4 }]; },
    transport: async (url, options) => { requests.push({ url: url.href, options }); return requests.length === 1 ? { status: 302, headers: { location: 'https://private.example/secret' } } : html('must not fetch'); } });
  await assert.rejects(fetchPublic('https://example.com/start'), /内网|本机/); assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].options.addresses, [{ address: '8.8.8.8', family: 4 }]); assert.deepEqual(resolved, ['example.com', 'private.example']);
  let connected = 0;
  const mixed = createPublicFetcher({ lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }], transport: async () => { connected++; } });
  await assert.rejects(mixed('https://example.com/'), /内网|本机/); assert.equal(connected, 0);
});

test('redirect loops and credential headers cannot be used to send the search key to another host', async () => {
  const fetched = [], fetchPublic = createPublicFetcher({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], transport: async (url, options) => {
    fetched.push(options.headers); return { status: 302, headers: { location: url.href } };
  } });
  await assert.rejects(fetchPublic('https://example.com/'), /重复跳转/);
  await assert.rejects(fetchPublic('https://example.com/', { headers: { cookie: 'must-not-send' } }), /请求头/);
  await assert.rejects(fetchPublic('https://example.com/', { headers: { 'x-subscription-token': 'synthetic-key' }, redirect: false }), /请求头/);
  await assert.rejects(fetchPublic('https://api.search.brave.com/', { headers: { 'x-subscription-token': 'synthetic-key' }, redirect: false }), /HTTP 302/);
  assert.equal(fetched.length, 2); assert.ok(fetched.every(value => !value.cookie && !value.authorization));
});

test('stopping while DNS is pending prevents the transport from starting', async () => {
  let resolveLookup, connected = 0;
  const fetchPublic = createPublicFetcher({ lookup: () => new Promise(resolve => { resolveLookup = resolve; }), transport: async () => { connected++; } });
  const controller = new AbortController(), result = fetchPublic('https://example.com/', { signal: controller.signal });
  controller.abort(Error('synthetic-stop')); await assert.rejects(result, /synthetic-stop/);
  resolveLookup([{ address: '8.8.8.8', family: 4 }]); await Promise.resolve(); assert.equal(connected, 0);
});

test('the actual HTTP transport pins DNS, decodes gzip, limits the decoded response and aborts pending bodies', async t => {
  const server = http.createServer((request, response) => {
    assert.match(request.headers.host, /^fixture\.example:/); assert.equal(request.headers.cookie, undefined);
    if (request.url === '/pending') { response.writeHead(200, { 'content-type': 'text/plain' }); response.write('waiting'); return; }
    response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); response.end(gzipSync('合成网页'.repeat(2000)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const options = { addresses: [{ address: '127.0.0.1', family: 4 }], headers: {}, signal: AbortSignal.timeout(2000), limit: 50000 };
  const base = 'http://fixture.example:' + server.address().port;
  const response = await requestOnce(new URL(base + '/small'), options); assert.equal(response.body.toString('utf8'), '合成网页'.repeat(2000));
  await assert.rejects(requestOnce(new URL(base + '/large'), { ...options, limit: 100 }), /大小/);
  const controller = new AbortController(), pending = requestOnce(new URL(base + '/pending'), { ...options, signal: controller.signal });
  setTimeout(() => controller.abort(Error('synthetic-stop')), 10); await assert.rejects(pending, /synthetic-stop|abort/i);
});

test('HTML extraction uses a real parser, preserves text/table order and never executes scripts or follows links', () => {
  const value = extractContent(Buffer.from('<title>标题 &amp; 引用</title><nav>导航</nav><main><h1>项目</h1><script>throw Error("must not run")</script><div hidden>隐藏资料</div><div style="display:none">隐藏样式</div><p>第一段 <b>粗体</b> &lt;literal&gt;</p><table><tr><th>名称</th><th>值</th></tr><tr><td>青色</td><td>927</td></tr></table><a href="http://127.0.0.1/">普通链接</a></main><footer>页脚</footer>'), 'text/html');
  assert.equal(value.title, '标题 & 引用'); assert.match(value.text, /项目[\s\S]*第一段 粗体 <literal>[\s\S]*名称.*值[\s\S]*青色.*927[\s\S]*普通链接/);
  assert.ok(!/隐藏|must not run|导航|页脚|127\.0/.test(value.text)); assert.equal(value.script_rendered, false);
  assert.equal(extractContent(Buffer.from([0xb2, 0xe2, 0xca, 0xd4]), 'text/plain;charset=gbk').text, '测试');
  assert.throws(() => extractContent(Buffer.from('%PDF-'), 'application/pdf'), /未解析/);
  assert.throws(() => extractContent(Buffer.from('<script>secret</script>'), 'text/html'), /未得到正文/);
});

test('document parsing runs outside the app thread and is bounded by cancellation and timeout', async () => {
  const source = Buffer.from('<main><p>独立线程合成正文927</p></main>');
  const result = await parseDocument(source, 'text/html'); assert.equal(result.text, '独立线程合成正文927');
  const controller = new AbortController(), stopped = parseDocument(source, 'text/html', { signal: controller.signal }); controller.abort(Error('synthetic-parse-stop'));
  await assert.rejects(stopped, /synthetic-parse-stop/);
  await assert.rejects(parseDocument(source, 'text/html', { timeoutMs: 1 }), /解析超时/);
  await assert.rejects(parseDocument(Buffer.alloc(2 * 1024 * 1024 + 1), 'text/html'), /输入无效|过长/);
});

test('web sources are off by default, do not need a search key for explicit pages, and respect a native turn disable', async t => {
  const f = fixture(t, async () => html('正文'));
  assert.equal(await f.open(), null); f.sources.save({ enabled: 'enabled' });
  const session = await f.open(); assert.deepEqual(session.definitions.map(value => value.function.name), ['read_web_page']);
  assert.equal((await session.execute('read_web_page', { url: 'https://example.com/article' })).text, '正文');
  assert.equal(await f.open({ input: { useWebSearch: false } }), null);
  assert.equal(await f.open({ input: { type: 'custom_agent' } }), null);
  await assert.rejects(f.open({ userId: id(1), spaceId: 'invalid' }), /账号|工作区/);
});

test('only current user URLs and rich-text links are explicit; ordinary embedded text cannot open arbitrary targets', async t => {
  const urls = explicitUrls([{ type: 'text', text: [['参考', [['a', 'https://example.com/article']]], [' 与 https://example.org/a。']] }]);
  assert.deepEqual([...urls], ['https://example.com/article', 'https://example.org/a']);
  let fetches = 0; const f = fixture(t, async () => { fetches++; return html('正文'); }); f.sources.save({ enabled: 'enabled' });
  const session = await f.open(); await assert.rejects(session.execute('read_web_page', { url: 'https://other.example/secret' }), /本轮/);
  await assert.rejects(session.execute('read_web_page', { url: 'https://example.com/article', headers: { cookie: 'secret' } }), /范围/); assert.equal(fetches, 0);
});

test('search results remain snippets, preserve source links, use real pagination flags and authorize later body reads', async t => {
  const calls = [], f = fixture(t, async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://api.search.brave.com/')) return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ query: { more_results_available: true }, web: { results: [
      { title: '<b>合成文章</b>', description: '这只是<b>搜索摘要</b>', url: 'https://public.example/article#part' },
      { title: 'duplicate', description: 'same', url: 'https://public.example/article' }, { title: 'blocked', url: 'http://127.0.0.1/' }
    ] } })) };
    return { ...html('实际合成正文'), url };
  });
  f.sources.save({ enabled: 'enabled', apiKey: 'synthetic-brave-key' }); const session = await f.open();
  const result = await session.execute('search_web', { query: '合成公开资料', freshness: 'week' });
  assert.equal(result.results.length, 1); assert.equal(result.skipped_results, 1); assert.equal(result.results[0].snippet, '这只是搜索摘要');
  assert.equal(result.results[0].body_available, false); assert.equal(result.has_more, true); assert.equal(result.next_offset, 1);
  assert.equal(new URL(calls[0].url).searchParams.get('freshness'), 'pw'); assert.equal(calls[0].options.redirect, false);
  assert.equal(calls[0].options.headers['x-subscription-token'], 'synthetic-brave-key');
  const page = await session.execute('read_web_page', { url: result.results[0].url }); assert.equal(page.text, '实际合成正文'); assert.equal(page.complete, true);
  assert.equal(calls[1].options.headers, undefined);
  const last = await session.execute('search_web', { query: '合成公开资料', offset: 9 }); assert.equal(last.has_more, false); assert.equal(last.incomplete, true);
});

test('long pages use one bounded snapshot and cannot claim completion after skipping a range', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; return html('<p>' + '青色'.repeat(11000) + '</p>'); }); f.sources.save({ enabled: 'enabled' });
  const session = await f.open(), first = await session.execute('read_web_page', { url: 'https://example.com/article', limit: 1000 });
  assert.equal(first.complete, false); assert.equal(first.has_more, true); assert.equal(first.next_offset, 1000);
  const skipped = await session.execute('read_web_page', { url: 'https://example.com/article', offset: 21000, limit: 1000 }); assert.equal(skipped.has_more, false); assert.equal(skipped.complete, false);
  let next = first.next_offset, result;
  while (next !== null) { result = await session.execute('read_web_page', { url: 'https://example.com/article', offset: next, limit: 16000 }); next = result.next_offset; }
  assert.equal(result.complete, true); assert.equal(result.revision, first.revision); assert.equal(calls, 1);
});

test('concurrent reads and redirect aliases keep one consistent page snapshot for pagination', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return html('片'.repeat(2000) + calls); });
  f.sources.save({ enabled: 'enabled' }); const session = await f.open({ content: [{ type: 'text', text: 'https://example.com/article https://example.com/alias' }] });
  const [first, same] = await Promise.all([session.execute('read_web_page', { url: 'https://example.com/article', limit: 500 }), session.execute('read_web_page', { url: 'https://example.com/article', limit: 1000 })]);
  assert.equal(calls, 1); assert.equal(first.revision, same.revision);
  const alias = await session.execute('read_web_page', { url: 'https://example.com/alias', limit: 500 }); assert.equal(alias.revision, first.revision); assert.equal(calls, 2);
  const next = await session.execute('read_web_page', { url: alias.url, offset: 1000, limit: 16000 }); assert.equal(next.complete, true); assert.equal(next.revision, first.revision);
});

test('overlong bodies, unsupported formats, malformed search output and HTTP errors are not turned into completed sources', async t => {
  const f = fixture(t, async () => html('长'.repeat(120001))); f.sources.save({ enabled: 'enabled' }); const session = await f.open();
  const result = await session.execute('read_web_page', { url: 'https://example.com/article', limit: 16000 }); assert.equal(result.source_truncated, true); assert.equal(result.complete, false);
  const bad = fixture(t, async () => ({ body: Buffer.from('upstream private body must not appear'), headers: { 'content-type': 'application/json' } }));
  bad.sources.save({ enabled: 'enabled', apiKey: 'synthetic-brave-key' }); const other = await bad.open();
  await assert.rejects(other.execute('search_web', { query: 'synthetic' }), error => !error.message.includes('upstream private body'));
  await assert.rejects(other.execute('search_web', { query: 'synthetic', offset: -1 }), /分页/);
});

test('settings changes cancel in-flight reads and old sessions cannot keep using a removed search key', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async (_url, { signal }) => { await pending; signal.throwIfAborted(); return html('不应进入模型'); });
  f.sources.save({ enabled: 'enabled', apiKey: 'synthetic-brave-key' }); const session = await f.open();
  const read = session.execute('read_web_page', { url: 'https://example.com/article' });
  f.sources.save({ enabled: 'disabled', forgetKey: 'enabled' }); assert.equal(session.signal.aborted, true); release();
  await assert.rejects(read, /设置已改变/); assert.equal(f.sources.state().keyConfigured, false);
  await assert.rejects(session.execute('search_web', { query: 'synthetic' }), /设置已改变/);
});

test('account/workspace sessions keep separate explicit URL catalogs and close releases their transient body cache', async t => {
  const f = fixture(t, async url => ({ ...html('合成正文'), url })); f.sources.save({ enabled: 'enabled' });
  const first = await f.open(), other = await f.open({ userId: id(9), spaceId: id(10), content: [{ type: 'text', text: 'hello' }] });
  await first.execute('read_web_page', { url: 'https://example.com/article' });
  await assert.rejects(other.execute('read_web_page', { url: 'https://example.com/article' }), /本轮/);
  const foreignProof = await f.open({ userId: id(9), spaceId: id(10), content: [], priorSources: { userId: id(1), spaceId: id(2), urls: first.authorizedUrls() } });
  await assert.rejects(foreignProof.execute('read_web_page', { url: 'https://example.com/article' }), /本轮/); foreignProof.close();
  first.close(); assert.equal(f.sources.sessions.size, 1); await assert.rejects(first.execute('read_web_page', { url: 'https://example.com/article' }));
});

test('settings IPC methods keep search keys private, preserve an empty key field and test only a fixed synthetic query', async t => {
  const calls = [], f = fixture(t, async (url, options) => { calls.push({ url, options }); return { body: Buffer.from('{"query":{"more_results_available":false}}') }; });
  const service = new SettingsService({ root: f.root, webSources: f.sources });
  let result = await service.request('web.save', { enabled: 'enabled', apiKey: 'synthetic-brave-key' }); assert.equal(result.ok, true);
  result = await service.request('web.save', { enabled: 'enabled', apiKey: '' }); assert.equal(result.result.keyConfigured, true);
  assert.ok(!JSON.stringify(await service.request('state')).includes('synthetic-brave-key')); assert.equal(calls.length, 0);
  assert.equal((await service.request('web.test', {})).ok, true); assert.match(calls[0].url, /NotionSwitch%20connection%20test/);
  assert.equal((await service.request('web.save', { enabled: 'enabled', url: 'http://127.0.0.1/' })).ok, false);
  fs.writeFileSync(f.sources.file, '{bad JSON'); const before = fs.readFileSync(f.sources.file, 'utf8');
  assert.equal(f.sources.state().available, false); assert.equal((await service.request('web.save', { enabled: 'disabled' })).ok, false); assert.equal(fs.readFileSync(f.sources.file, 'utf8'), before);
});
