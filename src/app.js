import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Busboy from 'busboy';
import { Discord, apiError, sanitizeErr } from './discord.js';
import { Gateway, INTENTS } from './gateway.js';
import { Store } from './store.js';
import { cleanEmbeds } from './embeds.js';
import { isSnowflake } from './config.js';
import { Gate, loginPage } from './gate.js';
import { Voice, loadVoiceLib } from './voice.js';
import { WebSocketServer } from 'ws';
import { installAdmin } from './admin.js';

const indexHtml = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)));
const BASE = '/app/';
const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_FILES = 10;
const CUSTOM_EMOJI = /^[A-Za-z0-9_]{2,32}:[0-9]{1,20}$/;
const ALLOWED_MENTIONS = { parse: ['users', 'roles'], replied_user: true };

const validEmoji = (e) => {
  if (typeof e !== 'string') return false;
  if (CUSTOM_EMOJI.test(e)) return true;
  const n = [...e].length;
  return n >= 1 && n <= 16 && !/[/?#%\\:"]/.test(e);
};

const CSP = "default-src 'self'; img-src 'self' data: https://cdn.discordapp.com https://media.discordapp.net https://images-ext-1.discordapp.net; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const parseJson = (buf) => { try { const v = JSON.parse(buf.toString()); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function safeName(n) {
  n = String(n || '').replace(/\\/g, '/').split('/').pop();
  n = [...n].map((c) => (c.charCodeAt(0) < 32 || c === '"' ? '_' : c)).join('');
  return !n || n === '.' || n === '..' ? 'file' : n;
}

export class App {
  constructor({ password, allowHttp = false } = {}) {
    this.gate = new Gate({ password, allowHttp });
    this.store = new Store();
    this.status = 'idle';
    this.errMsg = '';
    this.dc = null;
    this.gw = null;
    this.gen = 0;
    this.clients = new Set();
    this.routes = new Map();
    const post = (name, fn) => this.routes.set(`POST ${name}`, fn);
    const get = (name, fn) => this.routes.set(`GET ${name}`, fn);
    get('state', (ctx) => this.getState(ctx));
    get('events', (ctx) => this.events(ctx));
    get('messages', (ctx) => this.messages(ctx));
    get('members', (ctx) => this.members(ctx));
    get('reactors', (ctx) => this.reactors(ctx));
    get('profile', (ctx) => this.profile(ctx));
    get('perms', (ctx) => this.myPerms(ctx));
    post('member', (ctx) => this.memberAction(ctx));
    post('guild/edit', (ctx) => this.guildEdit(ctx));
    post('role/save', (ctx) => this.roleSave(ctx));
    post('role/delete', (ctx) => this.roleDelete(ctx));
    post('channel/create', (ctx) => this.channelCreate(ctx));
    post('channel/edit', (ctx) => this.channelEdit(ctx));
    post('channel/delete', (ctx) => this.channelDelete(ctx));
    post('purge', (ctx) => this.purge(ctx));
    post('invite', (ctx) => this.invite(ctx));
    get('pins', (ctx) => this.pins(ctx));
    post('pin', (ctx) => this.pin(ctx));
    post('login', (ctx) => this.login(ctx));
    post('logout', (ctx) => this.logout(ctx));
    post('quit', (ctx) => this.logout(ctx));
    post('send', (ctx) => this.send(ctx));
    post('delete', (ctx) => this.deleteMsg(ctx));
    post('edit', (ctx) => this.edit(ctx));
    post('react', (ctx) => this.react(ctx));
    post('typing', (ctx) => this.typing(ctx));
    post('presence', (ctx) => this.setPresence(ctx));
    post('voice/join', (ctx) => this.voiceJoin(ctx));
    post('voice/leave', (ctx) => this.voiceLeave(ctx));
    get('soundboard', (ctx) => this.soundboard(ctx));
    post('soundboard/play', (ctx) => this.soundboardPlay(ctx));
    post('dm', (ctx) => this.openDM(ctx));
    post('upload', (ctx) => this.upload(ctx));
  }

  // ---- plumbing ----
  emit(t, d) {
    const line = `data: ${JSON.stringify({ t, d })}\n\n`;
    for (const res of this.clients) {
      if (res.writableLength > 1 << 20) { this.clients.delete(res); res.end(); continue; }
      res.write(line);
    }
  }

  setStatus(gen, status, msg) {
    if (gen !== this.gen) return;
    this.status = status;
    this.errMsg = msg;
    this.emit('status', { status, error: msg });
  }

  stop() {
    if (this.voice) this.voice.destroy();
    this.voice = null;
    if (this.gw) this.gw.stop();
    this.gw = null;
    this.dc = null;
  }

  client() {
    if (!this.dc) throw new HttpError(401, 'ยังไม่ได้ล็อกอิน');
    return this.dc;
  }

  /** Starts a bot session. Used by the login endpoint and by BOTDECK_TOKEN at boot. */
  async connect(rawToken, { messageContent = false, members = false } = {}) {
    const token = String(rawToken || '').trim().replace(/^Bot\s+/i, '').trim();
    if (token.length < 20 || token.length > 200 || /[\s"]/.test(token)) throw new HttpError(400, 'รูปแบบโทเคนไม่ถูกต้อง');
    const dc = new Discord(token);
    let res;
    try {
      res = await dc.do('GET', '/users/@me');
    } catch (e) {
      throw new HttpError(502, 'เชื่อมต่อ Discord ไม่ได้: ' + sanitizeErr(e, token));
    }
    if (res.status !== 200) throw new HttpError(res.status === 401 ? 401 : res.status, apiError(res.status, res.body));
    let me;
    try { me = JSON.parse(res.body.toString()); } catch { me = null; }
    if (!me || !me.id) throw new HttpError(502, 'ข้อมูลจาก Discord ผิดรูปแบบ');

    this.stop();
    const gen = ++this.gen;
    this.dc = dc;
    this.status = 'connecting';
    this.errMsg = '';
    this.store.reset(me);
    let intents = INTENTS.voiceStates | INTENTS.guilds | INTENTS.guildMessages | INTENTS.guildReactions | INTENTS.dms;
    if (messageContent) intents |= INTENTS.messageContent;
    if (members) intents |= INTENTS.members;
    this.gw = new Gateway({
      token,
      intents,
      onEvent: (t, d) => {
        if (gen !== this.gen) return;
        if (t === 'VOICE_STATE_UPDATE' || t === 'VOICE_SERVER_UPDATE') { if (this.voice) this.voice.onGateway(t, d); }
        if (this.store.apply(t, d)) this.emit('state', null);
        if (['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE', 'TYPING_START'].includes(t)) this.emit(t, d);
      },
      onStatus: (s, m) => this.setStatus(gen, s, m),
    });
    this.voice = new Voice({ botId: me.id, sendOp: (op, data) => this.gw && this.gw.sendOp(op, data), emit: (t, d) => { if (gen === this.gen) this.emit(t, d); } });
    this.gw.start();
    this.emit('status', { status: 'connecting', error: '' });
  }

  // ---- http entry ----
  handler() {
    return async (req, res) => {
      try {
        await this.dispatch(req, res);
      } catch (e) {
        if (res.headersSent) { res.end(); return; }
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error('request failed:', e && e.message);
        this.json(res, status, { error: e instanceof HttpError ? e.message : 'internal error' });
      }
    };
  }

  json(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  async dispatch(req, res) {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const path = url.pathname;

    if (path === '/login') {
      if (req.method !== 'POST') { res.writeHead(303, { Location: '/' }); return res.end(); }
      const body = await readBody(req, 4096);
      const password = new URLSearchParams(body.toString()).get('password');
      const r = this.gate.login(req, password);
      if (r.status === 303) { res.writeHead(303, { Location: BASE, 'Set-Cookie': r.cookie }); return res.end(); }
      res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginPage(r.error));
    }
    if (path === '/logout' && req.method === 'POST') {
      this.gate.logout(req);
      res.writeHead(303, { Location: '/', 'Set-Cookie': 'bd_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' });
      return res.end();
    }
    if (path === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (path === '/') {
      if (this.gate.valid(req)) { res.writeHead(303, { Location: BASE }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginPage());
    }
    if (!path.startsWith(BASE)) { res.writeHead(404); return res.end('not found'); }
    if (!this.gate.valid(req)) {
      if (path === BASE) { res.writeHead(303, { Location: '/' }); return res.end(); }
      return this.json(res, 401, { error: 'unauthorized' });
    }
    if (path === BASE) {
      if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(indexHtml);
    }
    const name = path.slice(BASE.length + 4); // after "api/"
    const route = path.startsWith(BASE + 'api/') ? this.routes.get(`${req.method} ${name}`) : null;
    if (!route) return this.json(res, 404, { error: 'not found' });
    // POST needs a custom header, which other websites cannot send cross-origin.
    if (req.method === 'POST' && req.headers['x-bd'] !== '1') return this.json(res, 403, { error: 'forbidden' });
    // Defence in depth: browsers tell us when a request comes from another site.
    const site = req.headers['sec-fetch-site'];
    if (req.method === 'POST' && site && site !== 'same-origin' && site !== 'none') return this.json(res, 403, { error: 'forbidden' });
    await route({ req, res, url });
  }

  // ---- handlers ----
  async getState({ res }) {
    const L = await loadVoiceLib();
    this.json(res, 200, { status: this.status, error: this.errMsg, snapshot: this.store.snapshot(), voice: this.voice ? this.voice.info() : null, voiceAvailable: !L.error, voiceReason: L.error || '' });
  }

  events({ req, res }) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': hi\n\n');
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }

  async login({ req, res }) {
    const b = await readJson(req);
    await this.connect(b.token, { messageContent: !!b.messageContent, members: !!b.members });
    this.json(res, 200, { ok: 'connecting' });
  }

  logout({ res }) {
    this.stop();
    this.gen++;
    this.status = 'idle';
    this.errMsg = '';
    this.store.reset({});
    this.emit('status', { status: 'idle', error: '' });
    this.json(res, 200, { ok: 'bye' });
  }

  /** Passes a Discord answer to the page: bodies pass through, errors get a short message. */
  async relay(res, dc, promise) {
    let r;
    try { r = await promise; } catch (e) { throw new HttpError(502, sanitizeErr(e, dc.token)); }
    if (r.status < 200 || r.status > 299) throw new HttpError(r.status, apiError(r.status, r.body));
    if (!r.body.toString().trim()) return this.json(res, 200, { ok: 'done' });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(r.body);
  }

  async messages({ res, url }) {
    const dc = this.client();
    const ch = url.searchParams.get('channel') || '';
    const before = url.searchParams.get('before') || '';
    if (!isSnowflake(ch) || (before && !isSnowflake(before))) throw new HttpError(400, 'bad id');
    await this.relay(res, dc, dc.do('GET', `/channels/${ch}/messages?limit=50${before ? `&before=${before}` : ''}`));
  }

  async send({ req, res }) {
    const dc = this.client();
    const b = await readJson(req);
    const content = typeof b.content === 'string' ? b.content : '';
    if (!isSnowflake(b.channel) || (b.replyTo && !isSnowflake(b.replyTo))) throw new HttpError(400, 'bad request');
    const { embeds, error } = cleanEmbeds(b.embeds);
    if (error) throw new HttpError(400, error);
    if ([...content].length > 2000 || (!content.trim() && !embeds.length)) throw new HttpError(400, 'ข้อความต้องมี 1–2000 ตัวอักษร');
    const json = { content, allowed_mentions: ALLOWED_MENTIONS };
    if (embeds.length) json.embeds = embeds;
    if (b.replyTo) json.message_reference = { message_id: b.replyTo, fail_if_not_exists: false };
    const r = await dc.do('POST', `/channels/${b.channel}/messages`, { json }).catch((e) => { throw new HttpError(502, sanitizeErr(e, dc.token)); });
    if (r.status !== 200) throw new HttpError(r.status, apiError(r.status, r.body));
    this.json(res, 200, { ok: 'sent' });
  }

  async deleteMsg({ req, res }) {
    const dc = this.client();
    const b = await readJson(req);
    if (!isSnowflake(b.channel) || !isSnowflake(b.id)) throw new HttpError(400, 'bad request');
    const r = await dc.do('DELETE', `/channels/${b.channel}/messages/${b.id}`).catch((e) => { throw new HttpError(502, sanitizeErr(e, dc.token)); });
    if (r.status !== 204 && r.status !== 200) throw new HttpError(r.status, apiError(r.status, r.body));
    this.json(res, 200, { ok: 'deleted' });
  }

  async edit({ req, res }) {
    const dc = this.client();
    const b = await readJson(req);
    if (!isSnowflake(b.channel) || !isSnowflake(b.id) || typeof b.content !== 'string' || !b.content.trim() || [...b.content].length > 2000) throw new HttpError(400, 'bad request');
    await this.relay(res, dc, dc.do('PATCH', `/channels/${b.channel}/messages/${b.id}`, { json: { content: b.content } }));
  }

  async react({ req, res }) {
    const dc = this.client();
    const b = await readJson(req);
    if (!isSnowflake(b.channel) || !isSnowflake(b.id) || !validEmoji(b.emoji)) throw new HttpError(400, 'bad request');
    const type = b.burst ? '?type=1' : ''; // 1 = super reaction
    await this.relay(res, dc, dc.do(b.on ? 'PUT' : 'DELETE', `/channels/${b.channel}/messages/${b.id}/reactions/${encodeURIComponent(b.emoji)}/@me${type}`));
  }

  // ---- voice ----
  async voiceJoin({ req, res }) {
    this.client();
    const b = await readJson(req);
    if (!isSnowflake(b.guild) || !isSnowflake(b.channel)) throw new HttpError(400, 'bad request');
    const ch = this.store.guilds.get(b.guild) && this.store.guilds.get(b.guild).channels.get(b.channel);
    if (!ch || (ch.type !== 2 && ch.type !== 13)) throw new HttpError(400, 'ไม่ใช่ห้องเสียง / not a voice channel');
    if (!this.voice) throw new HttpError(409, 'ยังไม่เชื่อมต่อ');
    try { await this.voice.join(b.guild, b.channel); } catch (e) { throw new HttpError(502, String((e && e.message) || e)); }
    this.json(res, 200, this.voice.info());
  }

  async voiceLeave({ res }) {
    this.client();
    if (this.voice) this.voice.leave();
    this.json(res, 200, { ok: true });
  }

  /** Browser audio socket: same-origin, signed-in browsers only. */
  attach(server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
    server.on('upgrade', (req, socket, head) => {
      let ok = false;
      try {
        const origin = req.headers.origin ? new URL(req.headers.origin).host : '';
        ok = new URL(req.url, 'http://x').pathname === BASE + 'api/voice' && this.gate.valid(req) && !!origin && origin === req.headers.host && !!this.voice;
      } catch { ok = false; }
      if (!ok) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => this.voice.addClient(ws));
    });
  }

  /** Server soundboard sounds (the bot must be in the voice channel to play one). */
  async soundboard({ res, url }) {
    const dc = this.client();
    const g = url.searchParams.get('guild') || '';
    if (!isSnowflake(g)) throw new HttpError(400, 'bad id');
    await this.relay(res, dc, dc.do('GET', `/guilds/${g}/soundboard-sounds`));
  }

  async soundboardPlay({ req, res }) {
    const dc = this.client();
    const b = await readJson(req);
    if (!isSnowflake(b.channel) || !isSnowflake(b.sound) || (b.source && !isSnowflake(b.source))) throw new HttpError(400, 'bad request');
    const json = { sound_id: b.sound };
    if (b.source) json.source_guild_id = b.source;
    await this.relay(res, dc, dc.do('POST', `/channels/${b.channel}/send-soundboard-sound`, { json }));
  }

  /** Bot status (online/idle/dnd/invisible) and an optional "Playing/Watching/…" line. */
  async setPresence({ req, res }) {
    this.client();
    const b = await readJson(req);
    const status = ['online', 'idle', 'dnd', 'invisible'].includes(b.status) ? b.status : 'online';
    const text = String(b.text || '').slice(0, 128);
    const type = [0, 2, 3, 5].includes(b.type) ? b.type : 0;
    const activities = text ? [{ name: text, type }] : [];
    if (!this.gw) throw new HttpError(409, 'ยังไม่เชื่อมต่อ');
    this.gw.setPresence({ status, activities });
    this.json(res, 200, { ok: true });
  }

  /** Who reacted with an emoji (first 25). */
  async reactors({ res, url }) {
    const dc = this.client();
    const q = url.searchParams;
    const [ch, id, emoji] = [q.get('channel') || '', q.get('id') || '', q.get('emoji') || ''];
    if (!isSnowflake(ch) || !isSnowflake(id) || !validEmoji(emoji)) throw new HttpError(400, 'bad request');
    const type = q.get('burst') === '1' ? 1 : 0;
    await this.relay(res, dc, dc.do('GET', `/channels/${ch}/messages/${id}/reactions/${encodeURIComponent(emoji)}?limit=25&type=${type}`));
  }

  /** Pinned messages as a plain array (the newer endpoint wraps them in {items}). */
  async pins({ res, url }) {
    const dc = this.client();
    const ch = url.searchParams.get('channel') || '';
    if (!isSnowflake(ch)) throw new HttpError(400, 'bad id');
    const call = (path) => dc.do('GET', path).catch((e) => { throw new HttpError(502, sanitizeErr(e, dc.token)); });
    let r = await call(`/channels/${ch}/messages/pins`);
    if (r.status === 404) r = await call(`/channels/${ch}/pins`);
    if (r.status !== 200) throw new HttpError(r.status, apiError(r.status, r.body));
    let data;
    try { data = JSON.parse(r.body.toString()); } catch { throw new HttpError(502, 'ข้อมูลจาก Discord ผิดรูปแบบ'); }
    const list = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items.map((i) => i.message).filter(Boolean) : [];
    this.json(res, 200, list);
  }

  async pin({ req, res }) {
    const dc = this.client();
    const b = await readJson(req);
    if (!isSnowflake(b.channel) || !isSnowflake(b.id)) throw new HttpError(400, 'bad request');
    const method = b.on ? 'PUT' : 'DELETE';
    const call = (path) => dc.do(method, path).catch((e) => { throw new HttpError(502, sanitizeErr(e, dc.token)); });
    let r = await call(`/channels/${b.channel}/messages/pins/${b.id}`);
    if (r.status === 404) r = await call(`/channels/${b.channel}/pins/${b.id}`);
    if (r.status < 200 || r.status > 299) throw new HttpError(r.status, apiError(r.status, r.body));
    this.json(res, 200, { ok: b.on ? 'pinned' : 'unpinned' });
  }

  async typing({ req, res }) {
    const dc = this.client();
    const b = await readJson(req);
    if (!isSnowflake(b.channel)) throw new HttpError(400, 'bad request');
    await this.relay(res, dc, dc.do('POST', `/channels/${b.channel}/typing`));
  }

  async openDM({ req, res }) {
    const dc = this.client();
    const b = await readJson(req);
    if (!isSnowflake(b.user)) throw new HttpError(400, 'bad request');
    await this.relay(res, dc, dc.do('POST', '/users/@me/channels', { json: { recipient_id: b.user } }));
  }

  /** Public profile of a user, plus their server membership when a guild is given. Whitelisted fields only. */
  async profile({ res, url }) {
    const dc = this.client();
    const u = url.searchParams.get('user') || '', g = url.searchParams.get('guild') || '';
    if (!isSnowflake(u) || (g && !isSnowflake(g))) throw new HttpError(400, 'bad id');
    const call = (path) => dc.do('GET', path).catch((e) => { throw new HttpError(502, sanitizeErr(e, dc.token)); });
    const [ur, mr] = await Promise.all([call(`/users/${u}`), g ? call(`/guilds/${g}/members/${u}`) : Promise.resolve(null)]);
    if (ur.status === 404) throw new HttpError(404, 'ไม่พบผู้ใช้ / user not found');
    if (ur.status >= 400) throw new HttpError(502, 'Discord ' + ur.status);
    const x = parseJson(ur.body);
    const user = { id: x.id, username: x.username, global_name: x.global_name || null, avatar: x.avatar || null, banner: x.banner || null,
      accent_color: Number.isInteger(x.accent_color) ? x.accent_color : null, bot: !!x.bot, public_flags: Number(x.public_flags) || 0 };
    let member = null;
    if (mr && mr.status === 200) {
      const m = parseJson(mr.body);
      member = { nick: m.nick || null, avatar: m.avatar || null, roles: Array.isArray(m.roles) ? m.roles.filter(isSnowflake).slice(0, 250) : [],
        joined_at: m.joined_at || null, premium_since: m.premium_since || null, timeout_until: m.communication_disabled_until || null };
    }
    this.json(res, 200, { user, member });
  }

  async members({ res, url }) {
    const dc = this.client();
    const g = url.searchParams.get('guild') || '';
    if (!isSnowflake(g)) throw new HttpError(400, 'bad id');
    const r = await dc.do('GET', `/guilds/${g}/members?limit=1000`).catch((e) => { throw new HttpError(502, sanitizeErr(e, dc.token)); });
    if (r.status === 403) throw new HttpError(403, 'ต้องเปิด Server Members Intent ใน Developer Portal แล้วติ๊ก "แสดงรายชื่อสมาชิก" ตอนล็อกอิน');
    await this.relay(res, dc, Promise.resolve(r));
  }

  async upload({ req, res }) {
    const dc = this.client();
    const { fields, files } = await readMultipart(req);
    const { channel, content = '', replyTo = '' } = fields;
    if (!isSnowflake(channel) || (replyTo && !isSnowflake(replyTo)) || !files.length || files.length > MAX_FILES || [...content].length > 2000) throw new HttpError(400, 'bad request');
    const payload = {
      content,
      allowed_mentions: ALLOWED_MENTIONS,
      attachments: files.map((f, i) => ({ id: i, filename: safeName(f.filename) })),
    };
    if (replyTo) payload.message_reference = { message_id: replyTo, fail_if_not_exists: false };
    const form = new FormData();
    form.append('payload_json', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data], { type: 'application/octet-stream' }), safeName(f.filename)));
    await this.relay(res, dc, dc.do('POST', `/channels/${channel}/messages`, { form }));
  }
}

// ---- body helpers ----
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new HttpError(413, 'request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 64 * 1024);
  try {
    const v = JSON.parse(buf.toString() || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'bad request');
  }
}

function readMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: MAX_FILES + 1, fileSize: MAX_UPLOAD, fields: 10, fieldSize: 16 * 1024 } });
    } catch {
      return reject(new HttpError(400, 'bad request'));
    }
    const fields = {};
    const files = [];
    let total = 0;
    let failed = null;
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (c) => {
        total += c.length;
        if (total > MAX_UPLOAD) { failed = new HttpError(413, 'ไฟล์ใหญ่เกินไป (รวมไม่เกิน 25 MB) / too large'); stream.resume(); return; }
        chunks.push(c);
      });
      stream.on('limit', () => { failed = new HttpError(413, 'ไฟล์ใหญ่เกินไป (รวมไม่เกิน 25 MB) / too large'); });
      stream.on('end', () => { if (name === 'files' && !failed) files.push({ filename: info.filename, data: Buffer.concat(chunks) }); });
    });
    bb.on('filesLimit', () => { failed = new HttpError(400, 'bad request'); });
    bb.on('error', () => reject(new HttpError(400, 'bad request')));
    bb.on('close', () => (failed ? reject(failed) : resolve({ fields, files })));
    req.pipe(bb);
  });
}

installAdmin(App, { HttpError, readJson });
