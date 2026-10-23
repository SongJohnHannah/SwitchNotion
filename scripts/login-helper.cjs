// External Node 22 helper. No cookie/key values ever enter IPC, stdout or logs.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { inspectLogin, stageLogin, readStagedMetadata, applyStagedLogin, safeError } = require('../src/login-state.cjs');
const project = path.resolve(__dirname, '..'), fixedRoot = path.join(project, '.notion-switch');
function argumentsFor(values) {
  const action = values[0], options = {};
  if (!['status', 'stage', 'apply-and-restart'].includes(action) || values.length > 7) throw Error('Invalid helper action');
  for (let index = 1; index < values.length; index += 2) {
    const key = values[index];
    if (!['--root', '--stage', '--parent-pid'].includes(key) || !values[index + 1] || Object.hasOwn(options, key)) throw Error('Invalid helper options');
    options[key] = values[index + 1];
  }
  const root = path.resolve(options['--root'] || fixedRoot);
  if (root.toLowerCase() !== fixedRoot.toLowerCase()) throw Error('Invalid helper root');
  return { action, root, stageId: options['--stage'], parentPid: Number(options['--parent-pid']) };
}
function reopenSettings() {
  const child = spawn(process.execPath, [path.join(project, 'scripts', 'open-settings.mjs')], { cwd: project, windowsHide: true, detached: true, stdio: 'ignore', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  child.on('error', () => {}); child.unref();
}
(async () => {
  let args;
  try {
    args = argumentsFor(process.argv.slice(2));
    if (args.action === 'status' || args.action === 'stage') {
      const result = args.action === 'status' ? inspectLogin(args) : stageLogin(args);
      process.stdout.write(JSON.stringify({ ok: true, result })); return;
    }
    readStagedMetadata(args);
    if (!Number.isInteger(args.parentPid) || args.parentPid <= 0 || args.parentPid === process.pid) throw Error('Invalid parent pid');
    if (process.send) await new Promise((resolve, reject) => process.send({ type: 'login-sync-ready', stageId: args.stageId }, error => error ? reject(error) : resolve()));
    if (process.connected) { try { process.disconnect(); } catch {} }
    try { await applyStagedLogin(args); }
    catch (error) {
      // The apply function writes only safe result metadata and attempts rollback.
      // Failures before mutation (e.g. parent still running) need a result too.
      try {
        const resultFile = path.join(args.root, 'login-sync-result.json');
        let previous; try { previous = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}
        if (previous?.stageId !== args.stageId) fs.writeFileSync(resultFile, JSON.stringify({ version: 1, stageId: args.stageId, status: 'failed', at: new Date().toISOString(), errorCode: safeError(error, 'apply_failed').loginCode, serverValidated: false }), { mode: 0o600 });
      } catch {}
    } finally { reopenSettings(); }
  } catch (error) {
    const safe = safeError(error, 'helper_unavailable');
    if (args?.action === 'apply-and-restart') { if (process.connected) { try { process.disconnect(); } catch {} } reopenSettings(); }
    else process.stdout.write(JSON.stringify({ ok: false, code: safe.loginCode }));
    process.exitCode = 1;
  }
})().catch(() => { process.exitCode = 1; });
