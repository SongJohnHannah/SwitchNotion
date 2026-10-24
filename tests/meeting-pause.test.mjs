import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import summary from '../src/speech/summary.cjs';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../src/desktop-hook.cjs', import.meta.url), 'utf8');
const routeSource = source.slice(source.indexOf('async function route('), source.indexOf('\nfunction install(ses)'));
function routeFixture() {
  const log = [], forwarded = [];
  const context = {
    Request, Response, Headers, URL, require, console,
    ...summary,
    settings: { speech: { enabled: true } }, nativeSpeech: { enabled: true, endpoint: 'http://127.0.0.1:32123' },
    log: e => log.push(e), isNotion: host => host === 'app.notion.com',
    json: (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }),
    endpoints: new Set(['runInferenceTranscript']), provider: { status: () => ({ mode: 'deepseek' }) }
  };
  const route = vm.runInNewContext(routeSource + '\nroute', context);
  const run = (endpoint, input) => route(new Request('https://app.notion.com/api/v3/' + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
  }), async request => { forwarded.push(request.url); return new Response('{}'); });
  return { run, log, forwarded, context };
}

test('pausing offline recording does not turn a completed transcript into an HTTP 503 at automatic summary', async () => {
  const f = routeFixture();
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

test('legacy automatic summary also ends normally, while writer and disabled-mode requests keep their original route', async () => {
  const f = routeFixture();
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
