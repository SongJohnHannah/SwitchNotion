const { createHash } = require('node:crypto');
const { parse } = require('./parser.cjs');
const { adaptRecordingClient } = require('../speech/client.cjs');
const documents = require('./inline-documents.cjs');
const { pollNativeAutofill, invokeLiteAutofill, captureViewSnapshot } = require('./autofill.cjs');

// Exact public assets observed in the macOS client on 2026-10-28/30. This
// adapter is dispatched only on Darwin; the existing Windows adapters stay
// on their original path. Unknown bytes must still fail closed.
const assets = Object.freeze({
  '17048-b38a7b8f431620b1.js': { kind: 'connection', moduleId: '697264', hash: 'bae8613c7c95b7983ea804f88fe527b50c780c9424734464555266917b134201' },
  // Preserve the rollout's caller-supplied OpenMoss capability flag.
  '17048-1137957f6d84ddda.js': { kind: 'connection', moduleId: '697264', hash: 'b5b2079e5acb49b02659e6e91ffd2a5dfe2c56d838ffc1ab0b45c7cb7088997e' },
  // 2026-10-30: preserve OpenMoss bootstrap gating and packet-write tracking.
  // The local server declines that optional capability; PCM/drain are unchanged.
  '17048-5a213f6060eb4398.js': { kind: 'connection', moduleId: '697264', hash: '92b908e1d162dad3a9380b92d28b2f7cc92563a8e6eb4c5052d2d3bd4beac257' },
  '89269-451ea294ba9323c0.js': { kind: 'recording', moduleId: '331787', hash: '5501272ae32976cf9515d2672f46e21582bf4ed6162c679630989cbd2c200446' },
  // Later rollout only reordered lazy chunk dependencies in neighbouring
  // modules; recorder 331787 and audio recorder 392719 are byte-identical.
  '89269-d6dd7560b2d4cf66.js': { kind: 'recording', moduleId: '331787', hash: '5bfadbd1b22d5d247291c517ac901c9c2faa8828216837b25535fda65a25868c' },
  // 2026-10-29: only neighbouring lazy dependencies changed again;
  // recorder 331787 and audio recorder 392719 remain byte-identical.
  '89269-0cf389326d6293f8.js': { kind: 'recording', moduleId: '331787', hash: '9a18a183638d988a699ef90715f1310c858636c3ac4da63f65413fa0794b1fa7' },
  // Recorder/encoder are unchanged; adjacent modules update lazy chunks
  // and the ordinary native file-upload import.
  '89269-273e8b8f54972a92.js': { kind: 'recording', moduleId: '331787', hash: '3c60fccc780c525bc8b51667f823223b7e225352dd79c332c3872c260fe94585' },
  // New recorder import, speaker diagnostics and caller-supplied OpenMoss
  // capability remain intact. Capture and stop/drain anchors are unchanged.
  '89269-53f38642561a101b.js': { kind: 'recording', moduleId: '331787', hash: 'a9bc865fb9c3bb8bbadd76034226338cb033d2b4ac2e59cf27d812508fa62eb4' },
  '51103-1249b090dd731220.js': { kind: 'attachments', moduleId: '175529', hash: '390857956053ace5c09b2f9c65ace352363d3244126a8f5a61a2b9c1dd997abb' },
  '51103-ac42935fe4417d27.js': { kind: 'attachments', moduleId: '175529', uploadModule: '939261', hash: 'f578c989a7e27f8edb0ef487f9e627e7f29108ff1f925e1fa1dd46d84bd74bbf' },
  '57590-3242f968a3670cd0.js': { kind: 'autofill', moduleId: '414741', hash: '1735c0788b8c9c9359b0034a3ca1bfd6d26194eacafd8c89cda0e3fb45152113' },
  // The view producer only renames an import; retain the neighbouring
  // instruction fallback and shared status/permission behavior unchanged.
  '57590-160e036019c0fda3.js': { kind: 'autofill', moduleId: '414741', hash: '304f2d8639a6ed6601a3fcdbf27ee14e209d1684cdc37dc2ef3cf3d9ea880983' }
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
      // attachment converter and ordinary upload import IDs. Its original
      // full hash is checked again after canonicalizing those imports.
      const canonical = record.uploadModule ? source.replaceAll('a(' + record.uploadModule + ')', 'a(401558)') : source;
      output = documents.adaptInlineDocuments(canonical.replaceAll('a(296328)', 'a(917398)'), documents.assetName)
        .replace(/\b(a|nativeRequire)\(917398\)/g, '$1(296328)');
      if (record.uploadModule) output = output.replaceAll('a(401558)', 'a(' + record.uploadModule + ')');
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
