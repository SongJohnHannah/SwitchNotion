import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { MacGeneratedFiles, downloadScript } from '../src/compat/macos-generated-files.cjs';

const scope = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', spaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-generated-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new MacGeneratedFiles({ root });
}
test('Mac download links avoid native page IDs and retain file headers, content and old history links', async t => {
  const files = fixture(t), result = await files.open(scope).execute('create_downloadable_file', { filename: '合成927.txt', text: '合成927' });
  const url = new URL(result.download_url);
  assert.equal(url.origin, 'https://app.notion.com');
  assert.match(url.pathname, /^\/notion-switch-generated\/mac\//);
  assert.doesNotMatch(url.pathname, /[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/i);
  const response = files.serve(new Request(url, { headers: { 'x-notion-active-user-header': scope.userId, 'x-notion-space-id': scope.spaceId } }));
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.equal(await response.text(), '合成927');
  const metadata = JSON.parse(fs.readFileSync(path.join(files.directory, fs.readdirSync(files.directory).find(name => name.endsWith('.json')))));
  const previous = new URL('/notion-switch-generated/' + metadata.id + '/' + metadata.token, url.origin);
  assert.equal(await files.serve(new Request(previous)).text(), '合成927');
});
test('Mac URL encoding cannot bypass token, account, workspace, request method or cross-site checks', async t => {
  const files = fixture(t), { download_url: url } = await files.open(scope).execute('create_downloadable_file', { filename: 'synthetic.txt', text: '927' });
  for (const headers of [{ 'x-notion-active-user-header': scope.spaceId }, { 'x-notion-space-id': scope.userId }, { 'sec-fetch-site': 'cross-site' }]) assert.equal(files.serve(new Request(url, { headers })).status, 404);
  assert.equal(files.serve(new Request(url, { method: 'POST' })).status, 404);
  const changed = new URL(url); changed.pathname = changed.pathname.replace(/.$/, changed.pathname.endsWith('A') ? 'B' : 'A');
  assert.equal(files.serve(new Request(changed)).status, 404);
  assert.equal(files.serve(new Request(url.replace('/mac/', '/mac/../mac/invalid/'))).status, 404);
});
test('Mac click routing downloads only generated capabilities and leaves Notion and external links alone', async t => {
  const files = fixture(t), { download_url: url } = await files.open(scope).execute('create_downloadable_file', { filename: 'synthetic.txt', text: '927' });
  let click, installs = 0, downloads = 0, fetched = 0;
  const download = { click() { downloads++; } };
  class BlobURL extends URL { static createObjectURL() { return 'blob:synthetic-file'; } static revokeObjectURL(value) { assert.equal(value, 'blob:synthetic-file'); } }
  const context = vm.createContext({ URL: BlobURL, location: { origin: 'https://app.notion.com', href: 'https://app.notion.com/chat' },
    document: { createElement: () => download }, setTimeout: run => run(),
    fetch: async (href, options) => { fetched++; assert.equal(href, url); assert.equal(options.credentials, 'same-origin'); return new Response('927', { headers: { 'content-disposition': "attachment; filename*=UTF-8''synthetic.txt" } }); },
    window: { addEventListener(name, fn, capture) { assert.equal(name, 'click'); assert.equal(capture, true); click = fn; installs++; } } });
  vm.runInContext(downloadScript, context); vm.runInContext(downloadScript, context); assert.equal(installs, 1);
  for (const [href, expected] of [[url, true], [url.replace('app.notion.com', 'example.com'), false], [url + '?extra=1', false], [url + '#extra', false], ['https://app.notion.com/' + scope.userId, false]]) {
    const anchor = { href, dataset: {} }; let stopped = false, prevented = false;
    await click({ target: { closest: () => anchor }, stopImmediatePropagation() { stopped = true; }, preventDefault() { prevented = true; } });
    assert.equal(stopped, expected);
    assert.equal(prevented, expected);
    assert.equal(anchor.dataset.notionSwitchDownloading, undefined);
  }
  assert.equal(fetched, 1); assert.equal(downloads, 1); assert.equal(download.download, 'synthetic.txt');
});
