import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import summary from '../src/speech/summary.cjs';
import serviceModule from '../src/meeting-summary.cjs';
import { meetingFixture, ids } from './helpers/native-meeting.mjs';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../src/desktop-hook.cjs', import.meta.url), 'utf8');
const routeSource = source.slice(source.indexOf('async function route('), source.indexOf('\nfunction install(ses)'));
function routeFixture(t) {
  const fixture = meetingFixture(t);
  const log = [], forwarded = [];
  const context = {
    Request, Response, Headers, URL, require, console,
    ...summary,
    settings: { speech: { enabled: true, autoSummary: false } }, nativeSpeech: { enabled: true, endpoint: 'http://127.0.0.1:32123' },
    meetingBridge: { observe() {} }, recordings: { wake() {} },
    meetingSummaries: new serviceModule.MeetingSummaryService({ root: fixture.root, provider: fixture.provider, storeFactory: () => fixture.store }),
    log: e => log.push(e), isNotion: host => host === 'app.notion.com',
    json: (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }),
    endpoints: new Set(['runInferenceTranscript']), provider: { status: () => ({ mode: 'deepseek' }) }
  };
  const route = vm.runInNewContext(routeSource + '\nroute', context);
  const run = (endpoint, input) => route(new Request('https://app.notion.com/api/v3/' + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
  }), async request => { forwarded.push(request.url); return new Response('{}'); });
  return { run, log, forwarded, context, fixture };
}

test('pausing offline recording does not turn a completed transcript into an HTTP 503 at automatic summary', async t => {
  const f = routeFixture(t);
  const response = await f.run('runMeetingNotesAgent', {
    spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    transcriptionBlockId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', from: 'stop_transcription'
  });
  assert.equal(response.status, 200, 'Pause must not report HTTP 503 after a successful local transcription drain');
  assert.equal(f.forwarded.length, 0, 'Do not forward the meeting to Notion AI');
  assert.match(response.headers.get('content-type'), /ndjson/);
  const result = JSON.parse(await response.text());
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'offline-transcription-only');
  assert.equal(f.log[0].type, 'offline-meeting-summary-skipped');
});

test('legacy automatic summary also ends normally, while writer and disabled-mode requests keep their original route', async t => {
  const f = routeFixture(t);
  const legacy = await f.run('runInferenceTranscript', { transcript: [{ type: 'config', value: { type: 'summarize-transcript' } }] });
  assert.equal(legacy.status, 200); assert.equal(JSON.parse(await legacy.text()).status, 'skipped');
  let writer = 0;
  f.context.createNativeImageAdapter = () => ({});
  f.context.mock = { status: () => ({ activeTurns: 0 }), handle: async () => { writer++; return new Response('{}'); } };
  f.context.settings.isLoginSyncing = () => false;
  const ordinary = await f.run('runInferenceTranscript', { transcript: [{ type: 'config', value: { type: 'writer' } }] });
  assert.equal(ordinary.status, 200); assert.equal(writer, 1);
  f.context.settings.speech.enabled = false;
  await f.run('runMeetingNotesAgent', {});
  assert.equal(f.forwarded.length, 1);
});

test('enabled DeepSeek meeting notes populate the native Summary tab instead of acknowledging an empty skipped summary', async t => {
  const f = routeFixture(t); f.context.settings.speech.autoSummary = true;
  const response = await f.run('runMeetingNotesAgent', {
    spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', transcriptionBlockId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    summaryTabId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', language: 'zh-CN', from: 'stop_transcription'
  });
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === 'record-map' && event.recordMap?.block),
    'Native summary stays empty unless the stream contains persisted summary records');
  assert.equal(f.fixture.records.get(ids.meeting).format.transcription_summary_id, ids.summary);
  assert.equal(f.fixture.records.get(ids.noteText).properties.title[0][0], 'User handwritten note: verify the dates.');
  assert.equal(f.fixture.records.get(ids.transcriptText).properties.title[0][0], 'This is a recorded story, not a business meeting.');
  assert.equal(f.fixture.writes().length, 1);
});
