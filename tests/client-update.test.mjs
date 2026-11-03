import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import clientModule from '../src/client-update.cjs';
import { applyClientUpdate } from '../scripts/client-update-helper.mjs';
const { ClientUpdate, approvedRemote } = clientModule;
function fixture(t) {
  const parent = path.resolve('.notion-switch'), dir = fs.mkdtempSync(path.join(parent, 'test-client-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seed = path.join(dir, 'seed'), remote = path.join(dir, 'remote.git'), project = path.join(dir, 'project'), root = path.join(dir, 'state');
  fs.mkdirSync(seed); fs.mkdirSync(root);
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(seed, ['init', '--initial-branch=main']);
  const identity = cwd => { git(cwd, ['config', 'user.name', 'Fixture']); git(cwd, ['config', 'user.email', 'fixture@example.invalid']); };
  identity(seed);
  for (const file of ['package.json', 'src/desktop-hook.cjs', 'src/update-service.cjs', 'scripts/start-desktop.mjs', 'scripts/runtime-update.mjs']) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true }); fs.writeFileSync(path.join(seed, file), '// fixture');
  }
  fs.writeFileSync(path.join(seed, 'feature.txt'), 'old code'); git(seed, ['add', '.']); git(seed, ['commit', '-m', 'initial']);
  git(dir, ['clone', '--bare', seed, remote]); git(dir, ['clone', remote, project]); identity(project);
  git(project, ['remote', 'set-url', 'origin', 'https://github.com/SongJohnHannah/SwitchNotion.git']);
  const before = git(project, ['rev-parse', 'HEAD']), calls = [];
  const run = async args => { calls.push(args); return git(project, args[0] === 'fetch' ? ['fetch', '--no-tags', remote, 'main:refs/remotes/origin/main'] : args); };
  const client = new ClientUpdate({ root, projectDirectory: project, run });
  function publish({ missing } = {}) {
    fs.writeFileSync(path.join(seed, 'feature.txt'), 'new code'); if (missing) fs.unlinkSync(path.join(seed, missing));
    git(seed, ['add', '.']); git(seed, ['commit', '-m', 'update']); git(seed, ['push', remote, 'main']); return git(seed, ['rev-parse', 'HEAD']);
  }
  return { root, project, seed, remote, before, calls, client, git, run, publish };
}
test('client update downloads the pinned repository then fast-forwards clean code without touching private state', async t => {
  const f = fixture(t), after = f.publish(); fs.writeFileSync(path.join(f.root, 'private.local.json'), 'keep local state');
  assert.equal((await f.client.status()).revision, f.before.slice(0, 7));
  const plan = await f.client.prepare(); assert.deepEqual(plan, { before: f.before, after, available: true });
  assert.equal(fs.readFileSync(path.join(f.project, 'feature.txt'), 'utf8'), 'old code', 'Downloading cannot modify a running application');
  await f.client.apply(plan); assert.equal(f.git(f.project, ['rev-parse', 'HEAD']), after);
  assert.equal(fs.readFileSync(path.join(f.project, 'feature.txt'), 'utf8'), 'new code');
  assert.equal(fs.readFileSync(path.join(f.root, 'private.local.json'), 'utf8'), 'keep local state');
  assert.equal((await f.client.prepare()).available, false);
});
test('uncommitted files and unapproved repositories block code updates before any download', async t => {
  const f = fixture(t); f.publish(); fs.writeFileSync(path.join(f.project, 'feature.txt'), 'unsaved changes');
  await assert.rejects(f.client.prepare(), /未提交/); assert.equal(f.calls.some(args => args[0] === 'fetch'), false);
  f.git(f.project, ['checkout', '--', 'feature.txt']); f.git(f.project, ['remote', 'set-url', 'origin', 'https://github.com/other/repository.git']);
  await assert.rejects(f.client.prepare(), /更新来源/);
  for (const url of ['https://github.com/SongJohnHannah/SwitchNotion.git', 'git@github.com:SongJohnHannah/SwitchNotion.git']) assert.equal(approvedRemote(url), true);
  for (const url of ['https://example.invalid/SongJohnHannah/SwitchNotion.git', 'https://github.com/SongJohnHannah/SwitchNotion.git/extra', 'https://secret@github.com/SongJohnHannah/SwitchNotion.git']) assert.equal(approvedRemote(url), false);
});
test('existing SSH authentication is tried after a failed HTTPS fetch without changing Git configuration', async t => {
  const f = fixture(t); const after = f.publish(), transports = [];
  const client = new ClientUpdate({ root: f.root, projectDirectory: f.project, run: async args => {
    if (args[0] === 'fetch') { transports.push(args[2]); if (args[2].startsWith('https:')) throw Error('authentication unavailable'); }
    return f.run(args);
  } });
  assert.equal((await client.prepare()).after, after); assert.equal(transports.length, 2); assert.match(transports[1], /^git@github.com:/);
  assert.equal(f.git(f.project, ['remote', 'get-url', 'origin']), 'https://github.com/SongJohnHannah/SwitchNotion.git');
});
test('divergent local commits and incomplete remote builds are retained rather than overwritten', async t => {
  const f = fixture(t); f.publish(); fs.writeFileSync(path.join(f.project, 'local.txt'), 'local commit'); f.git(f.project, ['add', '.']); f.git(f.project, ['commit', '-m', 'local work']);
  const ownHead = f.git(f.project, ['rev-parse', 'HEAD']); await assert.rejects(f.client.prepare(), /分歧/); assert.equal(f.git(f.project, ['rev-parse', 'HEAD']), ownHead);
  const g = fixture(t); g.publish({ missing: 'scripts/start-desktop.mjs' }); await assert.rejects(g.client.prepare(), /必要启动文件/);
  assert.equal(g.git(g.project, ['rev-parse', 'HEAD']), g.before);
});
test('changes made after downloading prevent apply and changes made after applying prevent automatic restore', async t => {
  const f = fixture(t); f.publish(); const plan = await f.client.prepare();
  fs.writeFileSync(path.join(f.project, 'feature.txt'), 'editing during download'); await assert.rejects(f.client.apply(plan), /未提交/);
  f.git(f.project, ['checkout', '--', 'feature.txt']); await f.client.apply(plan);
  fs.writeFileSync(path.join(f.project, 'feature.txt'), 'editing after update'); await assert.rejects(f.client.restore(plan), /未提交/);
  assert.equal(fs.readFileSync(path.join(f.project, 'feature.txt'), 'utf8'), 'editing after update');
});
test('failed startup restores the previous code and restarts it; success records that new code was actually loaded', async t => {
  const f = fixture(t); f.publish(); const plan = await f.client.prepare(), attempts = [];
  assert.equal(await applyClientUpdate({ project: f.project, root: f.root, plan, client: f.client, runTests: async () => ({ ok: true }), start: async checking => { attempts.push(checking); if (checking) throw Error('fixture startup failure'); } }), false);
  assert.deepEqual(attempts, [true, false]); assert.equal(f.git(f.project, ['rev-parse', 'HEAD']), f.before); assert.equal(f.client.last().status, 'restored');
  assert.equal(await applyClientUpdate({ project: f.project, root: f.root, plan, client: f.client, runTests: async () => ({ ok: true }), start: async checking => { assert.equal(checking, true); assert.equal(f.git(f.project, ['rev-parse', 'HEAD']), plan.after); } }), true);
  assert.equal(f.client.last().status, 'applied');
});
test('updates run the project test suite after merging and report progress', async t => {
  const f = fixture(t); f.publish(); const plan = await f.client.prepare(), events = [];
  assert.equal(f.client.last().status, 'downloaded'); assert.equal(f.client.last().progress, 30);
  const ok = await applyClientUpdate({ project: f.project, root: f.root, plan, client: f.client,
    runTests: async ({ project }) => { events.push(['tests', f.git(project, ['rev-parse', 'HEAD'])]); return { ok: true }; },
    start: async checking => { events.push(['start', checking]); } });
  assert.equal(ok, true);
  assert.deepEqual(events, [['tests', plan.after], ['start', true]]);
  assert.equal(f.client.last().status, 'applied'); assert.equal(f.client.last().progress, 100);
});
test('a failing test suite restores the previous code and relaunches it', async t => {
  const f = fixture(t); f.publish(); const plan = await f.client.prepare(), attempts = [];
  const ok = await applyClientUpdate({ project: f.project, root: f.root, plan, client: f.client,
    runTests: async () => ({ ok: false }), start: async checking => { attempts.push(checking); } });
  assert.equal(ok, false);
  assert.deepEqual(attempts, [false], 'New code must never start when tests fail');
  assert.equal(f.git(f.project, ['rev-parse', 'HEAD']), f.before);
  assert.equal(f.client.last().status, 'restored');
  assert.match(f.client.last().message, /测试未通过/);
});
test('missing Git metadata gives an unavailable status without crashing other settings', async t => {
  const f = fixture(t), client = new ClientUpdate({ root: f.root, projectDirectory: f.root });
  const status = await client.status(); assert.equal(status.supported, false); assert.equal('revision' in status, false);
});
