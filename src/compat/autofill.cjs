const { createHash } = require('node:crypto');
const { parse } = require('./parser.cjs');
const assetName = '57590-72d9a46f46f85b70.js';
const sourceHash = 'd4de61fe17ab1265d0d3a6590a4628b984b0478bdf5f4dadccadc6abe218bbba';
const currentAssetName = '57590-3242f968a3670cd0.js';
const currentSourceHash = '1735c0788b8c9c9359b0034a3ca1bfd6d26194eacafd8c89cda0e3fb45152113';
const reviewed = new Map([
  [sourceHash, { viewFunction: 'S', captureAt: 'let k=i.id,v=null==(t=a.collectionViewStore())?void 0:t.id;', pendingFunction: 'U' }],
  [currentSourceHash, { viewFunction: 'P', captureAt: 'let v=i.id,k=null==(t=a.collectionViewStore())?void 0:t.id;', pendingFunction: 'E' }]
]);
const isAutofillAsset = asset => /^57590-[a-f\d]{16}\.js$/.test(asset);
const isAutofillCandidate = (source, asset) => isAutofillAsset(asset) || /[,{]\s*414741\s*\(/.test(source);

// Runs only inside the original frontend. The API supplies the current native
// account and workspace routing; no credentials are placed in this function.
async function pollNativeAutofill(environment, nativeRequire, marker, spaceId, interval = 500) {
  const id = marker?.jobId;
  if (marker?.version !== 1 || typeof id !== 'string' || !/^addf11ed-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id)) return false;
  const symbol = Symbol.for('notion-switch-autofill-pollers-v1'), entries = globalThis[symbol] ||= new Map();
  const key = [environment.currentUser?.id, spaceId, id].join(':');
  if (entries.has(key)) return entries.get(key);
  const task = (async () => {
    let version = -1, changedAt = Date.now(); const began = changedAt;
    // Let the native caller initialize its group counters before the first
    // update, including when a test/cache resolves an API promise immediately.
    await new Promise(resolve => setTimeout(resolve, 0));
    while (Date.now() - changedAt < 300000 && Date.now() - began < 1800000) {
      try {
        const response = await environment.api.callCellCompatibleApi({ eventName: 'notionSwitchGetAutofillStatus', environment,
          data: { jobId: id, spaceId }, cellNavigation: { spaceId } });
        if (response.type !== 'success') throw Error('Status unavailable');
        const state = response.data, names = ['success', 'in_progress', 'paused', 'failure', 'cancelled', 'skipped'];
        if (!Number.isSafeInteger(state?.version) || !['in_progress', 'success', 'failure'].includes(state.status) ||
            !state.counts || names.some(name => !Number.isSafeInteger(state.counts[name]) || state.counts[name] < 0 || state.counts[name] > 200) ||
            names.reduce((total, name) => total + state.counts[name], 0) !== state.value?.totalBlocks) throw Error('Invalid task status');
        await response.handleRecordMapForResponsePromise;
        if (state.version > version) {
          version = state.version; changedAt = Date.now(); nativeRequire(418819).S.updateStatus(id, state.counts);
        }
        if (state.status !== 'in_progress') return true;
      } catch {
        // Keep the state unconfirmed while the API is temporarily unavailable.
        // A lost progress response must not turn into a false success/failure.
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    nativeRequire(436555).D6({ label: 'Autofill 任务状态暂未确认，请重新加载记录核对；再次填充会先检查既有写入。' });
    return false;
  })().finally(() => entries.delete(key));
  entries.set(key, task); return task;
}
async function invokeLiteAutofill(environment, nativeRequire, poll, request) {
  const response = await environment.api.callCellCompatibleApi({ ...request,
    headers: { ...(request.headers || {}), 'x-notion-switch-autofill-client': '1' } });
  if (response.type === 'success' && response.data?.notionSwitchAutofill?.version === 1) {
    await response.handleRecordMapForResponsePromise;
    void poll(environment, nativeRequire, response.data.notionSwitchAutofill, request.data.spaceId).catch(() => {});
  }
  return response;
}
function captureViewSnapshot(context) {
  try {
    const view = context.collectionViewStore(), request = context.remoteRequestStore?.state;
    if (!view || !request || typeof view.getRawQuery !== 'function' || typeof view.getFormat !== 'function' ||
        typeof view.getVersion !== 'function' || typeof view.getType !== 'function') return null;
    const json = JSON.stringify({ request, view: { id: view.id, type: view.getType(), version: view.getVersion(),
      query2: view.getRawQuery() || {}, format: view.getFormat() || {} } });
    return json.length <= 200000 ? JSON.parse(json) : null;
  } catch { return null; }
}
function adaptAutofill(source, asset, onAdaptation) {
  const profile = reviewed.get(createHash('sha256').update(source).digest('hex'));
  if (!isAutofillAsset(asset) || !profile) throw Object.assign(Error('Unreviewed native Autofill module'), { notionSwitchKind: 'autofill' });
  const calls = /await ([A-Za-z_$][\w$]*)\.api\.callCellCompatibleApi\(\{eventName:"(triggerLiteAgentAutofill|triggerAgentOverCollection)"/g;
  if ([...source.matchAll(calls)].length !== 4) throw Error('Changed native Autofill entry points');
  const poll = '(' + pollNativeAutofill.toString() + ')';
  let result = source.replace(calls, (_, environment, endpoint) => `await (${invokeLiteAutofill.toString()})(${environment},r,${poll},{eventName:"${endpoint}"`);
  const original = 'if("failed"===l.type)return{success:!1};try{var n;let e=await (0,r(655696).cK)';
  if (result.split(original).length !== 2) throw Error('Changed native Autofill queue subscriber');
  const queued = 'if(l.type==="success"&&l.data?.notionSwitchAutofill?.version===1&&/^addf11ed-/i.test(l.data.notionSwitchAutofill.jobId)){await l.handleRecordMapForResponsePromise;a?.(l.data.notionSwitchAutofill.initial.value);return{success:true};}';
  result = result.replace(original, 'if("failed"===l.type)return{success:!1};' + queued + 'try{var n;let e=await (0,r(655696).cK)');
  const begin = result.indexOf('async function ' + profile.viewFunction + '(e)'), end = result.indexOf('function _(e)', begin);
  if (begin < 0 || end < begin) throw Error('Changed native Autofill view producer');
  let view = result.slice(begin, end);
  const captureAt = profile.captureAt;
  const emptyAt = 'if(0===C.length)return{success:!0,firstNWorkflowAutomationRunIds:[],totalBlocks:0};';
  if (view.split(captureAt).length !== 2 || view.split(emptyAt).length !== 2 || view.split('type:"viewFill",workflowPointer:').length !== 3)
    throw Error('Changed native Autofill view scope');
  view = view.replace(captureAt, captureAt + `const __notionSwitchAutofillView=(${captureViewSnapshot.toString()})(a);if(!__notionSwitchAutofillView)return r(436555).D6({label:"无法确认当前视图范围，请重新加载后重试。"}),{success:false,firstNWorkflowAutomationRunIds:[],totalBlocks:0};`);
  view = view.replaceAll('type:"viewFill",workflowPointer:', 'type:"viewFill",notionSwitchView:__notionSwitchAutofillView,workflowPointer:').replace(emptyAt, '');
  // The original producer marks every loaded cell before it knows the server
  // scope. Local preflight must reject incomplete/oversized views without any
  // metadata writes; group progress uses the verified local run records.
  const markAt = view.indexOf('if((function(e){let{fillMode:t,resultStores:o,collectionStore:i,propertyIds:a}=e;');
  const markEnd = view.indexOf('}),A){', markAt);
  if (markAt < 0 || markEnd < markAt || !view.slice(markAt, markEnd).endsWith('.forEach(e=>{' + profile.pendingFunction + '({blockStore:e,propertyIds:c,environment:l})'))
    throw Error('Changed native Autofill view pending-cell mutation');
  view = view.slice(0, markAt) + 'if(A){' + view.slice(markEnd + '}),A){'.length);
  result = result.slice(0, begin) + view + result.slice(end);
  parse(result, { ecmaVersion: 2024 });
  onAdaptation?.({ moduleId: '414741', kind: 'autofill', mode: 'reviewed' });
  return result;
}
module.exports = { adaptAutofill, pollNativeAutofill, invokeLiteAutofill, captureViewSnapshot, isAutofillAsset, isAutofillCandidate, assetName, sourceHash, currentAssetName, currentSourceHash };
