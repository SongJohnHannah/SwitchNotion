// Stable application interface; the worker has no Codex or Notion dependency.
const { transcribeGpuFile, defaultPlan } = require('./speech/gpu-file.cjs');
module.exports = { ...require('./speech/provider.cjs'), transcribeGpuFile, defaultPlan };
