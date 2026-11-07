import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Pure PE/file inspection: no DLL load, CUDA call, or model construction.
const root = path.resolve(import.meta.dirname, '..');
const stage = path.join(root, '.notion-switch/speech/gpu-v1/fp16-accum-v1-stage');
const manifestPath = path.join(stage, 'build-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
function assert(condition, message) { if (!condition) throw new Error(message); }
function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function writeJson(file, data) { fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); }
assert(manifest.exitCode === 0 && manifest.baselineUnchanged === true, 'Completed successful isolated build required');
assert(JSON.stringify(manifest.patches.map(patch => patch.line)) === '[84,241,471,592]', 'Unexpected patch locations');
const originalPath = path.join(root, '.notion-switch/speech/gpu-v1/ct2-sm75/build/Release/ctranslate2.dll');
const candidatePath = path.join(stage, 'Release/ctranslate2.dll');

function exportsOf(file) {
  const buffer = fs.readFileSync(file);
  assert(buffer.readUInt16LE(0) === 0x5a4d, 'Missing DOS header');
  const pe = buffer.readUInt32LE(0x3c);
  assert(buffer.readUInt32LE(pe) === 0x4550, 'Missing PE signature');
  const machine = buffer.readUInt16LE(pe + 4);
  const sectionCount = buffer.readUInt16LE(pe + 6);
  const optionalSize = buffer.readUInt16LE(pe + 20);
  const optional = pe + 24;
  assert(buffer.readUInt16LE(optional) === 0x20b && machine === 0x8664, 'Expected AMD64 PE32+ DLL');
  const directory = optional + 112;
  const exportRva = buffer.readUInt32LE(directory);
  const exportSize = buffer.readUInt32LE(directory + 4);
  const sections = Array.from({ length: sectionCount }, (_, i) => {
    const offset = optional + optionalSize + i * 40;
    return { virtualSize: buffer.readUInt32LE(offset + 8), virtualAddress: buffer.readUInt32LE(offset + 12), rawSize: buffer.readUInt32LE(offset + 16), rawOffset: buffer.readUInt32LE(offset + 20) };
  });
  function locate(rva, size = 1) {
    const section = sections.find(s => rva >= s.virtualAddress && rva + size <= s.virtualAddress + s.rawSize);
    assert(section, `Unmapped PE RVA ${rva.toString(16)} + ${size}`);
    const offset = section.rawOffset + rva - section.virtualAddress;
    assert(offset + size <= buffer.length, 'RVA exceeds file');
    return offset;
  }
  function cstring(rva) {
    const offset = locate(rva);
    const end = buffer.indexOf(0, offset);
    assert(end >= offset, 'Unterminated PE string');
    return buffer.toString('ascii', offset, end);
  }
  const exp = locate(exportRva, 40);
  const base = buffer.readUInt32LE(exp + 16);
  const functionCount = buffer.readUInt32LE(exp + 20);
  const namedCount = buffer.readUInt32LE(exp + 24);
  const funcs = locate(buffer.readUInt32LE(exp + 28), functionCount * 4);
  const nameTable = locate(buffer.readUInt32LE(exp + 32), namedCount * 4);
  const ordinalTable = locate(buffer.readUInt32LE(exp + 36), namedCount * 2);
  const records = Array.from({ length: functionCount }, (_, index) => {
    const rva = buffer.readUInt32LE(funcs + index * 4);
    const isForwarder = rva >= exportRva && rva < exportRva + exportSize;
    return { ordinal: base + index, present: rva !== 0, names: [], forwarder: isForwarder ? cstring(rva) : null };
  });
  for (let i = 0; i < namedCount; i++) {
    const index = buffer.readUInt16LE(ordinalTable + i * 2);
    assert(index < records.length, 'Named ordinal exceeds function array');
    records[index].names.push(cstring(buffer.readUInt32LE(nameTable + i * 4)));
  }
  for (const record of records) record.names.sort();
  const canonical = JSON.stringify(records);
  return { file: { path: file, bytes: buffer.length, sha256: sha(buffer) }, machine, ordinalBase: base, functionCount, namedCount, exportIdentitySha256: sha(canonical), records };
}
const original = exportsOf(originalPath);
const candidate = exportsOf(candidatePath);
const differences = [];
const length = Math.max(original.records.length, candidate.records.length);
for (let i = 0; i < length; i++) {
  if (JSON.stringify(original.records[i]) !== JSON.stringify(candidate.records[i])) differences.push({ index: i, original: original.records[i] ?? null, candidate: candidate.records[i] ?? null });
}
const sameExports = original.exportIdentitySha256 === candidate.exportIdentitySha256 && differences.length === 0;
const exportRecordsPath = path.join(stage, 'exports-original.json');
writeJson(exportRecordsPath, { dll: original.file, ordinalBase: original.ordinalBase, records: original.records });
const comparison = {
  version: 1, checkedAt: new Date().toISOString(), inspection: 'PE export tables read from bytes; DLLs never loaded',
  sameExports, originalDll: original.file, candidateDll: candidate.file,
  original: { ordinalBase: original.ordinalBase, functionCount: original.functionCount, namedCount: original.namedCount, exportIdentitySha256: original.exportIdentitySha256 },
  candidate: { ordinalBase: candidate.ordinalBase, functionCount: candidate.functionCount, namedCount: candidate.namedCount, exportIdentitySha256: candidate.exportIdentitySha256 },
  differences, canonicalOriginalExports: { path: exportRecordsPath, sha256: sha(fs.readFileSync(exportRecordsPath)) },
  excludesAddressComparison: true, reason: 'Function/data RVAs may change on relink; ABI identity compared by every ordinal, alias, presence and forwarder',
  gpuInvoked: false, modelLoaded: false,
};
const pristine = fs.readFileSync(manifest.pristineSource.path, 'utf8').split(/\r?\n/);
const patched = fs.readFileSync(manifest.patchedSource.path, 'utf8').split(/\r?\n/);
const patch = ['--- pristine/src/models/whisper.cc', '+++ private/src/models/whisper.cc'];
for (const { line } of manifest.patches) {
  const start = line - 4;
  patch.push(`@@ -${start + 1},7 +${start + 1},7 @@`);
  for (let i = start; i < start + 7; i++) {
    if (i === line - 1) patch.push(`-${pristine[i]}`, `+${patched[i]}`);
    else { assert(pristine[i] === patched[i], 'Unexpected extra source patch'); patch.push(` ${pristine[i]}`); }
  }
}
const differingLines = pristine.flatMap((line, i) => line === patched[i] ? [] : [i + 1]);
assert(pristine.length === patched.length && JSON.stringify(differingLines) === '[84,241,471,592]', 'Patch must change only four guard lines');
fs.writeFileSync(path.join(stage, 'source-patch.diff'), `${patch.join('\n')}\n`);
writeJson(path.join(stage, 'exports-comparison.json'), comparison);
console.log(JSON.stringify({ sameExports, originalDll: original.file, candidateDll: candidate.file, functionCount: original.functionCount, namedCount: original.namedCount, exportIdentitySha256: original.exportIdentitySha256, comparison: path.join(stage, 'exports-comparison.json'), sourcePatch: path.join(stage, 'source-patch.diff'), gpuInvoked: false }));
assert(sameExports, 'Export ABI differs; do not publish');
