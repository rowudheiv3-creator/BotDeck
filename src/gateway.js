import WebSocket from 'ws';
import { config } from './config.js';

const CLOSE_ZOMBIE = 4000;

// Close codes that retrying can never fix, with a message for the person.
export const FATAL_CLOSE = {
  4004: 'โทเคนไม่ถูกต้อง (Authentication failed)',
  4010: 'ค่า shard ไม่ถูกต้อง',
  4011: 'ต้องใช้ sharding',
  4012: 'เวอร์ชัน API ไม่ถูกต้อง',
  4013: 'ค่า intents ไม่ถูกต้อง',
  4014: 'ยังไม่ได้เปิด Privileged Intent ในหน้า Developer Portal (Bot → Privileged Gateway Intents → Message Content) ลองปิดตัวเลือก Message Content ตอนล็อกอิน หรือไปเปิดมันก่อน',
};

export const INTENTS = {
  guilds: 1 << 0,
  members: 1 << 1, // privileged
  guildMessages: 1 << 9,
  voiceStates: 1 << 7,
  guildReactions: 1 << 10,
  dms: (1 << 12) | (1 << 13),
  messageContent: 1 << 15, // privileged
};

export class Gateway {
  constructor({ token, intents, onEvent, onStatus }) {
    Object.assign(this, { token, intents, onEvent, onStatus });
    this.sessionId = null;
    this.resumeUrl = null;
    this.seq = null;
    this.stopped = false;
    this.ws = null;
    this.presence = null;
    this.wake = null;
  }

  /** Sends a raw gateway op (used by voice for the voice-state update). */
  sendOp(op, d) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ op, d }));
    return true;
  }

  /** Sets the bot's status/activity; remembered across reconnects. */
  setPresence(p) {
    this.presence = { since: null, afk: false, ...p };
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op: 3, d: this.presence }));
  }

  start() {
    this.stopped = false;
    this.#loop();
  }

  stop() {
    this.stopped = true;
    if (this.ws) this.ws.terminate();
    if (this.wake) this.wake();
  }

  async #loop() {
    let backoff = config.reconnectBase;
    while (!this.stopped) {
      const { ready, code } = await this.#session();
      if (this.stopped) return;
      if (FATAL_CLOSE[code]) {
        this.onStatus('error', FATAL_CLOSE[code]);
        return;
      }
      if (code === 4007 || code === 4009) this.sessionId = null;
      if (ready) backoff = config.reconnectBase;
      this.onStatus('connecting', '');
      await new Promise((resolve) => {
        const t = setTimeout(resolve, backoff);
        this.wake = () => { clearTimeout(t); resolve(); };
      });
      this.wake = null;
      backoff = Math.min(backoff * 2, config.maxReconnectBackoff);
    }
  }

  /** Runs one connection; resolves when it closes. */
  #session() {
    return new Promise((resolve) => {
      let ready = false;
      let acked = true;
      let finished = false;
      let first = null;
      let timer = null;
      const url = this.sessionId && this.resumeUrl ? this.resumeUrl : config.gatewayUrl;
      const ws = new WebSocket(url, { handshakeTimeout: 15000, maxPayload: 32 * 1024 * 1024 });
      this.ws = ws;
      const finish = (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(first);
        clearInterval(timer);
        resolve({ ready, code });
      };
      const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
      const beat = () => send({ op: 1, d: this.seq });
      // Close with a code that keeps the session resumable; force it if the peer stalls.
      const bounce = () => {
        ws.close(CLOSE_ZOMBIE);
        setTimeout(() => ws.terminate(), 3000).unref();
      };
      ws.on('error', () => { /* a close event always follows */ });
      ws.on('close', (code) => finish(code));
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        switch (m.op) {
          case 10: {
            const interval = m.d && m.d.heartbeat_interval > 0 ? m.d.heartbeat_interval : 41250;
            first = setTimeout(() => {
              const tick = () => {
                if (!acked) { ws.terminate(); finish(CLOSE_ZOMBIE); return; }
                acked = false;
                beat();
              };
              tick();
              timer = setInterval(tick, interval);
            }, Math.random() * interval);
            if (this.sessionId) send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
            else {
              this.seq = null;
              send({ op: 2, d: { token: this.token, intents: this.intents, ...(this.presence ? { presence: this.presence } : {}), properties: { os: process.platform, browser: 'botdeck', device: 'botdeck' } } });
            }
            break;
          }
          case 0:
            if (typeof m.s === 'number') this.seq = m.s;
            if (m.t === 'READY') {
              this.sessionId = m.d.session_id;
              this.resumeUrl = m.d.resume_gateway_url ? m.d.resume_gateway_url + config.gatewayQuery : null;
              ready = true;
              this.onStatus('ready', '');
            } else if (m.t === 'RESUMED') {
              ready = true;
              this.onStatus('ready', '');
            }
            try { this.onEvent(m.t, m.d); } catch (e) { console.error('event handler failed:', e && e.message); }
            break;
          case 1: beat(); break;
          case 7: bounce(); break;
          case 9:
            if (m.d !== true) this.sessionId = null;
            bounce();
            break;
          case 11: acked = true; break;
          default: break;
        }
      });
    });
  }
}
