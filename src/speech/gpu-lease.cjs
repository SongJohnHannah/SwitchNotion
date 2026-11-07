const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const { writeAtomicJson } = require('./atomic-json.cjs');

const entryPattern = /^([1-9]\d*)-([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i;
const unreadable = new Set(['ENOENT', 'EPERM', 'EACCES', 'EBUSY']);

/** A filesystem bakery lock: each acquisition has a unique immutable pathname.
 * Reaping a crashed owner's entry can therefore never delete a new owner's
 * lock at the same fixed pathname. All cooperating GPU callers share root.
 * Abort cancels acquisition only. The acquired lease must remain held until
 * its provider has fully closed, then its caller explicitly awaits release().
 */
async function acquireGpuLease({ root, signal, onWait, pollIntervalMs = 50,
  probePid = pid => process.kill(pid, 0) } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !Number.isInteger(pollIntervalMs)
      || pollIntervalMs < 1 || pollIntervalMs > 250 || typeof probePid !== 'function') throw new TypeError('Invalid GPU lease options');
  signal?.throwIfAborted();
  await fs.mkdir(root, { recursive: true });
  const canonicalRoot = await fs.realpath(root);
  const requestedDirectory = path.join(canonicalRoot, 'speech', 'gpu-leases');
  await fs.mkdir(requestedDirectory, { recursive: true });
  const registry = await fs.realpath(requestedDirectory);
  if (registry !== requestedDirectory) throw Error('GPU lease registry must not be redirected by a directory link');
  const token = randomUUID(), pid = process.pid, id = `${pid}-${token}`;
  const directory = path.join(registry, id), stateFile = path.join(directory, 'owner.json');
  await fs.mkdir(directory); // Unique PID/token is visible before any state write.
  let released = false;

  async function removeEntry(candidate) {
    if (path.dirname(path.resolve(candidate)) !== registry) throw Error('GPU lease cleanup escaped its registry');
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('GPU lease entry must be a real directory');
      const resolved = await fs.realpath(candidate);
      if (path.dirname(resolved) !== registry) throw Error('GPU lease cleanup resolved outside its registry');
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async function peers() {
    const result = [];
    for (const name of await fs.readdir(registry)) {
      const match = name.match(entryPattern);
      if (!match || name === id) continue;
      const ownerPid = Number(match[1]), ownerToken = match[2].toLowerCase();
      if (!Number.isSafeInteger(ownerPid)) throw Error('Invalid GPU lease PID');
      let alive = true;
      try { await probePid(ownerPid); }
      catch (error) { alive = error.code !== 'ESRCH'; } // EPERM and uncertainty are alive.
      const peerDirectory = path.join(registry, name);
      if (!alive) { await removeEntry(peerDirectory); continue; }
      let state;
      try { state = JSON.parse(await fs.readFile(path.join(peerDirectory, 'owner.json'), 'utf8')); }
      catch (error) {
        if (!unreadable.has(error.code)) throw error;
        result.push({ id: name, pid: ownerPid, token: ownerToken, choosing: true, ticket: 0 }); continue;
      }
      if (state.version !== 1 || state.pid !== ownerPid || state.token !== ownerToken || typeof state.choosing !== 'boolean'
          || !Number.isSafeInteger(state.ticket) || state.ticket < 0) throw Error('Invalid GPU lease ownership record');
      if (state.released) continue;
      result.push({ ...state, id: name });
    }
    return result;
  }

  async function release() {
    if (released) return;
    // This unique path is never reassigned. Publishing release also allows
    // waiters to continue if Windows briefly delays deleting its directory.
    await writeAtomicJson(stateFile, { version: 1, pid, token, choosing: false, ticket: 0, released: true });
    released = true;
    try { await removeEntry(directory); }
    catch (error) { error.leaseDirectory = directory; throw error; }
  }

  try {
    await writeAtomicJson(stateFile, { version: 1, pid, token, choosing: true, ticket: 0 });
    signal?.throwIfAborted();
    const previous = await peers();
    const maximum = Math.max(0, ...previous.map(peer => peer.ticket));
    if (maximum >= Number.MAX_SAFE_INTEGER - 1) throw Error('GPU lease ticket range exhausted');
    const ticket = maximum + 1;
    await writeAtomicJson(stateFile, { version: 1, pid, token, choosing: false, ticket });
    let lastBlocker = null;
    for (;;) {
      signal?.throwIfAborted();
      const blocker = (await peers()).find(peer => peer.choosing || peer.ticket > 0 &&
        (peer.ticket < ticket || peer.ticket === ticket && peer.id < id));
      signal?.throwIfAborted();
      if (!blocker) return { pid, token, ticket, directory, release };
      if (blocker.id !== lastBlocker) { await onWait?.({ pid: blocker.pid, token: blocker.token, ticket: blocker.ticket, choosing: blocker.choosing }); lastBlocker = blocker.id; }
      try { await pause(pollIntervalMs, undefined, { signal }); }
      catch (error) { signal?.throwIfAborted(); throw error; }
    }
  } catch (error) {
    try { await removeEntry(directory); }
    catch (cleanupError) { error.leaseCleanupError = cleanupError.message; error.leaseDirectory = directory; }
    throw error;
  }
}

module.exports = { acquireGpuLease };
