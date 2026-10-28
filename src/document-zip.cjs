// Read bounded OOXML parts in memory. Never extract paths onto the filesystem.
const { inflateRawSync } = require('node:zlib');
const fail = () => { throw Error('Notion 附件的 ZIP 结构无效、已加密或超过解析上限。'); };
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => { for (let n = 0; n < 8; n++) i = i & 1 ? 0xedb88320 ^ i >>> 1 : i >>> 1; return i >>> 0; });
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0; }
function partName(name) {
  if (typeof name !== 'string' || !name || name.length > 512 || /[\\:\u0000-\u001f\u007f]/.test(name) || name.startsWith('/') || name.split('/').some(value => ['.', '..'].includes(value)) || name.includes('//')) fail();
  return name;
}
function readZip(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > 16 * 1024 * 1024 || bytes.readUInt32LE(0) !== 0x04034b50) fail();
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--)
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail();
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (!count || count > 2048 || count !== bytes.readUInt16LE(end + 8) || start + size !== end) fail();
  const entries = new Map(), names = new Set(), intervals = []; let total = 0, at = start;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), crc = bytes.readUInt32LE(at + 16), compressed = bytes.readUInt32LE(at + 20), length = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28), extraLength = bytes.readUInt16LE(at + 30), commentLength = bytes.readUInt16LE(at + 32), offset = bytes.readUInt32LE(at + 42);
    if (flags & ~0x080e || ![0, 8].includes(method) || at + 46 + nameLength + extraLength + commentLength > end || bytes.readUInt16LE(at + 34) || offset + 30 > start) fail();
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength);
    if (!(flags & 0x0800) && rawName.some(value => value > 127)) fail();
    let name; try { name = partName(new TextDecoder('utf-8', { fatal: true }).decode(rawName)); } catch { fail(); }
    const key = name.replace(/\/$/, '').toLowerCase(), mode = bytes.readUInt32LE(at + 38) >>> 16, kind = mode & 0xf000;
    if (names.has(key) || ![0, 0x4000, 0x8000].includes(kind) || length > 32 * 1024 * 1024 || (total += length) > 32 * 1024 * 1024) fail();
    names.add(key);
    if (bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method) fail();
    const localNameLength = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28), dataStart = offset + 30 + localNameLength + localExtra;
    if (dataStart + compressed > start || !bytes.subarray(offset + 30, offset + 30 + localNameLength).equals(rawName)) fail();
    const localCrc = bytes.readUInt32LE(offset + 14), localCompressed = bytes.readUInt32LE(offset + 18), localLength = bytes.readUInt32LE(offset + 22);
    if (flags & 8 ? [localCrc && localCrc !== crc, localCompressed && localCompressed !== compressed, localLength && localLength !== length].some(Boolean) : localCrc !== crc || localCompressed !== compressed || localLength !== length) fail();
    let dataEnd = dataStart + compressed;
    if (flags & 8) {
      if (dataEnd + 12 > start) fail();
      const descriptor = bytes.readUInt32LE(dataEnd) === 0x08074b50 ? dataEnd + 4 : dataEnd;
      if (descriptor + 12 > start || bytes.readUInt32LE(descriptor) !== crc || bytes.readUInt32LE(descriptor + 4) !== compressed || bytes.readUInt32LE(descriptor + 8) !== length) fail();
      dataEnd = descriptor + 12;
    }
    intervals.push([offset, dataEnd]);
    if (name.endsWith('/')) { if (length || compressed) fail(); }
    else entries.set(name, { dataStart, compressed, length, method, crc });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== end) fail();
  intervals.sort((a, b) => a[0] - b[0]);
  if (intervals[0][0] !== 0 || intervals.some((value, index) => index && value[0] < intervals[index - 1][1])) fail();
  const cache = new Map();
  return { names: [...entries.keys()], has: name => entries.has(name), read(name) {
    partName(name); if (!entries.has(name)) throw Error('Notion 附件缺少必要的文档部分。');
    if (cache.has(name)) return cache.get(name);
    const entry = entries.get(name); if (entry.length > 8 * 1024 * 1024) fail();
    const input = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed); let output;
    try { output = entry.method === 0 ? input : inflateRawSync(input, { maxOutputLength: Math.max(1, entry.length + 1) }); } catch { fail(); }
    if (output.length !== entry.length || crc32(output) !== entry.crc) fail();
    cache.set(name, output); return output;
  } };
}
module.exports = { readZip, crc32, partName };
