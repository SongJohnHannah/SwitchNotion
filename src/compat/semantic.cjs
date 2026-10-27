const { createHash } = require('node:crypto');
const { parse, analyze } = require('./parser.cjs');
const ignored = new Set(['start', 'end', 'loc', 'range', 'raw']);
const staticName = (parent, key) => !parent?.computed && (key === 'property' && /MemberExpression/.test(parent.type) ||
  key === 'key' && ['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent.type));

// Parse only; never execute a downloaded module. Identifiers resolve to their
// actual declarations, so shadowing/capture changes cannot pass as renaming.
function inspect(module) {
  if (typeof module !== 'string' || module.length > 512 * 1024) throw Error('Module size limit');
  let tokens = 0;
  const ast = parse('({' + module + '})', { ecmaVersion: 2024, sourceType: 'module', ranges: true,
    onToken() { if (++tokens > 300000) throw Error('Module complexity limit'); } });
  const paths = new WeakMap(), nodes = []; let count = 0;
  function index(value, path) {
    if (!value || typeof value !== 'object') return;
    if (++count > 400000) throw Error('Module complexity limit');
    paths.set(value, path);
    if (value.type) nodes.push(value);
    if (value.type === 'WithStatement' || value.type === 'CallExpression' && value.callee.type === 'Identifier' && value.callee.name === 'eval') throw Error('Dynamic binding is unsupported');
    for (const key of Object.keys(value)) if (!ignored.has(key)) index(value[key], path.concat(key));
  }
  index(ast, []);
  const manager = analyze(ast, { ecmaVersion: 2024, sourceType: 'module', optimistic: false, ignoreEval: false });
  const bindings = new WeakMap();
  for (const scope of manager.scopes) for (const variable of scope.variables) {
    const first = variable.identifiers[0];
    if (!first && variable.name !== 'arguments') throw Error('Unknown implicit binding');
    const id = JSON.stringify([paths.get(scope.block), scope.type, first ? paths.get(first) : 'implicitArguments']);
    for (const node of variable.identifiers) bindings.set(node, id);
    for (const reference of variable.references) bindings.set(reference.identifier, id);
  }
  const hash = createHash('sha256');
  function write(value, parent, key) {
    if (value === null || typeof value !== 'object') { hash.update(typeof value === 'bigint' ? 'bigint:' + value : JSON.stringify(value) ?? 'undefined'); return; }
    if (value.type === 'Identifier') {
      hash.update(JSON.stringify(['Identifier', staticName(parent, key) ? ['property', value.name] : bindings.has(value) ? ['binding', bindings.get(value)] : ['global', value.name]])); return;
    }
    hash.update(Array.isArray(value) ? '[' : '{');
    for (const field of Object.keys(value).filter(k => !ignored.has(k)).sort()) { hash.update(JSON.stringify(field) + ':'); write(value[field], value, field); hash.update(','); }
    hash.update(Array.isArray(value) ? ']' : '}');
  }
  write(ast, null, '');
  const at = path => path.reduce((node, key) => node?.[key], ast);
  return { ast, nodes, path: node => paths.get(node), at, bindings, fingerprint: hash.digest('hex'), tokens };
}
module.exports = { inspect, staticName };
