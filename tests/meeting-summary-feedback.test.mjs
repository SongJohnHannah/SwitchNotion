import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { MeetingSummaryService } from '../src/meeting-summary.cjs';
import { meetingFixture, ids } from './helpers/native-meeting.mjs';

const legacyInput = { spaceId: ids.space, transcript: [{ type: 'config', value: {
  type: 'summarize-transcript', transcriptPointer: { id: ids.meeting, spaceId: ids.space }, summaryTabId: ids.summary
} }] };
const events = async response => (await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);
const service = f => new MeetingSummaryService({ root: f.root, provider: f.provider, storeFactory: () => f.store });

for (const endpoint of ['runMeetingNotesAgent', 'runInferenceTranscript']) {
  test(`${endpoint}: a failed summary notifies the native meeting UI before terminating the stream`, async t => {
    const f = meetingFixture(t), before = structuredClone([...f.records]);
    f.provider.generate = async function* () { throw Error('Private upstream failure'); };
    const result = await events(service(f).handle(endpoint, endpoint === 'runMeetingNotesAgent' ? f.input : legacyInput));
    const notice = result.findIndex(event => event.type === 'summarize-transcript-error');
    const terminal = result.findIndex(event => event.type === 'error');
    assert.ok(notice >= 0 && notice < terminal,
      'Native stream helpers consume generic errors before onResponse: the meeting UI needs its own failure event first');
    assert.match(result[notice].message, /失败/);
    assert.equal(JSON.stringify(result).includes('Private upstream failure'), false);
    assert.equal(result.some(event => event.type === 'record-map' || event.status === 'completed'), false);
    assert.equal(f.writes().length, 0);
    assert.deepEqual([...f.records], before);
  });
  test(`${endpoint}: invalid summary parameters also reach the meeting failure callback`, async t => {
    const f = meetingFixture(t);
    const result = await events(service(f).handle(endpoint, {}));
    assert.deepEqual(result.map(event => event.type), ['summarize-transcript-error', 'error']);
    assert.equal(f.generations.length, 0);
    assert.equal(f.writes().length, 0);
  });
}

test('cancelling a summary does not display a failure notice or completion', async t => {
  const f = meetingFixture(t), abort = new AbortController();
  f.provider.generate = async function* () { abort.abort(); yield 'Cancelled draft'; };
  const result = await events(service(f).handle('runMeetingNotesAgent', f.input, abort.signal));
  assert.equal(result.some(event => ['error', 'summarize-transcript-error', 'record-map'].includes(event.type) || event.status === 'completed'), false);
  assert.equal(f.writes().length, 0);
});

test('a successful retry clears the previous summary error and emits only verified completion', async t => {
  const f = meetingFixture(t), s = service(f), generate = f.provider.generate;
  f.provider.generate = async function* () { throw Error('Temporary fixture failure'); };
  await events(s.handle('runMeetingNotesAgent', f.input));
  assert.ok(s.status().lastError);
  f.provider.generate = generate;
  const result = await events(s.handle('runMeetingNotesAgent', f.input));
  assert.equal(s.status().lastError, '', 'A recovered meeting must not retain its old failure status');
  assert.ok(result.some(event => event.status === 'completed' && event.verified));
  assert.equal(result.some(event => event.type === 'error' || event.type === 'summarize-transcript-error'), false);
});

// Exercise the actual native stream helper and meeting callback when the
// reviewed third-party client is available locally; it is not redistributed.
const asset = new URL('../research/.public-assets/89269-cbd3af4d28334ce0.js', import.meta.url);
test('the reviewed native meeting consumer shows a failure notice instead of leaving the empty Notes placeholder silently',
  fs.existsSync(asset) ? {} : { skip: 'Reviewed third-party Notion asset is not distributed with the source.' }, async t => {
    const source = fs.readFileSync(asset, 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), 'a4701622a9c21f45a31a575d9c4eb895585d5f1a2da88b85435bde4088e10334');
    const helperStart = source.indexOf('async function o(e){let{environment:t,onResponse:r,data:o,abortSignal:n}');
    const helperEnd = source.indexOf('function n(e)', helperStart);
    const callbackStart = source.indexOf('S=e=>{var t,r,o,s;if("summarize-transcript-error"===e.type)');
    const callbackEnd = source.indexOf('};if((0,i(167322).Kw)(t))', callbackStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart && callbackStart >= 0 && callbackEnd > callbackStart);
    const notices = [], maps = []; let cleanup = 0;
    const modules = {
      115118: { WS: () => ({}) }, 102795: { hS: { is: () => true } },
      436555: { D6: notice => notices.push(notice) }, 962299: { A: { formatMessage: message => message } },
      769719: { c: { getTabState: () => 'notes', getIsFinishingTranscription: () => false } },
      276162: { y1: () => null, QA: () => null }
    };
    const context = vm.createContext({ i: id => {
      assert.ok(modules[id], `Unexpected native dependency ${id}`); return modules[id];
    }, a: () => { cleanup++; }, p: false, n: false, l: { genericError: '会议摘要生成失败，请重试。' },
    d: { id: ids.meeting }, g: map => maps.push(map) });
    const consume = vm.runInContext('(' + source.slice(helperStart, helperEnd) + ')', context);
    const onResponse = vm.runInContext('(' + source.slice(callbackStart + 2, callbackEnd + 1) + ')', context);
    const f = meetingFixture(t);
    f.provider.generate = async function* () { throw Error('Synthetic model outage'); };
    const response = service(f).handle('runMeetingNotesAgent', f.input);
    const result = await consume({ data: f.input, onResponse, environment: { api: { async callStreamApi() {
      return { type: 'success', data: (async function* () { yield* await events(response); })() };
    } } } });
    assert.ok(result.error, 'The native stream must still terminate as a failure');
    assert.equal(notices.length, 1, 'The generic error alone is swallowed before the native UI callback');
    assert.equal(cleanup, 1, 'Dismiss the native summary preparation indicator');
    assert.equal(context.p, true);
    assert.equal(maps.length, 0);
  });
