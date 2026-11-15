import { config } from './config.js';

const MAX_BODY = 32 * 1024 * 1024;

/** Minimal REST client. The token lives only here, in memory. */
export class Discord {
  constructor(token) {
    this.token = token;
  }

  /** Returns { status, body: Buffer }. A 429 is waited out once. */
  async do(method, path, { json, form, signal } = {}) {
    for (let attempt = 0; ; attempt++) {
      const headers = { Authorization: `Bot ${this.token}`, 'User-Agent': 'DiscordBot (https://github.com/rowudheiv3-creator/BotDeck, 1.0)' };
      let body;
      if (json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
      } else if (form) body = form;
      const timeout = AbortSignal.timeout(30000);
      const res = await fetch(config.apiBase + path, { method, headers, body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BODY) throw new Error('response too large');
      if (res.status === 429 && attempt === 0) {
        let wait = 1;
        try {
          const j = JSON.parse(buf.toString());
          if (j.retry_after > 0) wait = j.retry_after;
        } catch {
          const h = parseFloat(res.headers.get('retry-after'));
          if (h > 0) wait = h;
        }
        if (wait > 10) return { status: res.status, body: buf };
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      return { status: res.status, body: buf };
    }
  }
}

export function apiError(status, body) {
  let message = '';
  try {
    message = JSON.parse(body.toString()).message || '';
  } catch { /* not json */ }
  if (status === 401) return 'โทเคนไม่ถูกต้อง (401)';
  if (status === 403) return 'บอทไม่มีสิทธิ์ทำสิ่งนี้ในช่องนี้ (403)';
  if (status === 404) return 'ไม่พบข้อมูล (404)';
  return message ? `${message} (${status})` : `Discord ตอบ ${status}`;
}

export function sanitizeErr(err, token) {
  const msg = String(err && err.message ? err.message : err);
  return token ? msg.split(token).join('***') : msg;
}
