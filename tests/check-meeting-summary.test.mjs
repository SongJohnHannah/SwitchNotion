import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkMeetingSummary } from '../scripts/check-meeting-summary.mjs';

function fixture(t) {
  const parent = path.resolve('.notion-switch'), projectDirectory = fs.mkdtempSync(path.join(parent, 'test-summary-check-'));
  t.after(() => { assert.equal(path.dirname(projectDirectory), parent); fs.rmSync(projectDirectory, { recursive: true, force: true }); });
  const root = path.join(projectDirectory, '.notion-switch/mac-arm64'), home = path.join(projectDirectory, '合成用户');
  const write = (directory, name, data) => { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, name), JSON.stringify(data)); };
  write(root, 'prepared.json', { platform: 'darwin', version: '7.41.0' });
  write(root, 'speech.local.json', { enabled: true, autoSummary: true, runtime: { privatePath: 'never-export' } });
  const token = 'b'.repeat(64);
  write(root, 'control.json', { port: 12345, token });
  const live = { appReady: true, mode: 'deepseek', keyConfigured: true, speech: { enabled: true, autoSummary: true },
    meetingSummaries: { active: 0, completed: 2, uncertain: 0, lastError: '' }, privateText: 'never-export' };
  return { root, home, projectDirectory, write, token, live, options: { projectDirectory, home, platform: 'darwin', env: {},
    fsImpl: { ...fs, writeFileSync: () => assert.fail('No writes'), mkdirSync: () => assert.fail('No preparations') },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:12345/status'); assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, 'Bearer ' + token);
      return new Response(JSON.stringify(live));
    } } };
}

test('Mac diagnostics read its own source profile and exclude credentials, paths, IDs and meeting text', async t => {
  const f = fixture(t); f.live.meetingSummaries.privateDraft = 'never-export';
  fs.writeFileSync(path.join(f.root, 'events.jsonl'), [
    { time: '2026-10-31T05:00:00.000Z', type: 'offline-audio-connected', userId: 'never-export' },
    { time: '2026-10-31T05:01:00.000Z', type: 'meeting-summary-failed', message: 'never-export', meetingText: 'never-export' },
    { time: '2026-10-31T05:02:00.000Z', type: 'unrelated-private-event', message: 'never-export' }
  ].map(JSON.stringify).join('\n'));
  const result = await checkMeetingSummary(f.options), report = result.profiles[0], text = JSON.stringify(result);
  assert.equal(report.live, true); assert.equal(report.autoSummary, true); assert.equal(report.summary.completed, 2);
  assert.deepEqual(report.recentEvents.map(e => e.type), ['offline-audio-connected', 'meeting-summary-failed']);
  for (const privateValue of [f.token, f.home, 'never-export']) assert.equal(text.includes(privateValue), false);
});

test('live Mac settings take precedence over an older saved automatic-summary toggle', async t => {
  const f = fixture(t); f.live.speech.autoSummary = false;
  const report = (await checkMeetingSummary(f.options)).profiles[0];
  assert.equal(report.autoSummary, false); assert.match(report.finding, /关闭了自动摘要/);
});

test('failure categories and pending writes remain visible without exposing raw upstream messages', async t => {
  const f = fixture(t); f.live.meetingSummaries.lastError = '会议内容接口返回 HTTP 403 never-export';
  const report = (await checkMeetingSummary(f.options)).profiles[0];
  assert.equal(report.summary.error, 'Notion HTTP 403'); assert.equal(JSON.stringify(report).includes('never-export'), false);
  f.live.meetingSummaries.lastError = '会议笔记生成失败，原有转录与手写笔记保持不变。';
  assert.match((await checkMeetingSummary(f.options)).profiles[0].summary.error, /现有状态未提供具体阶段/);
  f.live.meetingSummaries.lastError = ''; f.live.meetingSummaries.uncertain = 1;
  assert.match((await checkMeetingSummary(f.options)).profiles[0].finding, /不要重复提交/);
});

test('Mac application profile is checked separately from source and never reuses Windows state', async t => {
  const f = fixture(t), appRoot = path.join(f.home, 'Library/Application Support/Switch Notion');
  f.write(path.join(f.projectDirectory, '.notion-switch'), 'speech.local.json', { enabled: true, autoSummary: false });
  f.write(appRoot, 'speech.local.json', { enabled: true, autoSummary: false });
  const reports = (await checkMeetingSummary(f.options)).profiles;
  assert.equal(reports.length, 2); assert.equal(reports[0].autoSummary, true);
  assert.equal(reports[1].profile, 'Mac 应用资料'); assert.equal(reports[1].live, false);
});

test('stale control files do not masquerade as a running Mac or cause writes', async t => {
  const f = fixture(t), result = await checkMeetingSummary({ ...f.options, fetchImpl: async () => { throw Error('offline'); } });
  assert.equal(result.profiles[0].live, false); assert.match(result.profiles[0].finding, /历史记录/);
  f.write(f.root, 'prepared.json', { platform: 'win32' });
  const mismatched = await checkMeetingSummary({ ...f.options, fetchImpl: () => assert.fail('No wrong-platform connection') });
  assert.equal(mismatched.profiles[0].platformMatches, false);
  await assert.rejects(checkMeetingSummary({ ...f.options, root: 'relative-state' }), /绝对路径/);
});
