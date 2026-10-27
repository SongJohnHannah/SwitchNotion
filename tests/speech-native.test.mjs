import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import native from '../src/speech/native.cjs';
import compatibility from '../src/client-compat.cjs';
import sessions from '../src/meeting-audio.cjs';
const W = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture(t) {
  const calls = []; let leases = 0;
  const provider = { runtime: {}, probe: async () => {}, retain: () => leases++, release: () => leases--,
    transcribe: async ({ pcm }) => { calls.push(pcm); return '离线中英文转写'; } };
  const speech = { enabled: true, provider };
  const service = new native.NativeSpeech({ speech, originAllowed: origin => origin === undefined }); service.transportReady = true;
  service.lifecycleReady = true; service.drainTransportReady = true;
  t.after(() => service.close()); return { service, calls, leases: () => leases };
}
async function client(service) {
  const token = await service.token();
  const ws = new WebSocket(service.endpoint.replace('http:', 'ws:') + '/primus-v8/?EIO=4&transport=websocket&token=' + token.accessToken);
  const messages = [], pending = [];
  ws.addEventListener('message', event => { messages.push(event.data); for (const wake of pending.splice(0)) wake(); });
  await once(ws, 'open');
  const wait = async predicate => {
    const timer = setTimeout(() => { for (const wake of pending.splice(0)) wake(); }, 2000);
    try { for (let tries = 0; tries < 30; tries++) { const found = messages.find(predicate); if (found) return found; await new Promise(resolve => { pending.push(resolve); setTimeout(resolve, 100); }); } throw Error('Missing native audio response'); }
    finally { clearTimeout(timer); }
  };
  const send = (method, id, input = {}) => ws.send('4' + JSON.stringify({ type: '/api/v1/' + method, requestId: id, ...input }));
  return { ws, messages, wait, send };
}
const event = value => { try { return value.startsWith('4') ? JSON.parse(value.slice(1)) : null; } catch { return null; } };
test('native start returns its token and accepts a microphone connection while the model is still loading', async t => {
  const f = fixture(t); let finish;
  f.service.speech.provider.probe = () => new Promise(resolve => { finish = resolve; });
  const token = await Promise.race([f.service.token(), new Promise((_, reject) => setTimeout(() => reject(Error('Model load blocked recording start')), 500))]);
  assert.equal(typeof token.accessToken, 'string'); assert.equal(f.service.status().warming, true);
  const c = await client(f.service); t.after(() => c.ws.close());
  c.send('transcriptionInfo', 'fast-context', { rootBlockId: B, spaceId: W });
  await c.wait(m => event(m)?.requestId === 'fast-context'); assert.equal(f.leases(), 1); finish();
});

test('native recording cannot start when an unknown client has no verified stop-and-drain adaptation', async t => {
  const f = fixture(t); f.service.lifecycleReady = false;
  await assert.rejects(f.service.token(), /录音收尾适配/);
  f.service.lifecycleReady = true; f.service.drainTransportReady = false;
  await assert.rejects(f.service.token(), /录音收尾适配/);
});
test('background model failure is explicit and releases the native recording rather than leaving a false running state', async t => {
  const f = fixture(t); let fail;
  f.service.speech.provider.probe = () => new Promise((_resolve, reject) => { fail = reject; });
  const c = await client(f.service); t.after(() => c.ws.close());
  c.send('transcriptionInfo', 'context', { rootBlockId: B, spaceId: W }); await c.wait(m => event(m)?.requestId === 'context');
  fail(Error('fixture unavailable model'));
  await c.wait(m => event(m)?.type === 'openai_error'); assert.equal(f.leases(), 0);
});
test('native Engine.IO/Primus transport returns real local transcript events and drains the final short segment once', async t => {
  const f = fixture(t), c = await client(f.service); t.after(() => c.ws.close());
  await c.wait(m => m.startsWith('0'));
  c.send('clientInfo', 'client'); c.send('transcriptionInfo', 'context', { rootBlockId: B, spaceId: W });
  await c.wait(m => event(m)?.requestId === 'context'); assert.equal(f.leases(), 1);
  const pcm = Buffer.alloc(16000 * 4 * 2); for (let i = 0; i < pcm.length; i += 4) pcm.writeFloatLE(.1, i);
  c.send('audioData', 'audio', { blockId: B, spaceId: W, base64Audio: pcm.toString('base64') });
  c.send('audioData', 'audio', { blockId: B, spaceId: W, base64Audio: pcm.toString('base64') });
  c.send('drainTranscription', 'drain');
  const completed = event(await c.wait(m => event(m)?.transcription?.status === 'complete'));
  await c.wait(m => event(m)?.requestId === 'drain');
  assert.equal(completed.transcription.text, '离线中英文转写'); assert.equal(completed.transcription.audioDuration, 2);
  assert.equal(completed.isSegmentComplete, true); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].length, pcm.length); assert.equal(f.leases(), 0);
  c.send('drainTranscription', 'drain'); await c.wait(m => event(m)?.requestId === 'drain'); assert.equal(f.calls.length, 1);
});
test('malformed audio is rejected before reaching the GPU worker', async t => {
  const f = fixture(t), c = await client(f.service); t.after(() => c.ws.close());
  c.send('transcriptionInfo', 'context', { rootBlockId: B, spaceId: W }); await c.wait(m => event(m)?.requestId === 'context');
  c.send('audioData', 'bad', { blockId: B, spaceId: W, base64Audio: 'invalid audio' });
  await c.wait(m => event(m)?.requestId === 'bad' && event(m)?.status === 'error'); assert.equal(f.calls.length, 0);
});
test('silence is finalized as ignore rather than an empty Notion paragraph', async () => {
  const events = []; let writes = 0;
  const session = new sessions.MeetingAudioSession({ provider: { transcribe: async () => '' }, emit: value => events.push(value), onTranscript: () => writes++ });
  await session.handle({ type: '/api/v1/transcriptionInfo', requestId: 'context', rootBlockId: B, spaceId: W });
  await session.handle({ type: '/api/v1/audioData', requestId: 'silence', blockId: B, spaceId: W, base64Audio: Buffer.alloc(16000 * 4).toString('base64') });
  await session.handle({ type: '/api/v1/drainTranscription', requestId: 'drain' });
  const result = events.find(e => e.transcription?.status === 'ignore');
  assert.ok(result); assert.equal(result.isSegmentComplete, true); assert.equal(writes, 0);
  assert.equal(events.some(e => e.transcription?.status === 'complete'), false); session.close();
});
test('a drained recording can start on another page while an active recording cannot switch targets', async () => {
  const events = [], other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const session = new sessions.MeetingAudioSession({ provider: { transcribe: async () => 'text' }, emit: e => events.push(e) });
  await session.handle({ type: '/api/v1/transcriptionInfo', requestId: 'first', rootBlockId: B, spaceId: W });
  await assert.rejects(session.handle({ type: '/api/v1/transcriptionInfo', requestId: 'blocked', rootBlockId: other, spaceId: W }), /活动录音/);
  await session.handle({ type: '/api/v1/drainTranscription', requestId: 'drain' });
  await session.handle({ type: '/api/v1/transcriptionInfo', requestId: 'next', rootBlockId: other, spaceId: W });
  assert.equal(session.context.blockId, other); session.close();
});
test('production origins and loopback policy exclude unrelated sites and preserve other CSP restrictions', () => {
  assert.equal(native.allowedOrigin('https://app.notion.com'), true); assert.equal(native.allowedOrigin('https://www.notion.so'), true);
  for (const value of ['https://attacker.example', 'https://notion.com.attacker.example', 'http://app.notion.com', 'null', undefined]) assert.equal(native.allowedOrigin(value), false);
  const csp = native.loopbackCsp("default-src 'none'; connect-src https://app.notion.com; script-src 'self'", 'http://127.0.0.1:32123');
  assert.ok(csp.includes('ws://127.0.0.1:32123')); assert.ok(csp.includes("script-src 'self'")); assert.ok(!csp.includes('*'));
  assert.throws(() => native.loopbackCsp('default-src none', 'https://attacker.example'));
});
const source = name => { const file = path.resolve('research/.public-assets', name); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; };
const audio = source('17521-084ec2bc2599898c.js'), availability = source('95271-adc4a76136e50ec0.js');
test('reviewed transport redirects to loopback only when enabled, and unknown module changes fail closed', audio ? {} : { skip: 'Private official asset cache unavailable' }, () => {
  assert.equal(compatibility.adaptClient(audio, '17521-084ec2bc2599898c.js'), audio);
  const options = { localSpeechEnabled: true, audioEndpoint: 'http://127.0.0.1:32123' };
  const adapted = compatibility.adaptClient(audio, '17521-084ec2bc2599898c.js', options);
  assert.ok(adapted.includes('let l="http://127.0.0.1:32123"+"?"+u.toString()'));
  assert.throws(() => compatibility.adaptClient(audio + 'changed', '17521-084ec2bc2599898c.js', options));
  assert.throws(() => compatibility.adaptClient(audio, '17521-084ec2bc2599898c.js', { ...options, audioEndpoint: 'https://attacker.example' }));
});
test('local recording availability keeps workspace transcription-disable checks', availability ? {} : { skip: 'Private official asset cache unavailable' }, () => {
  const adapted = compatibility.adaptClient(availability, '95271-adc4a76136e50ec0.js', { localSpeechEnabled: true });
  assert.ok(adapted.indexOf('if(u==="ai_meeting_notes"') > adapted.indexOf('workspaceRestriction:y'));
  assert.ok(adapted.includes('n.data.space?.isTranscriptionEnabled?.()!==false'));
});
