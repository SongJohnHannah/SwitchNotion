import fs from 'node:fs';
import path from 'node:path';
import storeModule from '../../src/meeting-summary-store.cjs';
export const ids = { space: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', meeting: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  summary: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', transcript: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  notes: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', user: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  transcriptText: '11111111-1111-4111-8111-111111111111', noteText: '22222222-2222-4222-8222-222222222222' };
export function meetingFixture(t) {
  const parent = path.resolve('.notion-switch'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-meeting-summary-'));
  t.after(() => { assertRoot(); fs.rmSync(root, { recursive: true, force: true }); });
  function assertRoot() { if (path.dirname(root) !== parent) throw Error('Invalid fixture cleanup'); }
  const block = (id, parentId, extra = {}) => ({ id, space_id: ids.space, version: 1, type: 'text', alive: true,
    parent_id: parentId, parent_table: 'block', ...extra });
  const records = new Map([
    [ids.meeting, block(ids.meeting, '33333333-3333-4333-8333-333333333333', { type: 'transcription', content: [ids.notes, ids.transcript],
      format: { transcription_notes_id: ids.notes, transcription_transcript_id: ids.transcript } })],
    [ids.notes, block(ids.notes, ids.meeting, { content: [ids.noteText] })],
    [ids.transcript, block(ids.transcript, ids.meeting, { content: [ids.transcriptText] })],
    [ids.noteText, block(ids.noteText, ids.notes, { properties: { title: [['User handwritten note: verify the dates.']] } })],
    [ids.transcriptText, block(ids.transcriptText, ids.transcript, { properties: { title: [['This is a recorded story, not a business meeting.']] } })]
  ]);
  const calls = [], generations = []; let role = 'editor', writeBehavior = 'ok';
  const api = async (endpoint, payload, options = {}) => {
    calls.push({ endpoint, payload: structuredClone(payload) });
    if (endpoint === 'getRecordValues') {
      if (payload.requests.some(p => p.spaceId !== ids.space) || options.spaceId !== ids.space) throw Error('Native record pointers must include the workspace, including for newly allocated IDs');
      return { results: payload.requests.map(p => records.has(p.id) ? { role, value: structuredClone(records.get(p.id)) } : {}) };
    }
    if (endpoint !== 'saveTransactionsFanout') throw Error('Unexpected native API');
    if (writeBehavior === 'validation-error') throw Object.assign(Error('Fixture schema rejection before a mutation'), { notSubmitted: true });
    if (writeBehavior === 'before-commit-error') throw Error('Fixture unknown transport failure');
    for (const transaction of payload.transactions) for (const op of transaction.operations) {
      if (op.command === 'set') records.set(op.pointer.id, structuredClone(op.args));
      else {
        const value = records.get(op.pointer.id);
        if (op.command === 'update') Object.assign(value[op.path[0]], op.args);
        else if (op.command === 'listAfter') { const list = value[op.path[0]] ||= []; list.splice(op.args.after ? list.indexOf(op.args.after) + 1 : list.length, 0, op.args.id); }
        else throw Error('Unexpected native operation');
        value.version++;
      }
    }
    if (writeBehavior === 'after-commit-error') throw Error('Fixture lost response after a committed transaction');
    return { recordMap: {} };
  };
  const store = new storeModule.NativeMeetingStore({ api, spaceId: ids.space, userId: ids.user });
  const provider = { config: () => ({ mode: 'deepseek', model: 'fixture', maxTokens: 4096 }),
    async* generate(args) { generations.push(args); yield '# Story notes\n\nThe recording describes a story.\n- Verify unclear names and dates.'; } };
  const input = { spaceId: ids.space, transcriptionBlockId: ids.meeting, summaryTabId: ids.summary, language: 'zh-CN' };
  return { root, records, calls, generations, store, provider, input,
    writes: () => calls.filter(c => c.endpoint === 'saveTransactionsFanout'),
    setRole: value => { role = value; }, setWriteBehavior: value => { writeBehavior = value; } };
}
