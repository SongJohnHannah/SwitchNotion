// Maintainer-only: produce fingerprints/selectors from exact reviewed public
// modules. No Notion source or account data is included in the output.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspect } from '../src/compat/semantic.cjs';
const entries = [
  ['811656', 'availability', '95271-adc4a76136e50ec0.js', 'f2be3eb51416adf2699c8fd44fdf7cdecfb53ab21b299dbf77e57acafe74d801'],
  ['459724', 'models', '96975-4c75c565bc617fbf.js', '6ab3eed179a1e223dfe221d164c59774bb0b3a3a38e7e6090e2359e44c50b332'],
  ['60217', 'provider', '32453-3994faac607efd3c.js', '38a7afc2235c70aebd54da1792dfcdc9c0278d3c2a58a0167a91feeef61a4329'],
  ['328616', 'audio', '17521-084ec2bc2599898c.js', '8899023157d4755e66eaaf959bd7d76a755505b7a938f311a8b7ad1eb0a042d7'],
  ['331787', 'recording', '89269-f5f20fe25f8eec19.js', 'bca0ae2d158c332bb481a7756f2ac054ec4bf57bfea896ba93cf00fdbdde8dfc'],
  ['241978', 'connection', '17048-31dd3b95acbe5529.js', 'ac822dea14dcffa0a1c3ae952afb9c8038ea7feb87f15d1a4d406c987e49071e']
];
const result = {};
for (const [id, kind, name, digest] of entries) {
  const source = fs.readFileSync(path.resolve('research/.public-assets', name), 'utf8');
  const boundaries = [...source.matchAll(/(?:^|[,{])(\d+)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{/g)];
  const index = boundaries.findIndex(m => m[1] === id);
  if (index < 0) throw Error('Missing reviewed module');
  const module = source.slice(boundaries[index].index + 1, boundaries[index + 1]?.index ?? source.lastIndexOf('}]);'));
  if (createHash('sha256').update(module).digest('hex') !== digest) throw Error('Reviewed module mismatch');
  const info = inspect(module), selectors = {};
  const one = predicate => { const values = info.nodes.filter(predicate); if (values.length !== 1) throw Error(kind + ': ambiguous selector (' + values.length + ')'); return values[0]; };
  const select = (key, predicate) => { const node = one(predicate); selectors[key] = info.path(node); return node; };
  if (kind === 'availability') {
    const anchor = /let [A-Za-z_$][\w$]*=\(null==\(r=\(o=e\[u\]\)\.isOverrideAllowed\)/.exec(module);
    if (!anchor) throw Error('Availability anchor missing');
    const declaration = select('insertBefore', n => n.type === 'VariableDeclaration' && n.start === anchor.index + 2);
    const initial = declaration.declarations[0].init;
    const inside = n => n.start >= initial.start && n.end <= initial.end;
    const feature = one(n => inside(n) && n.type === 'MemberExpression' && n.computed && n.property.name === 'u');
    const context = one(n => inside(n) && n.type === 'MemberExpression' && !n.computed && n.property.name === 'data' && n.object.name === 'n');
    selectors.feature = info.path(feature.property); selectors.context = info.path(context.object);
  }
  if (kind === 'models') select('replace', n => n.type === 'CallExpression' && n.arguments[0]?.value === 'agent_service_model_switching_during_chat');
  if (kind === 'provider') {
    const title = one(n => n.type === 'Property' && n.key.name === 'title' && n.value.type === 'ConditionalExpression' && n.value.test.left?.value === 'mystery');
    selectors.replace = info.path(title.value.consequent);
  }
  if (kind === 'audio') select('replace', n => n.type === 'TemplateLiteral' && module.slice(n.start - 2, n.end - 2) === '`${o}?${u.toString()}`');
  if (kind === 'recording') {
    for (const [key, method] of [['start', 'startDictation'], ['recorder', 'getDictationAudioRecorder'], ['stop', 'stopDictation']]) {
      select(key, n => n.type === 'MethodDefinition' && n.static && n.key.name === method);
    }
    selectors.require = info.path(info.ast.body[0].expression.properties[0].value.params[2]);
    const drain = one(n => n.type === 'Property' && n.key.name === 'transcriptionDrainEnabled');
    selectors.drain = info.path(drain.value);
  }
  result[id] = { kind, fingerprint: info.fingerprint, selectors };
  console.log(JSON.stringify({ id, kind, fingerprint: info.fingerprint, selectors: Object.keys(selectors) }));
}
fs.writeFileSync(path.resolve('src/compat/reviewed.json'), JSON.stringify({ schema: 1, modules: result }, null, 2) + '\n');
