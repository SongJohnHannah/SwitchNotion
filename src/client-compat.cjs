const { createHash } = require('node:crypto');
const { compatibleModule, matchModule } = require('./client-module-compat.cjs');
const { adaptRecordingClient } = require('./speech/client.cjs');
const { adaptAutomatic } = require('./compat/automatic.cjs');
const { adaptAutofill, isAutofillCandidate } = require('./compat/autofill.cjs');
const { adaptInlineDocuments, isInlineDocumentCandidate } = require('./compat/inline-documents.cjs');
// These public frontend variants were first observed on Mac. Select by the
// reviewed script bytes on both systems; native OS calls live elsewhere.
const clientVariants = require('./compat/macos-client.cjs');
const speechVariants = require('./compat/macos-speech.cjs');
// This local provider uses the native chat controls independently of Notion credits.
// Keep workspace restriction checks above this insertion. Dashboard layout is
// enabled only in this isolated desktop client; server authorization is unchanged.
// Both reviewed releases contain the same 811656 availability module.
const reviewedAssets = {
  '95271-b60a0efc9a0c9841.js': '09d2a5234723e209d284f85effa8901af5a32b8ef79ed45bdd2dd361bd9ccccc',
  '95271-38f67378ed14d977.js': 'aa4b7254388e55f1d96a469faf605be2a6795499a603e1f1a61f2bd800517b63',
  '95271-adc4a76136e50ec0.js': '42f25bad44545977b7a2c3701e2d10ac56bff334189ce4dcc56ca12c7280282f',
  '95271-3b930ea252348c71.js': '85102aa8e3204187f0ff56266dd0bff4072645535b9100b87661f9c7a48238a5',
  '96975-4c75c565bc617fbf.js': '3188c95ce2ef27304666ccd3f837ef5470c9b8189f9f493aa35cdc38b8c1e2f3',
  '32453-3994faac607efd3c.js': '7182f2549341e708950bdf1edafb99f2fdb98790d8a9b73f198a6893c63f92b5',
  '17521-084ec2bc2599898c.js': 'b2fd9db2056c98776f578bec7ea6e4c37a2866e85a9475816245ce92f685c105',
  '89269-cbd3af4d28334ce0.js': 'a4701622a9c21f45a31a575d9c4eb895585d5f1a2da88b85435bde4088e10334',
  '89269-f5f20fe25f8eec19.js': 'f0e8d0633f62e13ef3e9dc29b3de0db9f0fdc9e14141f3718490bab5c02dee29',
  '17048-31dd3b95acbe5529.js': '50dbcf4bb07f9bd2ab9c1baedfd63ba94480a2452edb38b849dfe232f35b19f2'
};
const anchor = /let [A-Za-z_$][\w$]*=\(null==\(r=\(o=e\[u\]\)\.isOverrideAllowed\)\?void 0:r\.call\(o,n\.data\)\)\?\?!0/g;
// The reviewed November 18 chunk extracts the unchanged override-expiry
// calculation into an exported helper and renames its feature binding.
const availabilityProfiles = {
  '95271-3b930ea252348c71.js': { feature: 'd', anchor: /let v=\(null==\(r=\(o=e\[d\]\)\.isOverrideAllowed\)\?void 0:r\.call\(o,n\.data\)\)\?\?!0/g }
};
// A fully reviewed page-local handshake takes precedence over the older
// generic module hash, so all recording roles register in the same renderer.
const useSpeechVariant = (source, asset, known) => speechVariants.isMacSpeechCandidate(source, asset) &&
  (!known || speechVariants.hasReviewedSpeechModule(source, asset));
function adaptClient(source, asset, { localSpeechEnabled = false, audioEndpoint, inputMode = 'meeting', onAdaptation } = {}) {
  const matched = /^(?:95271|96975|32453|17521|89269|17048)-[a-f\d]{16}\.js$/.test(asset) ? matchModule(source, asset) : null;
  if (clientVariants.isMacClientAsset(asset)) return clientVariants.adaptMacClient(source, asset, { localSpeechEnabled, audioEndpoint, inputMode, onAdaptation });
  if (useSpeechVariant(source, asset, reviewedAssets[asset] || matched))
    return speechVariants.adaptMacSpeech(source, asset, { localSpeechEnabled, audioEndpoint, inputMode, onAdaptation });
  if (isInlineDocumentCandidate(source, asset)) {
    try { return adaptInlineDocuments(source, asset, onAdaptation); }
    catch (error) { error.notionSwitchKind = 'attachments'; throw error; }
  }
  if (isAutofillCandidate(source, asset)) {
    try { return adaptAutofill(source, asset, onAdaptation); }
    catch (error) { error.notionSwitchKind = 'autofill'; throw error; }
  }
  if (reviewedAssets[asset]) {
    if (createHash('sha256').update(source).digest('hex') !== reviewedAssets[asset]) throw Error('Unreviewed native client asset');
  } else if (!matched) {
    try { return adaptAutomatic(source, asset, { localSpeechEnabled, audioEndpoint, inputMode, onAdaptation }); }
    catch { throw Error('Unreviewed native client asset'); }
  }
  if (/^(?:89269|17048)-/.test(asset)) {
    const ids = matched?.gateModuleId ? { gateModuleId: matched.gateModuleId, transportModuleId: matched.transportModuleId } : {};
    return localSpeechEnabled ? adaptRecordingClient(source, asset, { inputMode, ...ids }) : source;
  }
  if (asset.startsWith('17521-')) {
    if (!localSpeechEnabled) return source;
    let url; try { url = new URL(audioEndpoint); } catch { throw Error('Local audio endpoint unavailable'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw Error('Expected local audio endpoint');
    const target = 'let l=`${o}?${u.toString()}`;';
    if (source.split(target).length !== 2) throw Error('Unsupported native audio transport');
    return source.replace(target, 'let l=' + JSON.stringify(url.origin) + '+"?"+u.toString();');
  }
  if (asset.startsWith('96975-')) {
    const gate = 'tA=(0,n(83208).X)("agent_service_model_switching_during_chat",{disableExposureLogging:!0})';
    if (source.split(gate).length !== 2) throw Error('Unsupported native model switch module');
    return source.replace(gate, 'tA=!0');
  }
  if (asset.startsWith('32453-')) {
    const title = /title:"mystery"===e\.providerFamily\?[\s\S]*?:e\.providerDisplayName(?=\}\),items:o\.map)/g;
    if ([...source.matchAll(title)].length !== 1) throw Error('Unsupported native provider label module');
    return source.replace(title, 'title:"mystery"===e.providerFamily?"DeepSeek 官方 API":e.providerDisplayName');
  }
  const profile = availabilityProfiles[asset], feature = profile?.feature || 'u';
  const matches = [...source.matchAll(profile?.anchor || anchor)];
  if (matches.length !== 1) throw Error('Unsupported native availability module');
  const speech = localSpeechEnabled ? `if(${feature}==="ai_meeting_notes"&&n.data.space?.isTranscriptionEnabled?.()!==false)return{type:"available",limit:{type:"cumulative",total:"unlimited",current:n.data.current??0}};` : '';
  return source.replace(matches[0][0], `if(${feature}==="ai_usage")return{type:"available",limit:{type:"per_use",amount:"unlimited"}};if(${feature}==="ai_model_selection")return{type:"available",limit:{type:"none"}};if(${feature}==="dashboard_view")return{type:"available",limit:{type:"none"}};` + speech + matches[0][0]);
}
async function adaptClientAsync(source, asset, options = {}) {
  if (clientVariants.isMacClientAsset(asset)) return adaptClient(source, asset, options);
  if (useSpeechVariant(source, asset, reviewedAssets[asset] || compatibleModule(source, asset))) return adaptClient(source, asset, options);
  if (isInlineDocumentCandidate(source, asset)) return adaptClient(source, asset, options);
  if (isAutofillCandidate(source, asset)) return adaptClient(source, asset, options);
  if (reviewedAssets[asset] || compatibleModule(source, asset)) return adaptClient(source, asset, options);
  return require('./compat/background.cjs').adaptInBackground(source, asset, options);
}
module.exports = { assets: Object.keys(reviewedAssets), adaptClient, adaptClientAsync };
