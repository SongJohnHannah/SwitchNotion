const { createHash } = require('node:crypto');
const { parse } = require('./parser.cjs');
const { adaptRecordingClient } = require('../speech/client.cjs');
const documents = require('./inline-documents.cjs');
const { pollNativeAutofill, invokeLiteAutofill, captureViewSnapshot } = require('./autofill.cjs');

// Exact public assets observed in the macOS client on 2026-10-28. This
// adapter is dispatched only on Darwin; the existing Windows adapters stay
// on their original path. Unknown bytes must still fail closed.
const assets = Object.freeze({
  '17048-b38a7b8f431620b1.js': { kind: 'connection', moduleId: '697264', hash: 'bae8613c7c95b7983ea804f88fe527b50c780c9424734464555266917b134201' },
  '89269-451ea294ba9323c0.js': { kind: 'recording', moduleId: '331787', hash: '5501272ae32976cf9515d2672f46e21582bf4ed6162c679630989cbd2c200446' },
  '51103-1249b090dd731220.js': { kind: 'attachments', moduleId: '175529', hash: '390857956053ace5c09b2f9c65ace352363d3244126a8f5a61a2b9c1dd997abb' },
  '57590-3242f968a3670cd0.js': { kind: 'autofill', moduleId: '414741', hash: '1735c0788b8c9c9359b0034a3ca1bfd6d26194eacafd8c89cda0e3fb45152113' }
});
const isMacClientAsset = asset => Object.hasOwn(assets, asset);
function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Changed macOS native client anchor');
  return source.replace(before, after);
}

function autofill(source) {
  const calls = /await ([A-Za-z_$][\w$]*)\.api\.callCellCompatibleApi\(\{eventName:"(triggerLiteAgentAutofill|triggerAgentOverCollection)"/g;
  if ([...source.matchAll(calls)].length !== 4) throw Error('Changed macOS Autofill producers');
  const poll = '(' + pollNativeAutofill.toString() + ')';
  let output = source.replace(calls, (_, environment, endpoint) => `await (${invokeLiteAutofill.toString()})(${environment},r,${poll},{eventName:"${endpoint}"`);
  const subscribe = 'if("failed"===l.type)return{success:!1};try{var n;let e=await (0,r(655696).cK)';
  output = once(output, subscribe, 'if("failed"===l.type)return{success:!1};if(l.type==="success"&&l.data?.notionSwitchAutofill?.version===1&&/^addf11ed-/i.test(l.data.notionSwitchAutofill.jobId)){await l.handleRecordMapForResponsePromise;a?.(l.data.notionSwitchAutofill.initial.value);return{success:true};}try{var n;let e=await (0,r(655696).cK)');
  const begin = output.indexOf('async function P(e)'), end = output.indexOf('function _(e)', begin);
  if (begin < 0 || end < begin) throw Error('Changed macOS Autofill view producer');
  let view = output.slice(begin, end);
  const capture = 'let v=i.id,k=null==(t=a.collectionViewStore())?void 0:t.id;';
  view = once(view, capture, capture + `const __notionSwitchAutofillView=(${captureViewSnapshot.toString()})(a);if(!__notionSwitchAutofillView)return r(436555).D6({label:"无法确认当前视图范围，请重新加载后重试。"}),{success:false,firstNWorkflowAutomationRunIds:[],totalBlocks:0};`);
  view = once(view, 'if(0===C.length)return{success:!0,firstNWorkflowAutomationRunIds:[],totalBlocks:0};', '');
  if (view.split('type:"viewFill",workflowPointer:').length !== 3) throw Error('Changed macOS Autofill view scope');
  view = view.replaceAll('type:"viewFill",workflowPointer:', 'type:"viewFill",notionSwitchView:__notionSwitchAutofillView,workflowPointer:');
  const mark = view.indexOf('if((function(e){let{fillMode:t,resultStores:o,collectionStore:i,propertyIds:a}=e;'), markEnd = view.indexOf('}),A){', mark);
  if (mark < 0 || markEnd < mark || !view.slice(mark, markEnd).endsWith('.forEach(e=>{E({blockStore:e,propertyIds:c,environment:l})')) throw Error('Changed macOS Autofill pending-cell update');
  // As in the existing adapter, resolve the complete view before allowing
  // any pending-cell metadata writes, even when no rows are loaded locally.
  view = view.slice(0, mark) + 'if(A){' + view.slice(markEnd + '}),A){'.length);
  return output.slice(0, begin) + view + output.slice(end);
}

function adaptMacClient(source, asset, options = {}) {
  const record = assets[asset];
  try {
    if (!record || typeof source !== 'string' || createHash('sha256').update(source).digest('hex') !== record.hash) throw Error('Unreviewed macOS native client asset');
    let output = source;
    if (record.kind === 'recording' && options.localSpeechEnabled) {
      output = adaptRecordingClient(source, asset, options);
      // The new recorder and its native stop/drain use transport 697264.
      // Keep the shared flush implementation, pointing its wrapper at the
      // current transport rather than the former 241978 module.
      output = once(output, 'transport:i(241978)', 'transport:i(697264)');
    }
    if (record.kind === 'attachments') {
      // This asset differs from the existing reviewed consumer only by the
      // attachment converter import ID. Its original full hash is checked
      // again by the existing adapter after canonicalizing that import.
      output = documents.adaptInlineDocuments(source.replaceAll('a(296328)', 'a(917398)'), documents.assetName)
        .replace(/\b(a|nativeRequire)\(917398\)/g, '$1(296328)');
    }
    if (record.kind === 'autofill') output = autofill(source);
    parse(output, { ecmaVersion: 2024 });
    options.onAdaptation?.({ moduleId: record.moduleId, kind: record.kind, mode: 'reviewed' });
    return output;
  } catch (error) {
    if (['attachments', 'autofill'].includes(record?.kind)) error.notionSwitchKind = record.kind;
    throw error;
  }
}
module.exports = { isMacClientAsset, adaptMacClient };
