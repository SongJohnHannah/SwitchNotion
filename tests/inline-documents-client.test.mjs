import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { localProcessedAttachment, adaptInlineDocuments, assetName } = require('../src/compat/inline-documents.cjs');
const { adaptResponse } = require('../src/compat/response.cjs');
const sample = new URL('../research/.public-assets/' + assetName, import.meta.url);
const origin = 'https://app.notion.com', url = origin + '/notion-switch-inline-document/00000000-0000-4000-8000-000000000000/' + 'a'.repeat(64);
const marker = { notionSwitchDocument: { version: 1, result: { attachmentRisk: 'skipped', contentType: 'application/pdf', fileSizeBytes: 927, numPages: 2, stepMetadata: { numPages: 2 } } } };

test('local metadata rejects malformed results and ordinary server responses keep their task subscriber', () => {
  assert.equal(localProcessedAttachment(() => assert.fail('No native imports for ordinary response'), { type: 'success', data: { outputKey: 'server-task' } }), undefined);
  assert.throws(() => localProcessedAttachment(() => assert.fail('No imports for invalid metadata'), { type: 'success', data: { notionSwitchDocument: { version: 1, result: { ...marker.notionSwitchDocument.result, numPages: 0 } } } }), /回执无效/);
  assert.throws(() => adaptInlineDocuments('"use strict";changed();', assetName), /Unreviewed/);
});

test('reviewed native consumer completes local metadata without opening a hosted task and leaves images unchanged', { skip: !fs.existsSync(sample) && 'Reviewed attachment frontend sample is not installed' }, async () => {
  const source = fs.readFileSync(sample, 'utf8'), output = adaptInlineDocuments(source, assetName);
  new vm.Script(output); assert.throws(() => adaptInlineDocuments(source + '\n', assetName), /Unreviewed/);
  const begin = output.indexOf('async function c(e)'), end = output.indexOf('},209468(', begin);
  assert.ok(begin > 0 && end > begin);
  let subscriptions = 0, received;
  const nativeRequire = value => {
    if (value === 917398) return { tX: args => ({ originalFileUrl: args.originalFileUrl, fileName: args.fileName, contentType: args.result.contentType, metadata: args.result.stepMetadata }) };
    if (value === 80279) return { Q: { success: data => ({ success: true, data }), fail: data => ({ success: false, data }) } };
    if (value === 655696) return { cK: async () => { subscriptions++; return { value: { result: { type: 'success', data: marker.notionSwitchDocument.result } } }; }, W$: () => true };
    if (value === 324497) return { A: error => ({ message: error.message }) };
    assert.fail('Unexpected native import ' + value);
  };
  const run = vm.runInNewContext('(' + output.slice(begin, end) + ')', { a: nativeRequire, l: {}, n: 'user_upload', URL, location: { origin } });
  const environment = { api: { callCellCompatibleApi: async request => { received = request; return { type: 'success', data: request.data.url === url ? marker : { outputKey: 'ordinary-task', spaceId: 'synthetic-space' } }; } } };
  const args = { environment, taskArgs: { url }, fileName: '合成 PDF.pdf', originalFileUrl: url, threadPointer: { id: 'synthetic-thread' } };
  const local = await run(args); assert.equal(local.success, true); assert.equal(local.data.fileName, '合成 PDF.pdf'); assert.equal(local.data.metadata.numPages, 2);
  assert.equal(received.headers['x-notion-switch-inline-documents-client'], '1'); assert.equal(subscriptions, 0);
  const image = await run({ ...args, taskArgs: { url: 'https://file.notion.so/f/f/image.png' } });
  assert.equal(image.success, true); assert.equal(received.headers, undefined); assert.equal(subscriptions, 1);
});

test('the response adapter recognizes the attachment asset and does not initialize recording services', { skip: !fs.existsSync(sample) && 'Reviewed attachment frontend sample is not installed' }, async () => {
  const source = fs.readFileSync(sample, 'utf8');
  const result = await adaptResponse(new Response(source, { headers: { 'content-length': String(Buffer.byteLength(source)), etag: 'synthetic' } }), assetName, { prepare: () => assert.fail('No recording preparation for local documents') });
  assert.equal(result.changed, true); assert.deepEqual(result.kinds, ['attachments']); assert.equal(result.response.headers.get('etag'), null);
  await assert.rejects(adaptResponse(new Response(source.replace('processAgentAttachment', 'processChangedAttachment')), assetName), error => error.notionSwitchKind === 'attachments');
});
