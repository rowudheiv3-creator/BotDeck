// Optional voice support. The browser is the audio device: it sends microphone / soundpad audio
// to the server as raw 48 kHz stereo s16le PCM over a WebSocket and the server relays it into the
// Discord voice connection; audio from other people in the channel travels back the same way.
// Everything here is loaded lazily so a host without the voice packages still runs the rest of the app.
import { PassThrough, pipeline } from 'node:stream';
import { config } from './config.js';

export const FRAME = 3840; // 20 ms of 48 kHz, 2 channels, 16-bit
let libPromise;

export function loadVoiceLib() {
  libPromise ||= (async () => {
    const [maj, min] = process.versions.node.split('.').map(Number);
    if (maj < 22 || (maj === 22 && min < 12)) {
      return { error: `Node ${process.versions.node} is too old for voice; it needs Node 22.12 or newer (choose a newer Node version in your host's startup settings)` };
    }
    try {
      const lib = await import('@discordjs/voice');
      const prism = (await import('prism-media')).default;
      await import('opusscript'); // pure-JS Opus encoder/decoder, no native build needed
      return { lib, prism };
    } catch (e) {
      return { error: String((e && e.message) || e).slice(0, 200) };
    }
  })();
  return libPromise;
}

export class Voice {
  constructor({ botId, sendOp, emit }) {
    Object.assign(this, { botId, sendOp, emit });
    this.clients = new Set();
    this.reset();
    this.status = 'idle';
    this.error = '';
  }

  reset() {
    this.conn = null; this.adapter = null; this.player = null; this.pcm = null;
    this.guildId = null; this.channelId = null; this.lastFrame = 0;
    this.hearing = new Set(); this.slots = new Map(); this.nextSlot = 1;
    clearInterval(this.watchdog); this.watchdog = null;
  }

  info() {
    return { status: this.status, guild: this.guildId, channel: this.channelId, error: this.error };
  }

  setStatus(status, error = '') {
    this.status = status;
    this.error = error;
    const info = this.info();
    this.emit('voice', info);
    this.json({ t: 'voice', ...info });
  }

  json(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(s);
  }

  async join(guildId, channelId) {
    const L = await loadVoiceLib();
    if (L.error) throw new Error('ระบบเสียงใช้ไม่ได้บนโฮสต์นี้ / voice is unavailable on this host: ' + L.error);
    const { joinVoiceChannel, entersState, VoiceConnectionStatus } = L.lib;
    this.leave(true);
    this.L = L;
    this.guildId = guildId;
    this.channelId = channelId;
    this.setStatus('connecting');
    const conn = joinVoiceChannel({
      channelId, guildId, group: 'botdeck', selfDeaf: false, selfMute: false,
      adapterCreator: (methods) => {
        this.adapter = methods;
        return { sendPayload: (p) => this.sendOp(p.op, p.d), destroy: () => { this.adapter = null; } };
      },
    });
    this.conn = conn;
    conn.on('error', (e) => { if (conn === this.conn) this.fail(e); });
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        if (conn === this.conn) this.leave();
      }
    });
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, config.voiceTimeout);
    } catch {
      if (conn === this.conn) this.fail(new Error('เชื่อมต่อห้องเสียงไม่สำเร็จ ตรวจสิทธิ์ Connect และว่าโฮสต์เปิด UDP ได้ / could not connect to voice: check the Connect permission and that the host allows UDP'));
      throw new Error(this.error);
    }
    if (conn !== this.conn) throw new Error('cancelled');
    this.setupAudio();
    this.setStatus('ready');
  }

  fail(e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    const conn = this.conn;
    this.reset();
    try { if (conn) conn.destroy(); } catch { /* already gone */ }
    this.setStatus('error', msg);
  }

  leave(silent = false) {
    const conn = this.conn;
    if (this.pcm) { try { this.pcm.end(); } catch { /* ignore */ } }
    if (this.player) { try { this.player.stop(true); } catch { /* ignore */ } }
    this.reset();
    try { if (conn) conn.destroy(); } catch { /* already destroyed */ }
    if (!silent) this.setStatus('idle');
  }

  destroy() {
    this.leave(true);
    for (const ws of this.clients) { try { ws.close(); } catch { /* ignore */ } }
    this.clients.clear();
  }

  /** Gateway events the voice library needs (it never opens its own gateway connection). */
  onGateway(t, d) {
    if (!this.adapter || !d || d.guild_id !== this.guildId) return;
    if (t === 'VOICE_SERVER_UPDATE') this.adapter.onVoiceServerUpdate(d);
    else if (t === 'VOICE_STATE_UPDATE' && d.user_id === this.botId) this.adapter.onVoiceStateUpdate(d);
  }

  setupAudio() {
    const { lib } = this.L;
    const { createAudioPlayer, NoSubscriberBehavior } = lib;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.player.on('error', () => { /* a bad frame must not take the process down */ });
    this.conn.subscribe(this.player);
    const rx = this.conn.receiver;
    rx.speaking.on('start', (uid) => { this.json({ t: 'speaking', id: uid, on: true }); this.hear(uid); });
    rx.speaking.on('end', (uid) => this.json({ t: 'speaking', id: uid, on: false }));
    // End the outgoing stream shortly after the browser goes quiet so the bot stops "speaking".
    this.watchdog = setInterval(() => {
      if (this.pcm && Date.now() - this.lastFrame > 400) { try { this.pcm.end(); } catch { /* ignore */ } this.pcm = null; }
    }, 100);
    this.watchdog.unref();
  }

  /** One 20 ms (or a few) of PCM from the browser. */
  push(buf) {
    if (this.status !== 'ready' || !this.player) return;
    if (!buf.length || buf.length > FRAME * 8 || buf.length % 4) return;
    const { createAudioResource, StreamType } = this.L.lib;
    if (!this.pcm || this.pcm.destroyed || this.player.state.status === 'idle') {
      this.pcm = new PassThrough();
      this.pcm.on('error', () => {});
      this.player.play(createAudioResource(this.pcm, { inputType: StreamType.Raw }));
    }
    if (this.pcm.writableLength > FRAME * 25) return; // far behind: drop rather than build latency
    this.lastFrame = Date.now();
    this.pcm.write(buf);
  }

  hear(uid) {
    if (uid === this.botId || this.hearing.has(uid) || !this.conn) return;
    if (![...this.clients].some((w) => w.listening)) return;
    const { EndBehaviorType } = this.L.lib;
    this.hearing.add(uid);
    let opus; let dec;
    try {
      opus = this.conn.receiver.subscribe(uid, { end: { behavior: EndBehaviorType.AfterSilence, duration: 500 } });
      dec = new this.L.prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    } catch { this.hearing.delete(uid); return; }
    dec.on('data', (chunk) => this.out(uid, chunk));
    pipeline(opus, dec, () => this.hearing.delete(uid));
  }

  out(uid, chunk) {
    let slot = this.slots.get(uid);
    if (!slot) {
      if (this.nextSlot > 4000) { this.slots.clear(); this.nextSlot = 1; }
      slot = this.nextSlot++;
      this.slots.set(uid, slot);
      this.json({ t: 'src', slot, id: uid });
    }
    const frame = Buffer.concat([Buffer.from([1, slot >> 8, slot & 255]), chunk]);
    for (const ws of this.clients) if (ws.listening && ws.readyState === 1 && ws.bufferedAmount < 1 << 20) ws.send(frame, { binary: true });
  }

  addClient(ws) {
    ws.listening = false;
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return this.push(Buffer.isBuffer(data) ? data : Buffer.concat(data));
      try {
        const m = JSON.parse(data.toString());
        if (m && m.t === 'listen') ws.listening = !!m.on;
      } catch { /* ignore */ }
    });
    ws.send(JSON.stringify({ t: 'hello', ...this.info() }));
  }
}
