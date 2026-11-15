import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const COOKIE = 'bd_session';
const SESSION_MS = 12 * 3600 * 1000;
const MAX_FAILS = 8;
const LOCK_MS = 10 * 60 * 1000;

export const isHttps = (req) => !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';

const sha = (s) => createHash('sha256').update(s).digest();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const loginPage = (msg = '') => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>BotDeck</title><style>body{font-family:system-ui,sans-serif;background:#1e1f22;color:#dbdee1;display:grid;place-items:center;height:100vh;margin:0}
form{background:#2b2d31;padding:28px;border-radius:10px;width:min(320px,90vw)}input,button{width:100%;box-sizing:border-box;padding:10px;margin-top:12px;border-radius:6px;border:0;font-size:15px}
input{background:#1e1f22;color:#dbdee1}button{background:#5865f2;color:#fff;cursor:pointer}p{color:#f23f43;min-height:1em;margin:8px 0 0}</style>
<form method=post action=/login><h2>BotDeck</h2><input type=password name=password placeholder="Password" autocomplete=current-password autofocus required>
<button>Sign in</button><p>${esc(msg)}</p></form>`;

/** Password gate: one password, 12h sessions, lockout after repeated failures. */
export class Gate {
  constructor({ password, allowHttp = false, now = () => Date.now() }) {
    this.pw = sha(password);
    this.allowHttp = allowHttp;
    this.now = now;
    this.sessions = new Map();
    this.fails = 0;
    this.failStart = 0;
    this.lockUntil = 0;
  }

  cookieOf(req) {
    const h = req.headers.cookie;
    if (!h) return null;
    for (const part of h.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return null;
  }

  valid(req) {
    const tok = this.cookieOf(req);
    if (!tok) return false;
    const exp = this.sessions.get(tok);
    if (!exp) return false;
    if (this.now() > exp) {
      this.sessions.delete(tok);
      return false;
    }
    return true;
  }

  /** @returns {{status:number, cookie?:string, error?:string}} */
  login(req, password) {
    if (!this.allowHttp && !isHttps(req)) return { status: 403, error: 'HTTPS required (set BOTDECK_ALLOW_HTTP=1 to override at your own risk)' };
    const t = this.now();
    if (t < this.lockUntil) return { status: 429, error: 'too many attempts, try again later' };
    if (typeof password !== 'string' || !timingSafeEqual(sha(password), this.pw)) {
      if (t - this.failStart > 10 * 60 * 1000) { this.fails = 0; this.failStart = t; }
      this.fails++;
      if (this.fails >= MAX_FAILS) { this.lockUntil = t + LOCK_MS; this.fails = 0; }
      return { status: 401, error: 'Wrong password' };
    }
    for (const [k, exp] of this.sessions) if (t > exp) this.sessions.delete(k);
    const tok = randomBytes(32).toString('hex');
    this.sessions.set(tok, t + SESSION_MS);
    const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_MS / 1000}`];
    if (isHttps(req)) flags.push('Secure');
    return { status: 303, cookie: `${COOKIE}=${tok}; ${flags.join('; ')}` };
  }

  logout(req) {
    const tok = this.cookieOf(req);
    if (tok) this.sessions.delete(tok);
  }
}
