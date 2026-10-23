import fs from './native-fs.mjs';
import crypto from 'node:crypto';

export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function readArchive(bytes) {
  const headerSize = bytes.readUInt32LE(4), jsonSize = bytes.readUInt32LE(12);
  if (jsonSize > 16 * 1024 * 1024 || headerSize < jsonSize || headerSize + 8 > bytes.length) throw new Error('Invalid ASAR archive');
  const header = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString());
  const data = bytes.subarray(headerSize + 8);
  const entry = name => name.split('/').reduce((node, part) => node.files?.[part], header);
  const read = name => {
    const e = entry(name);
    if (!e || e.unpacked || e.link) throw new Error(`Not a packed file: ${name}`);
    return data.subarray(Number(e.offset), Number(e.offset) + e.size);
  };
  return { header, data, entry, read };
}

export function prependToEntry(original, filename, prefix) {
  const archive = readArchive(original);
  const patched = Buffer.concat([Buffer.from(prefix), archive.read(filename)]);
  const entry = archive.entry(filename);
  entry.offset = String(archive.data.length);
  entry.size = patched.length;
  if (entry.integrity) {
    const blockSize = entry.integrity.blockSize || 4194304;
    const blocks = [];
    for (let at = 0; at < patched.length; at += blockSize) blocks.push(sha256(patched.subarray(at, at + blockSize)));
    entry.integrity = { algorithm: 'SHA256', hash: sha256(patched), blockSize, blocks };
  }
  const json = Buffer.from(JSON.stringify(archive.header));
  const payloadSize = Math.ceil((4 + json.length) / 4) * 4;
  const pickle = Buffer.alloc(4 + payloadSize);
  pickle.writeUInt32LE(payloadSize, 0);
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(pickle.length, 4);
  return Buffer.concat([size, pickle, archive.data, patched]);
}

export function assertSourceUnchanged(filename, hash) {
  if (sha256(fs.readFileSync(filename)) !== hash) throw new Error('Original installation changed during preparation');
}
