const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
if (!isMainThread && workerData?.kind === 'notion-switch-web-content') {
  try {
    const { extractContent } = require('./web-content.cjs'), bytes = workerData.body;
    const value = extractContent(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), workerData.contentType);
    parentPort.postMessage({ ok: true, value });
  } catch (error) { parentPort.postMessage({ ok: false, message: /^Notion 联网/.test(error.message || '') ? error.message : 'Notion 联网读取网页解析未完成。' }); }
  parentPort.close();
} else {
  const queue = []; let active = 0;
  function dispatch() {
    while (active < 2 && queue.length) {
      const item = queue.shift(); if (item.finished) continue;
      active++; item.started = true;
      // A dedicated buffer contains only this public document, never adjacent
      // data from a pooled Buffer. No app preload or credential environment is inherited.
      const body = new Uint8Array(item.body);
      let worker;
      try { worker = new Worker(__filename, { workerData: { kind: 'notion-switch-web-content', body, contentType: item.contentType }, transferList: [body.buffer],
        execArgv: [], env: {}, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } }); }
      catch { active--; item.finish(Error('Notion 联网读取无法启动网页解析，请检查运行环境。')); continue; }
      item.worker = worker;
      worker.once('message', message => {
        if (message?.ok === true) item.finish(null, message.value);
        else item.finish(Error(/^Notion 联网/.test(message?.message || '') ? message.message : 'Notion 联网读取网页解析未完成。'));
      });
      worker.once('error', () => item.finish(Error('Notion 联网读取网页解析超过资源限制或未完成。')));
      worker.once('exit', code => {
        if (!item.finished) item.finish(Error('Notion 联网读取网页解析意外停止（' + code + '）。'));
        active--; dispatch();
      });
    }
  }
  function parseDocument(body, contentType, { signal, timeoutMs = 4000 } = {}) {
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(body) || body.length > 2 * 1024 * 1024 || typeof contentType !== 'string' || contentType.length > 1000) return Promise.reject(Error('Notion 联网读取解析输入无效或过长。'));
    if (queue.length >= 16) return Promise.reject(Error('Notion 联网读取网页解析繁忙，请稍后重试。'));
    return new Promise((resolve, reject) => {
      const item = { body, contentType, finished: false, started: false };
      const abort = () => item.finish(signal.reason);
      item.finish = (error, value) => {
        if (item.finished) return; item.finished = true; clearTimeout(item.timer); signal?.removeEventListener('abort', abort);
        if (!item.started) { const at = queue.indexOf(item); if (at >= 0) queue.splice(at, 1); }
        if (error) { void item.worker?.terminate(); reject(error); } else resolve(value);
      };
      item.timer = setTimeout(() => item.finish(Error('Notion 联网读取网页解析超时，请缩小范围。')), timeoutMs); item.timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true }); queue.push(item); dispatch();
    });
  }
  module.exports = { parseDocument };
}
