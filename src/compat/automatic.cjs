const { createHash } = require('node:crypto');
const { parse } = require('./parser.cjs');
const { inspect } = require('./semantic.cjs');
const { modules: reviewed } = require('./reviewed.json');
const { modules: macModules } = require('./macos-reviewed.json');
const { stopWithAudioFlush } = require('../speech/client.cjs');
const cache = new Map(), ids = Object.keys(reviewed);
const hint = new RegExp('(?:^|[,{])\\s*(?:' + ids.join('|') + ')\\s*\\(');
const knownAsset = /^(?:95271|96975|32453|17521|89269|17048)-[a-f\d]{16}\.js$/;
const scriptAsset = /^\d+-[a-f\d]{16}\.js$/;
const digest = source => createHash('sha256').update(source).digest('hex');
const likelyTarget = (source, asset) => knownAsset.test(asset) || typeof source === 'string' && hint.test(source);

function modulesIn(source) {
  if (typeof source !== 'string' || source.length > 2 * 1024 * 1024) throw Error('Unsupported script size');
  let tokens = 0;
  const ast = parse(source, { ecmaVersion: 2024, onToken() { if (++tokens > 1000000) throw Error('Script complexity limit'); } });
  if (ast.body.length !== 2 || ast.body[0].directive !== 'use strict') throw Error('Changed chunk context');
  const member = node => node?.type === 'MemberExpression' && !node.computed &&
    ({ self: 'webpackChunknotion', globalThis: 'rspackChunknotion_next' })[node.object.name] === node.property.name;
  const emptyArray = node => node?.type === 'ArrayExpression' && !node.elements.length;
  const call = ast.body[1].expression, callee = call?.callee, receiver = callee?.object;
  const sameMember = (a, b) => member(a) && member(b) && a.object.name === b.object.name && a.property.name === b.property.name;
  const assigned = receiver?.type === 'AssignmentExpression' && member(receiver.left) &&
    (receiver.operator === '||=' && emptyArray(receiver.right) || receiver.operator === '=' && receiver.right.type === 'LogicalExpression' &&
      receiver.right.operator === '||' && sameMember(receiver.left, receiver.right.left) && emptyArray(receiver.right.right));
  const object = call?.type === 'CallExpression' && call.arguments[0]?.type === 'ArrayExpression' && call.arguments[0].elements[1];
  if (callee?.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'push' || !(member(receiver) || assigned) || object?.type !== 'ObjectExpression') throw Error('Changed chunk registration');
  const found = [], seen = new Set();
  for (const property of object.properties) {
    const id = String(property.key?.value); if (!reviewed[id]) continue;
    if (seen.has(id) || property.type !== 'Property' || property.computed || property.value.type !== 'FunctionExpression') throw Error('Ambiguous native module');
    seen.add(id); found.push({ id, start: property.start, end: property.end, source: source.slice(property.start, property.end) });
  }
  return found;
}
function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw Error('Expected local audio endpoint');
  return url.origin;
}
function edit(source, changes) {
  let last = source.length;
  for (const change of changes.sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (change.start < 0 || change.end > last || change.end < change.start) throw Error('Overlapping compatibility edits');
    source = source.slice(0, change.start) + change.text + source.slice(change.end); last = change.start;
  }
  return source;
}
function patchModule(module, id, options) {
  const record = reviewed[id], info = inspect(module);
  // The Mac release adds stop-source telemetry. Its reviewed methods keep
  // the same selectors, capture permissions and drain deadlines as before.
  if (info.fingerprint !== record.fingerprint && info.fingerprint !== macModules[id]?.fingerprint) throw Error('Changed native module behavior');
  const node = key => { const value = info.at(record.selectors[key]); if (!value?.type) throw Error('Missing native selector'); return value; };
  const sourceOf = value => module.slice(value.start - 2, value.end - 2);
  const changes = [], replace = (value, text) => changes.push({ start: value.start - 2, end: value.end - 2, text });
  const insert = (position, text) => changes.push({ start: position - 2, end: position - 2, text });
  if (record.kind === 'availability') {
    const feature = node('feature').name, context = node('context').name;
    if (!feature || !context) throw Error('Missing feature bindings');
    insert(node('insertBefore').start, `if(${feature}==="ai_usage")return{type:"available",limit:{type:"per_use",amount:"unlimited"}};if(${feature}==="ai_model_selection")return{type:"available",limit:{type:"none"}};` +
      (options.localSpeechEnabled ? `if(${feature}==="ai_meeting_notes"&&${context}.data.space?.isTranscriptionEnabled?.()!==false)return{type:"available",limit:{type:"cumulative",total:"unlimited",current:${context}.data.current??0}};` : ''));
  }
  if (record.kind === 'models') replace(node('replace'), 'true');
  if (record.kind === 'provider') replace(node('replace'), JSON.stringify('DeepSeek 官方 API'));
  if (record.kind === 'audio' && options.localSpeechEnabled) replace(node('replace'), JSON.stringify(endpoint(options.audioEndpoint)) + '+"?"+' + sourceOf(node('replace').expressions[1]));
  if (record.kind === 'recording' && options.localSpeechEnabled) {
    if (!['meeting', 'microphone'].includes(options.inputMode || 'meeting')) throw Error('Invalid recording input mode');
    const include = options.inputMode !== 'microphone', request = node('require').name;
    if (!request) throw Error('Missing native import binding');
    for (const key of ['start', 'recorder']) {
      const method = node(key), parameter = method.value.params[0];
      if (parameter?.type !== 'Identifier') throw Error('Changed recording parameters');
      insert(method.value.body.start + 1, `${parameter.name}={...${parameter.name},includeSystemAudio:${include}};`);
    }
    replace(node('drain'), 'true');
    const method = node('stop'), parameter = method.value.params[0];
    if (parameter?.type !== 'Identifier' || parameter.name === request) throw Error('Changed stop parameters');
    replace(method.key, 'stopDictationAfterLocalFlush');
    insert(method.start, `static stopDictation(${parameter.name}){return (${stopWithAudioFlush.toString()})(this,${parameter.name},{state:${request}(585823).Ay,transport:${request}(241978),send:${request}(216735).$g,encode:${request}(392719).Rk,captureStopped:()=>${request}(392719).c9({isCapturingAudio:false}),language:()=>"auto"})}`);
  }
  const patched = edit(module, changes);
  parse('({' + patched + '})', { ecmaVersion: 2024 });
  return patched;
}
function adaptAutomatic(source, asset, options = {}) {
  if (!scriptAsset.test(asset) || !likelyTarget(source, asset)) throw Error('Unreviewed native client asset');
  const modules = modulesIn(source); if (!modules.length) throw Error('Unreviewed native client asset');
  const changes = [], records = [];
  for (const module of modules) {
    const key = JSON.stringify([module.id, digest(module.source), !!options.localSpeechEnabled, options.inputMode || 'meeting', options.audioEndpoint || '']);
    if (!cache.has(key)) {
      let value; try { value = { output: patchModule(module.source, module.id, options) }; } catch { value = { failed: true }; }
      if (cache.size >= 16) cache.delete(cache.keys().next().value);
      cache.set(key, value);
    }
    const value = cache.get(key); if (value.failed) throw Error('Unreviewed native client asset');
    changes.push({ start: module.start, end: module.end, text: value.output });
    records.push({ moduleId: module.id, kind: reviewed[module.id].kind, mode: 'automatic' });
  }
  const output = edit(source, changes);
  for (const record of records) options.onAdaptation?.(record);
  return output;
}
module.exports = { adaptAutomatic, likelyTarget, modulesIn, knownAsset, scriptAsset };
