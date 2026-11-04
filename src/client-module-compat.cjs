const { createHash } = require('node:crypto');
const { modules: macModules } = require('./compat/macos-reviewed.json');
const reviewed = {
  '95271': { '811656': { hashes: ['f2be3eb51416adf2699c8fd44fdf7cdecfb53ab21b299dbf77e57acafe74d801'] } },
  '96975': { '459724': { hashes: ['6ab3eed179a1e223dfe221d164c59774bb0b3a3a38e7e6090e2359e44c50b332'] } },
  '32453': { '60217': { hashes: ['38a7afc2235c70aebd54da1792dfcdc9c0278d3c2a58a0167a91feeef61a4329'] } },
  '17521': { '328616': { hashes: ['8899023157d4755e66eaaf959bd7d76a755505b7a938f311a8b7ad1eb0a042d7',
    '2c512d87d65969684f713de5002eb8ade82f8cdba60db1a702f5293e0d88eca8'] } },
  '89269': {
    '331787': { hashes: ['ab86f11d59a12b5741999825de7cd33993d762d8a23f13a51a93ec8e6e3ddfc2',
      'bca0ae2d158c332bb481a7756f2ac054ec4bf57bfea896ba93cf00fdbdde8dfc'], gateModuleId: 218744, transportModuleId: 241978 },
    '372201': { hashes: ['2d05e78d890a255b428410377d8a1681f908126efaef3185b36f7c360c194d56',
      'd710d066887056c7ed09f3e303774ab2d227bbb4955c2ab6658bf96fe5e72a1d'], gateModuleId: 211589, transportModuleId: 697264 }
  },
  '17048': {
    '241978': { hashes: ['ac822dea14dcffa0a1c3ae952afb9c8038ea7feb87f15d1a4d406c987e49071e'] },
    '697264': { hashes: ['858cb7eee1d5334707f03c0eb506b5e246d83c1d13df44d2bb8d6161d6cc308a'] }
  }
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
function matchModule(source, asset) {
  const match = /^(95271|96975|32453|17521|89269|17048)-[a-f\d]{16}\.js$/.exec(asset), groups = match && reviewed[match[1]];
  if (!groups || typeof source !== 'string' || source.length > 2 * 1024 * 1024) return null;
  const boundaries = [...source.matchAll(/(?:^|[,{])(\d+)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{/g)];
  const found = [];
  for (const [id, record] of Object.entries(groups)) {
    const positions = boundaries.map((entry, index) => entry[1] === id ? index : -1).filter(index => index >= 0);
    if (positions.length > 1) return null;
    if (positions.length === 1) found.push({ id, record, index: positions[0] });
  }
  if (found.length !== 1) return null;
  const { id, record, index } = found[0];
  const start = boundaries[index].index + (boundaries[index][0].startsWith(id) ? 0 : 1), end = boundaries[index + 1]?.index ?? source.lastIndexOf('}]);');
  if (end <= start) return null;
  const module = source.slice(start, end), hash = digest(module);
  if (!record.hashes.includes(hash) && macModules[id]?.moduleHash !== hash && !(id === '811656' && stableAvailability(module))) return null;
  return { moduleId: id, gateModuleId: record.gateModuleId, transportModuleId: record.transportModuleId };
}
function compatibleModule(source, asset) { return matchModule(source, asset) !== null; }
module.exports = { compatibleModule, matchModule };
