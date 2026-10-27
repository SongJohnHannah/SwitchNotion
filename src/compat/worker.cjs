const { parentPort } = require('node:worker_threads');
const { adaptAutomatic } = require('./automatic.cjs');
parentPort.on('message', ({ id, source, asset, options }) => {
  try {
    const records = [], output = adaptAutomatic(source, asset, { ...options, onAdaptation: record => records.push(record) });
    parentPort.postMessage({ id, ok: true, output, records });
  } catch { parentPort.postMessage({ id, ok: false }); }
});
