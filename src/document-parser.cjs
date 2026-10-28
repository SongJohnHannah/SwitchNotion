const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
if (!isMainThread && workerData?.kind === 'notion-switch-document') {
  // The only dynamic resources are the fixed bundled PDF fonts/maps. A document
  // cannot fetch an external relationship, run scripts, or inherit app secrets.
  globalThis.fetch = async () => { throw Error('External document fetch disabled'); };
  globalThis.XMLHttpRequest = undefined; globalThis.WebSocket = undefined;
  (async () => {
    try {
      const { extractDocument } = require('./document-content.cjs'), data = workerData.bytes;
      const result = await extractDocument(Buffer.from(data.buffer, data.byteOffset, data.byteLength), workerData.filename, workerData.mediaType);
      parentPort.postMessage({ ok: true, value: result });
    } catch (error) { parentPort.postMessage({ ok: false, message: /^Notion /.test(error.message || '') ? error.message : 'Notion 附件解析未完成。' }); }
    finally { parentPort.close(); }
  })();
} else {
  const queue = []; let running = 0, queuedBytes = 0;
  function dispatch() {
    while (running < 2 && queue.length) {
      const item = queue.shift(); queuedBytes -= item.bytes.length; if (item.done) continue;
      item.started = true; running++; const bytes = new Uint8Array(item.bytes); let worker;
      try {
        worker = new Worker(__filename, { workerData: { kind: 'notion-switch-document', bytes, filename: item.filename, mediaType: item.mediaType }, transferList: [bytes.buffer],
          execArgv: [], env: {}, stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
      } catch { running--; item.finish(Error('Notion 附件无法启动解析线程。')); continue; }
      item.worker = worker; worker.stdout.resume(); worker.stderr.resume();
      worker.once('message', result => result?.ok === true ? item.finish(null, result.value) : item.finish(Error(/^Notion /.test(result?.message || '') ? result.message : 'Notion 附件解析失败。')));
      worker.once('error', () => item.finish(Error('Notion 附件解析超过资源限制或未完成。')));
      worker.once('exit', () => { if (!item.done) item.finish(Error('Notion 附件解析意外中断。')); running--; dispatch(); });
    }
  }
  function parseAttachment(bytes, filename, mediaType, { signal, timeoutMs = 10000 } = {}) {
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16 * 1024 * 1024 || typeof filename !== 'string' || filename.length > 255 || typeof mediaType !== 'string' || mediaType.length > 200)
      return Promise.reject(Error('Notion 附件解析输入无效或过大。'));
    if (queue.length >= 16 || queuedBytes + bytes.length > 64 * 1024 * 1024) return Promise.reject(Error('Notion 附件解析繁忙，请稍后重试。'));
    return new Promise((resolve, reject) => {
      const item = { bytes, filename, mediaType, done: false }, abort = () => item.finish(signal.reason);
      item.finish = (error, value) => {
        if (item.done) return; item.done = true; clearTimeout(item.timer); signal?.removeEventListener('abort', abort);
        if (!item.started) { const index = queue.indexOf(item); if (index >= 0) { queue.splice(index, 1); queuedBytes -= item.bytes.length; } }
        void item.worker?.terminate(); if (error) reject(error); else resolve(value);
      };
      item.timer = setTimeout(() => item.finish(Error('Notion 附件解析超时，请缩小文件后重试。')), timeoutMs); item.timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true }); queue.push(item); queuedBytes += bytes.length; dispatch();
    });
  }
  module.exports = { parseAttachment };
}
