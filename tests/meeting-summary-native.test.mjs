import test from 'node:test';
import assert from 'node:assert/strict';
import { MeetingNativeBridge } from '../src/meeting-summary-native.cjs';
import { ids } from './helpers/native-meeting.mjs';
test('native meetings keep workspace routing and namespaced record pointers without copying session credentials into explicit headers', async () => {
  const calls = [], bridge = new MeetingNativeBridge();
  const session = { async fetch(url, options) { calls.push({ url, options }); return new Response(JSON.stringify({ results: [{ role: 'editor', value: {
    id: ids.meeting, space_id: ids.space, type: 'transcription', alive: true
  } }] })); } };
  const request = new Request('https://app.notion.com/api/v3/runMeetingNotesAgent', { headers: {
    'x-notion-active-user-header': ids.user, 'x-notion-space-id': ids.space,
    'x-notion-cell-hint': 'fixture-cell', 'x-notion-cell-hint-source': 'space-id-mapping',
    authorization: 'Bearer fixture-never-forward', cookie: 'fixture-cookie-never-copy'
  } });
  const store = bridge.forRequest(request, session, ids.space);
  assert.equal((await store.root(ids.meeting)).value.id, ids.meeting);
  const { options } = calls[0], body = JSON.parse(options.body);
  assert.equal(body.requests[0].spaceId, ids.space);
  assert.equal(options.headers['x-notion-space-id'], ids.space);
  assert.equal(options.headers['x-notion-cell-hint'], 'fixture-cell');
  assert.equal(options.headers.authorization, undefined); assert.equal(options.headers.cookie, undefined);
  assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error');
  assert.equal((await bridge.forPage(ids.meeting)).spaceId, ids.space);
  await assert.rejects(store.api('runUnknownModelCommand', {}), /操作无效/);
});

test('foreign origins, ports and windows cannot borrow a previously observed native meeting session', () => {
  const bridge = new MeetingNativeBridge(), session = {};
  for (const url of ['https://attacker.example/api/v3/runMeetingNotesAgent', 'http://app.notion.com/api/v3/runMeetingNotesAgent', 'https://app.notion.com:444/api/v3/runMeetingNotesAgent']) {
    const request = new Request(url, { headers: { 'x-notion-active-user-header': ids.user } });
    bridge.observe(request, session); assert.equal(bridge.contexts.length, 0);
    assert.throws(() => bridge.forRequest(request, session, ids.space), /登录会话/);
  }
});
