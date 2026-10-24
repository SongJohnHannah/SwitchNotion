import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { NotionWorkspace } = require('../src/notion-tools.cjs');
const { NotionRouter } = require('../src/notion-routing.cjs'), { runAgent } = require('../src/agent-runtime.cjs');
const P = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const paragraph = { type: 'paragraph', paragraph: { rich_text: [] } };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture(t, failure = 'validation') {
  const parent = path.resolve('.notion-switch'), root = fs.mkdtempSync(path.join(parent, 'test-write-rejection-'));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  let deletes = 0, verificationFails = false;
  const block = { object: 'block', id: B, ...paragraph, parent: { page_id: P }, has_children: false, in_trash: false };
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/users/me')) return json({ type: 'bot', bot: { workspace_id: P, workspace_name: 'fixture' } });
    if (options.method === 'PATCH' && failure === 'network') throw Error('synthetic network loss');
    if (options.method === 'PATCH' && failure === 'verify_validation') { verificationFails = true; return json({ results: [block], has_more: false }); }
    if (options.method === 'GET' && verificationFails) { verificationFails = false; return new Response(JSON.stringify({ code: 'validation_error' }), { status: 400 }); }
    if (options.method === 'PATCH' && failure === 'unclassified') return new Response(JSON.stringify({ code: 'unknown_error', message: 'fixture private body' }), { status: 400 });
    if (options.method === 'PATCH') return new Response(JSON.stringify({ object: 'error', status: 400, code: 'validation_error', message: 'body.position should be defined, instead was undefined.' }), { status: 400 });
    if (options.method === 'DELETE') { deletes++; block.in_trash = true; }
    return json(block);
  };
  const workspace = new NotionWorkspace({ root, intervalMs: 0, profile: { apiKey: 'fixture-key' }, fetchImpl });
  fs.writeFileSync(path.join(root, 'notion-connections.local.json'), JSON.stringify({ version: 2, connections: [{ apiKey: 'fixture-key', workspaceId: P }] }));
  return { root, workspace, router: new NotionRouter({ root, intervalMs: 0, fetchImpl }), deletes: () => deletes };
}
test('a definite API validation rejection does not lock unrelated writes after reading the target again', async t => {
  const f = fixture(t), session = f.workspace.open({ signal: new AbortController().signal });
  await assert.rejects(session.execute('append_blocks', { block_id: P, blocks: [paragraph] }), /400/);
  const read = await session.execute('read_block', { block_id: B });
  const deleted = await session.execute('trash_block', { block_id: B, block_revision: read.block_revision });
  assert.equal(deleted.verified, true); assert.equal(f.deletes(), 1);
});

test('Agent and cross-workspace guards preserve definite rejection metadata and allow a different authorized edit', async t => {
  const f = fixture(t); let round = 0, checkpoint;
  const call = (name, args) => ({ id: 'call-' + round, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const provider = { async* generate({ onToolCalls, messages }) {
    round++;
    if (round === 1) onToolCalls([call('append_blocks', { block_id: P, blocks: [paragraph] })]);
    else if (round === 2) onToolCalls([call('read_block', { block_id: B })]);
    else if (round === 3) {
      const read = JSON.parse(messages.filter(m => m.role === 'tool').at(-1).content);
      onToolCalls([call('trash_block', { block_id: B, block_revision: read.block_revision })]);
    } else yield 'finished';
  } };
  await runAgent({ provider, config: { multiAgent: false }, workspace: f.router, nativeContext: { workspace_id: P, page_id: P }, operationScope: 'fixture', signal: new AbortController().signal,
    messages: [{ role: 'system', content: '' }, { role: 'user', content: '合成任务：重排，并删除指定空段落。' }], onText: () => {}, onCheckpoint: value => { checkpoint = value; } });
  assert.equal(f.deletes(), 1); assert.equal(checkpoint.uncertainWrite, false);
  assert.equal(checkpoint.receipts[0].uncertain, false); assert.equal(checkpoint.receipts.at(-1).verified, true);
});

test('network failures still lock subsequent writes while reads remain available', async t => {
  const f = fixture(t, 'network'), session = f.workspace.open({ signal: new AbortController().signal });
  await assert.rejects(session.execute('append_blocks', { block_id: P, blocks: [paragraph] }), /连接失败/);
  const read = await session.execute('read_block', { block_id: B });
  await assert.rejects(session.execute('trash_block', { block_id: B, block_revision: read.block_revision }), /停止后续写入/);
  assert.equal(f.deletes(), 0);
});

test('local block validation failures are not treated as submitted writes by Agent', async t => {
  const f = fixture(t), session = f.workspace.open({ signal: new AbortController().signal });
  await assert.rejects(session.execute('append_blocks', { block_id: P, blocks: [{ type: 'unsupported' }] }), error => error.writeOutcome === 'not_submitted');
  const read = await session.execute('read_block', { block_id: B });
  assert.equal((await session.execute('trash_block', { block_id: B, block_revision: read.block_revision })).verified, true);
});

test('a validation failure in readback after submission still locks further writes', async t => {
  const f = fixture(t, 'verify_validation'), session = f.workspace.open({ signal: new AbortController().signal });
  await assert.rejects(session.execute('append_blocks', { block_id: P, blocks: [paragraph] }), error => error.writeOutcome === 'uncertain');
  const read = await session.execute('read_block', { block_id: B });
  await assert.rejects(session.execute('trash_block', { block_id: B, block_revision: read.block_revision }), /停止后续写入/);
  assert.equal(f.deletes(), 0);
});

test('an undocumented HTTP 400 is kept uncertain and never exposes the private upstream body', async t => {
  const f = fixture(t, 'unclassified'), session = f.workspace.open({ signal: new AbortController().signal });
  await assert.rejects(session.execute('append_blocks', { block_id: P, blocks: [paragraph] }), error => error.writeOutcome === 'uncertain' && !error.message.includes('fixture private body'));
  const read = await session.execute('read_block', { block_id: B });
  await assert.rejects(session.execute('trash_block', { block_id: B, block_revision: read.block_revision }), /停止后续写入/);
});
