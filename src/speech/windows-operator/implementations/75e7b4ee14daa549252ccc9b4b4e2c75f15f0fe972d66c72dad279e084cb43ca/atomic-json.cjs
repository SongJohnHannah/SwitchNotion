const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');

const windowsRenameErrors = new Set(['EPERM', 'EBUSY', 'EACCES']);
// Six retries, 560 ms of total scheduled waiting. The completed temporary
// file is reused throughout; a failed replacement never unlinks the target.
const retryDelays = Object.freeze([10, 20, 40, 80, 160, 250]);

function annotated(error, targetPath, tempPath, renameAttempts) {
  const failure = error instanceof Error ? error : new Error(String(error));
  failure.targetPath = targetPath;
  failure.tempPath = tempPath;
  failure.renameAttempts = renameAttempts;
  return failure;
}

async function writeAtomicJson(file, value, { rename = fs.rename, sleep = pause, platform = process.platform } = {}) {
  if (typeof file !== 'string' || !file || typeof rename !== 'function' || typeof sleep !== 'function') throw new TypeError('Invalid atomic JSON write arguments');
  const targetPath = path.resolve(file);
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError('Atomic JSON value must be serializable');
  const tempPath = targetPath + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(tempPath, serialized + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
  } catch (error) { throw annotated(error, targetPath, tempPath, 0); }

  let renameAttempts = 0;
  for (;;) {
    renameAttempts++;
    try {
      await rename(tempPath, targetPath);
      return { targetPath, renameAttempts };
    } catch (error) {
      const retry = platform === 'win32' && windowsRenameErrors.has(error?.code) && renameAttempts <= retryDelays.length;
      if (!retry) throw annotated(error, targetPath, tempPath, renameAttempts);
      try { await sleep(retryDelays[renameAttempts - 1]); }
      catch (sleepError) { throw annotated(sleepError, targetPath, tempPath, renameAttempts); }
    }
  }
}

module.exports = { writeAtomicJson };
