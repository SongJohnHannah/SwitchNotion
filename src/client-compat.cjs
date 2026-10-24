const { createHash } = require('node:crypto');
const { compatibleModule } = require('./client-module-compat.cjs');
// This local provider uses the native chat controls independently of Notion credits.
// Keep workspace restriction checks above this insertion, and all other features intact.
// Both reviewed releases contain the same 811656 availability module.
const reviewedAssets = {
  '95271-b60a0efc9a0c9841.js': '09d2a5234723e209d284f85effa8901af5a32b8ef79ed45bdd2dd361bd9ccccc',
  '95271-38f67378ed14d977.js': 'aa4b7254388e55f1d96a469faf605be2a6795499a603e1f1a61f2bd800517b63',
  '95271-adc4a76136e50ec0.js': '42f25bad44545977b7a2c3701e2d10ac56bff334189ce4dcc56ca12c7280282f',
  '96975-4c75c565bc617fbf.js': '3188c95ce2ef27304666ccd3f837ef5470c9b8189f9f493aa35cdc38b8c1e2f3',
  '32453-3994faac607efd3c.js': '7182f2549341e708950bdf1edafb99f2fdb98790d8a9b73f198a6893c63f92b5',
  '17521-084ec2bc2599898c.js': 'b2fd9db2056c98776f578bec7ea6e4c37a2866e85a9475816245ce92f685c105'
};
const anchor = /let [A-Za-z_$][\w$]*=\(null==\(r=\(o=e\[u\]\)\.isOverrideAllowed\)\?void 0:r\.call\(o,n\.data\)\)\?\?!0/g;
function adaptClient(source, asset, { localSpeechEnabled = false, audioEndpoint } = {}) {
  if (reviewedAssets[asset] ? createHash('sha256').update(source).digest('hex') !== reviewedAssets[asset] : !compatibleModule(source, asset)) throw Error('Unreviewed native client asset');
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
  const matches = [...source.matchAll(anchor)];
  if (matches.length !== 1) throw Error('Unsupported native availability module');
  const speech = localSpeechEnabled ? 'if(u==="ai_meeting_notes"&&n.data.space?.isTranscriptionEnabled?.()!==false)return{type:"available",limit:{type:"cumulative",total:"unlimited",current:n.data.current??0}};' : '';
  return source.replace(matches[0][0], 'if(u==="ai_usage")return{type:"available",limit:{type:"per_use",amount:"unlimited"}};if(u==="ai_model_selection")return{type:"available",limit:{type:"none"}};' + speech + matches[0][0]);
}
module.exports = { assets: Object.keys(reviewedAssets), adaptClient };
