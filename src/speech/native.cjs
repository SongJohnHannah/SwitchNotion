const http = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');
const { upgrade } = require('./websocket.cjs');
const { MeetingAudioSession } = require('../meeting-audio.cjs');
const allowedOrigin = origin => { try { const u = new URL(origin); return u.protocol === 'https:' && /^(?:(?:app|www)\.)?notion\.(?:com|so)$/.test(u.hostname) && !u.port; } catch { return false; } };
class NativeSpeech {
  constructor({ speech, log = () => {}, originAllowed = allowedOrigin } = {}) {
    this.speech = speech; this.log = log; this.originAllowed = originAllowed; this.tickets = new Map(); this.connections = new Set(); this.port = null; this.transportReady = false;
    this.server = http.createServer((_req, res) => res.writeHead(404).end());
    this.server.on('upgrade', (req, socket, head) => this.connect(req, socket, head));
    this.ready = new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(); }); });
    this.ready.catch(() => {});
  }
  get endpoint() { return this.port ? `http://127.0.0.1:${this.port}` : null; }
  get enabled() { return this.speech.enabled && !!this.speech.provider.runtime; }
  async token() {
    await this.ready;
    if (!this.enabled || !this.transportReady) throw Error('本机离线语音或原生连接适配尚未准备，本次录音没有连接云端。');
    await this.speech.provider.probe();
    for (const [token, ticket] of this.tickets) if (ticket.expires < Date.now()) this.tickets.delete(token);
    if (this.tickets.size >= 64) throw Error('本机录音连接过多，请停止后重新打开速记。');
    const token = randomBytes(32).toString('hex'); this.tickets.set(token, { expires: Date.now() + 30 * 60 * 1000 }); return { accessToken: token };
  }
  connect(req, socket, head) {
    let url; try { url = new URL(req.url, this.endpoint); } catch { socket.destroy(); return; }
    const ticket = this.tickets.get(url.searchParams.get('token'));
    if (!this.enabled || !this.originAllowed(req.headers.origin) || !/^\/primus-v8\/?$/.test(url.pathname) || url.searchParams.get('transport') !== 'websocket' || url.searchParams.get('EIO') !== '4' || !ticket || ticket.expires < Date.now() || this.connections.size >= 2) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    let peer, session, heartbeat, active = false;
    const connection = { close: () => peer?.close() };
    const send = value => peer?.send('4' + JSON.stringify(value));
    const stop = () => { clearInterval(heartbeat); session?.close(); this.connections.delete(connection); };
    peer = upgrade(req, socket, head, { onClose: stop, onMessage: text => {
      if (text === '3') return;
      if (text === '1') { peer.close(); return; }
      if (!text.startsWith('4')) { peer.close(); return; }
      let input; try { input = JSON.parse(text.slice(1)); } catch { peer.close(); return; }
      if (typeof input === 'string' && input.startsWith('primus::pong::')) return;
      session.handle(input).catch(() => {
        send({ type: 'response', requestId: String(input?.requestId || ''), status: 'error', result: { message: '本机离线转写失败，录音未转发云端。' } });
        send({ type: 'openai_error', message: '本机离线语音处理失败，请停止并检测本机引擎。' });
      });
    } });
    if (!peer) return;
    session = new MeetingAudioSession({ provider: this.speech.provider, emit: send, onActivity: value => {
      if (active === value) return; active = value;
      if (value) this.speech.provider.retain(); else this.speech.provider.release();
    } });
    this.connections.add(connection);
    peer.send('0' + JSON.stringify({ sid: randomUUID(), upgrades: [], pingInterval: 20000, pingTimeout: 20000, maxPayload: 1024 * 1024 }));
    heartbeat = setInterval(() => { peer.send('2'); send('primus::ping::' + Date.now()); }, 15000); heartbeat.unref?.();
    const { provider, device, platform, architecture } = this.speech.provider.status?.() || {};
    this.log({ type: 'offline-audio-connected', provider, device, platform, architecture });
  }
  status() { return { available: !!this.port, enabled: this.enabled, transportReady: this.transportReady, connections: this.connections.size }; }
  close() { for (const c of this.connections) c.close(); this.connections.clear(); this.tickets.clear(); this.server.close(); }
}
function loopbackCsp(policy, endpoint) {
  if (!policy || !endpoint) return policy;
  const u = new URL(endpoint); if (u.hostname !== '127.0.0.1' || !u.port) throw Error('Expected loopback speech endpoint');
  const parts = policy.split(';').map(x => x.trim()).filter(Boolean), index = parts.findIndex(x => /^connect-src(?:\s|$)/.test(x));
  const origin = u.origin, websocket = 'ws://' + u.host;
  if (index >= 0) parts[index] += ` ${origin} ${websocket}`;
  else parts.push((parts.find(x => /^default-src(?:\s|$)/.test(x))?.replace(/^default-src/, 'connect-src') || "connect-src 'self'") + ` ${origin} ${websocket}`);
  return parts.join('; ');
}
module.exports = { NativeSpeech, allowedOrigin, loopbackCsp };
