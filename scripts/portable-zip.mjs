import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
// Small release archives only. Preserve Unix executable modes even when built
// on Windows; never include links or paths outside the selected source tree.
export function zipDirectory({ directory, output, executable = name => /\.command$|\.sh$|\/Contents\/MacOS\//.test(name) }) {
  const files = [];
  function visit(current) { for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(current, item.name);
    if (item.isSymbolicLink()) throw Error('分发文件夹含链接，未生成 ZIP。');
    if (item.isDirectory()) visit(file); else if (item.isFile()) files.push(file);
  } }
  visit(directory);
  if (files.length > 65535) throw Error('分发文件过多。');
  let offset = 0; const local = [], central = [];
  for (const file of files) {
    const name = path.basename(directory) + '/' + path.relative(directory, file).replaceAll('\\', '/');
    if (name.split('/').some(part => part === '..')) throw Error('无效分发路径。');
    const label = Buffer.from(name), bytes = fs.readFileSync(file), compressed = deflateRawSync(bytes), crc = crc32(bytes);
    if (bytes.length > 32 * 1024 * 1024 || offset > 256 * 1024 * 1024) throw Error('分发包超过小型 ZIP 大小限制。');
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x800, 6); head.writeUInt16LE(8, 8); head.writeUInt16LE(33, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(compressed.length, 18); head.writeUInt32LE(bytes.length, 22); head.writeUInt16LE(label.length, 26);
    local.push(head, label, compressed);
    const row = Buffer.alloc(46); row.writeUInt32LE(0x02014b50); row.writeUInt16LE(0x314, 4); row.writeUInt16LE(20, 6);
    row.writeUInt16LE(0x800, 8); row.writeUInt16LE(8, 10); row.writeUInt16LE(33, 14); row.writeUInt32LE(crc, 16);
    row.writeUInt32LE(compressed.length, 20); row.writeUInt32LE(bytes.length, 24); row.writeUInt16LE(label.length, 28);
    row.writeUInt32LE(((executable(name) ? 0o100755 : 0o100644) << 16) >>> 0, 38); row.writeUInt32LE(offset, 42);
    central.push(row, label); offset += head.length + label.length + compressed.length;
  }
  const table = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(table.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(output, Buffer.concat([...local, table, end]));
  return { fileCount: files.length, bytes: fs.statSync(output).size };
}
