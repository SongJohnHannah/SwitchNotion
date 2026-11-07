const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const MAX = 1024 * 1024;
function frame(opcode, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data), header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  if (payload.length > 65535) { const large = Buffer.alloc(10); large[0] = 0x80 | opcode; large[1] = 127; large.writeBigUInt64BE(BigInt(payload.length), 2); return Buffer.concat([large, payload]); }
  header[0] = 0x80 | opcode; header[1] = payload.length < 126 ? payload.length : 126;
  if (header.length === 4) header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}
function upgrade(request, socket, head, { onMessage, onClose }) {
  const key = request.headers['sec-websocket-key'];
  if (request.method !== 'GET' || String(request.headers.upgrade).toLowerCase() !== 'websocket' || request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !/^[A-Za-z\d+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return null;
  }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
  socket.setNoDelay(true); let buffer = Buffer.alloc(0), fragments = [], fragmentBytes = 0, closed = false;
  const finish = () => { if (!closed) { closed = true; onClose(); } };
  const close = () => { if (closed) return; try { socket.end(frame(8, Buffer.from([3, 233]))); } catch { socket.destroy(); } finish(); };
  const send = text => { if (closed || socket.destroyed) return; if (socket.writableLength > 4 * MAX || Buffer.byteLength(text) > MAX) { close(); return; } socket.write(frame(1, text)); };
  const accept = bytes => {
    if (closed) return; buffer = Buffer.concat([buffer, bytes]);
    if (buffer.length > 2 * MAX) { close(); return; }
    while (buffer.length >= 2 && !closed) {
      const first = buffer[0], opcode = first & 15, final = !!(first & 128), masked = !!(buffer[1] & 128);
      let length = buffer[1] & 127, offset = 2;
      if (first & 112 || !masked || ![0, 1, 8, 9, 10].includes(opcode)) { close(); return; }
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; const big = buffer.readBigUInt64BE(2); if (big > BigInt(MAX)) { close(); return; } length = Number(big); offset = 10; }
      if (length > MAX || opcode >= 8 && (!final || length > 125)) { close(); return; }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4), payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode === 8) { close(); return; }
      if (opcode === 9) { socket.write(frame(10, payload)); continue; }
      if (opcode === 10) continue;
      if (opcode === 1 && fragments.length || opcode === 0 && !fragments.length) { close(); return; }
      fragments.push(payload); fragmentBytes += payload.length;
      if (fragmentBytes > MAX || fragments.length > 64) { close(); return; }
      if (!final) continue;
      let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(fragments)); } catch { close(); return; }
      fragments = []; fragmentBytes = 0;
      try { onMessage(text); } catch { close(); return; }
    }
  };
  socket.on('data', accept); socket.on('error', finish); socket.on('close', finish); socket.setTimeout(60000, close);
  if (head?.length) queueMicrotask(() => accept(head));
  return { send, close };
}
module.exports = { upgrade };
