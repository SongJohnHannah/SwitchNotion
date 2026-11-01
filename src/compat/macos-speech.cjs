const { createHash } = require('node:crypto');
const { parse } = require('./parser.cjs');
const { modules: reviewed, encoder } = require('./macos-speech-reviewed.json');
const { adaptRecordingClient } = require('../speech/client.cjs');
const { requestSpeechToken } = require('../speech/client-state.cjs');
const digest = value => createHash('sha256').update(value).digest('hex');
const isMacSpeechCandidate = source => typeof source === 'string' &&
  (/[,{]\s*372201\s*\(/.test(source) || /[,{]\s*(?:328616|697264)\s*\(/.test(source) && source.includes('(211589)'));

function speechModules(source) {
  if (typeof source !== 'string' || source.length > 2 * 1024 * 1024) throw Error('Unreviewed Mac speech script');
  let tokens = 0;
  const ast = parse(source, { ecmaVersion: 2024, onToken() { if (++tokens > 1000000) throw Error('Mac speech script complexity limit'); } });
  const body = ast.body[0]?.directive === 'use strict' ? ast.body.slice(1) : ast.body;
  const call = body[0]?.expression, receiver = call?.callee?.object;
  const member = node => node?.type === 'MemberExpression' && !node.computed &&
    ({ self: 'webpackChunknotion', globalThis: 'rspackChunknotion_next' })[node.object?.name] === node.property?.name;
  const assigned = receiver?.type === 'AssignmentExpression' && member(receiver.left) &&
    (receiver.operator === '||=' && receiver.right.type === 'ArrayExpression' && !receiver.right.elements.length ||
      receiver.operator === '=' && receiver.right.type === 'LogicalExpression' && receiver.right.operator === '||' && member(receiver.right.left) &&
      receiver.right.left.object.name === receiver.left.object.name && receiver.right.left.property.name === receiver.left.property.name &&
      receiver.right.right.type === 'ArrayExpression' && !receiver.right.right.elements.length);
  const chunk = call?.arguments?.[0], object = chunk?.elements?.[1];
  if (body.length !== 1 || call?.type !== 'CallExpression' || call.callee.type !== 'MemberExpression' || call.callee.computed ||
      call.callee.property.name !== 'push' || !(member(receiver) || assigned) || call.arguments.length !== 1 ||
      chunk?.type !== 'ArrayExpression' || chunk.elements.length !== 2 || object?.type !== 'ObjectExpression') throw Error('Changed Mac speech chunk registration');
  const found = [], seen = new Set();
  for (const property of object.properties) {
    const id = String(property.key?.value);
    if (property.type !== 'Property' || property.computed || property.value.type !== 'FunctionExpression' || seen.has(id)) throw Error('Ambiguous Mac speech module');
    seen.add(id);
    if (reviewed[id] || id === encoder.id) found.push({ id, start: property.start, end: property.end, body: property.value.body, source: source.slice(property.start, property.end) });
  }
  return found;
}
function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Changed Mac speech anchor');
  return source.replace(before, after);
}
function adaptMacSpeech(source, asset, options = {}) {
  if (!/^\d+-[a-f\d]{16}\.js$/.test(asset) || !isMacSpeechCandidate(source, asset)) throw Error('Unreviewed Mac speech asset');
  const modules = speechModules(source), targets = modules.filter(module => reviewed[module.id]);
  if (!targets.length) throw Error('Unreviewed Mac speech module');
  for (const module of modules) if (digest(module.source) !== (reviewed[module.id]?.hash || encoder.hash)) throw Error('Changed Mac speech module behavior');
  if (!options.localSpeechEnabled) {
    for (const module of targets) options.onAdaptation?.({ moduleId: module.id, kind: reviewed[module.id].kind, mode: 'reviewed' });
    return source;
  }
  const inputMode = options.inputMode || 'meeting';
  if (!['meeting', 'microphone'].includes(inputMode)) throw Error('Invalid Mac speech input mode');
  const changes = targets.map(module => {
    const record = reviewed[module.id]; let output = module.source;
    if (record.kind === 'audio') {
      const url = new URL(options.audioEndpoint);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw Error('Expected local audio endpoint');
      output = once(output, 'let l=`${o}?${u.toString()}`;', 'let l=' + JSON.stringify(url.origin) + '+"?"+u.toString();');
    }
    if (record.kind === 'recording') output = adaptRecordingClient(output, '89269-', { inputMode, gateModuleId: 211589, transportModuleId: 697264 });
    if (record.kind === 'connection') output = once(output, 'e.api.callApi({eventName:"getAudioProcessorAuthToken",environment:e,data:{}})',
      '(' + requestSpeechToken.toString() + ')(e,{eventName:"getAudioProcessorAuthToken",environment:e,data:{}})');
    // Preserve module-level strict mode before inserting renderer-local state.
    const first = module.body.body[0], offset = (first?.directive ? first.end : module.body.start + 1) - module.start;
    const register = `(globalThis.__notionSwitchSpeechClient??={}).${record.kind}=${JSON.stringify(record.hash)};` +
      (record.kind === 'recording' ? `globalThis.__notionSwitchSpeechClient.inputMode=${JSON.stringify(inputMode)};` : '');
    output = output.slice(0, offset) + register + output.slice(offset);
    return { ...module, output };
  });
  for (const change of changes.sort((a, b) => b.start - a.start)) source = source.slice(0, change.start) + change.output + source.slice(change.end);
  parse(source, { ecmaVersion: 2024 });
  for (const module of targets) options.onAdaptation?.({ moduleId: module.id, kind: reviewed[module.id].kind, mode: 'reviewed' });
  return source;
}
module.exports = { isMacSpeechCandidate, speechModules, adaptMacSpeech };
