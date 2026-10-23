const { createHash } = require('node:crypto');
const reviewed = {
  '95271': ['811656', 'f2be3eb51416adf2699c8fd44fdf7cdecfb53ab21b299dbf77e57acafe74d801'],
  '96975': ['459724', '6ab3eed179a1e223dfe221d164c59774bb0b3a3a38e7e6090e2359e44c50b332'],
  '32453': ['60217', '38a7afc2235c70aebd54da1792dfcdc9c0278d3c2a58a0167a91feeef61a4329']
};
const digest = source => createHash('sha256').update(source).digest('hex');
function stableAvailability(module) {
  const aliases = /let ([A-Za-z_$][\w$]*)=\(null==\(r=\(o=e\[u\]\)\.isOverrideAllowed\)\?void 0:r\.call\(o,n\.data\)\)\?\?!0,([A-Za-z_$][\w$]*)=f\.active&&\1\?/.exec(module);
  if (!aliases || aliases[1] === aliases[2]) return false;
  // Only two local minifier bindings are canonicalized. Strings, property
  // names and object keys remain exact, as does every permission check.
  const normalized = module.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*/g, (token, at) => {
    if (token !== aliases[1] && token !== aliases[2]) return token;
    if (module[at - 1] === '.' && module.slice(at - 3, at) !== '...' || /^\s*:/.test(module.slice(at + token.length))) return token;
    return token === aliases[1] ? '$override' : '$availability';
  });
  return digest(normalized) === 'c57d5aff33b73600d5d18ac63b9afa25ca801384c04e19dcbe38c28bc24b0413';
}
// Accept a renamed/repacked official chunk only when the exact module we
// change is byte-identical. Surrounding modules are never patched or trusted
// as evidence that a changed permission/availability module is compatible.
function compatibleModule(source, asset) {
  const match = /^(95271|96975|32453)-[a-f\d]{16}\.js$/.exec(asset), expected = match && reviewed[match[1]];
  if (!expected || typeof source !== 'string' || source.length > 2 * 1024 * 1024) return false;
  const boundaries = [...source.matchAll(/(?:^|[,{])(\d+)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{/g)];
  const positions = boundaries.map((entry, index) => entry[1] === expected[0] ? index : -1).filter(index => index >= 0);
  if (positions.length !== 1) return false;
  const index = positions[0], start = boundaries[index].index + (boundaries[index][0].startsWith(expected[0]) ? 0 : 1), end = boundaries[index + 1]?.index ?? source.lastIndexOf('}]);');
  if (end <= start) return false;
  const module = source.slice(start, end);
  return digest(module) === expected[1] || match[1] === '95271' && stableAvailability(module);
}
module.exports = { compatibleModule };
