// Server administration through the bot's own permissions: roles, members, channels, invites.
// Every handler validates and whitelists its input; Discord decides what the bot is actually allowed to do
// and its error text is passed back to the user. Mixed into App by installAdmin().
import { isSnowflake } from './config.js';
import { sanitizeErr } from './discord.js';

const P = {
  CREATE_INVITE: 1n << 0n, KICK: 1n << 1n, BAN: 1n << 2n, ADMIN: 1n << 3n, MANAGE_CHANNELS: 1n << 4n, MANAGE_GUILD: 1n << 5n,
  AUDIT: 1n << 7n, VIEW: 1n << 10n, SEND: 1n << 11n, MANAGE_MESSAGES: 1n << 13n, MENTION_EVERYONE: 1n << 17n, CONNECT: 1n << 20n, SPEAK: 1n << 21n,
  NICKNAME: 1n << 27n, MANAGE_ROLES: 1n << 28n, MODERATE: 1n << 40n,
};
const ALL = (1n << 64n) - 1n;
const int = (v, lo, hi, d) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function installAdmin(App, { HttpError, readJson }) {
  const need = (cond) => { if (!cond) throw new HttpError(400, 'bad request'); };

  Object.assign(App.prototype, {
    reasonOf(b) { return str(b.reason, 400) || undefined; },

    /** Calls Discord and returns the parsed JSON body (or {}); non-2xx becomes the usual friendly error. */
    async adm(method, path, opts, b) {
      const dc = this.client();
      const reason = b ? this.reasonOf(b) : undefined;
      const r = await dc.do(method, path, { ...opts, reason }).catch((e) => { throw new HttpError(502, sanitizeErr(e, dc.token)); });
      if (r.status < 200 || r.status > 299) {
        let m = ''; try { m = JSON.parse(r.body.toString()).message || ''; } catch { /* not json */ }
        const t = r.status === 403 ? 'บอทไม่มีสิทธิ์ หรือยศของบอทต่ำกว่า / missing permission or the bot\'s role is too low' : r.status === 404 ? 'ไม่พบข้อมูล / not found' : (m || 'Discord ' + r.status);
        throw new HttpError(r.status === 403 || r.status === 404 ? r.status : 502, t + (r.status === 403 && m ? ' — ' + m : ''));
      }
      try { return JSON.parse(r.body.toString() || '{}'); } catch { return {}; }
    },

    /** What the bot may do in a server, so the UI can grey out buttons. */
    async myPerms({ res, url }) {
      const g = url.searchParams.get('guild') || '';
      need(isSnowflake(g));
      const guild = this.store.guilds.get(g);
      if (!guild || !this.store.me) throw new HttpError(404, 'ไม่พบเซิร์ฟเวอร์ / unknown server');
      const m = await this.adm('GET', `/guilds/${g}/members/${this.store.me.id}`);
      const roles = guild.roles || [];
      let bits = 0n, top = 0;
      const ev = roles.find((r) => r.id === g);
      if (ev) bits |= BigInt(ev.permissions || '0');
      for (const id of (m.roles || [])) { const r = roles.find((x) => x.id === id); if (r) { bits |= BigInt(r.permissions || '0'); top = Math.max(top, r.position); } }
      const owner = guild.owner_id === this.store.me.id;
      const admin = owner || (bits & P.ADMIN) === P.ADMIN;
      if (admin) bits = ALL;
      const has = (b) => (bits & b) === b;
      this.json(res, 200, {
        owner, admin, top, bits: bits.toString(),
        can: { roles: has(P.MANAGE_ROLES), kick: has(P.KICK), ban: has(P.BAN), timeout: has(P.MODERATE), nick: has(P.NICKNAME), channels: has(P.MANAGE_CHANNELS), guild: has(P.MANAGE_GUILD), messages: has(P.MANAGE_MESSAGES), invite: has(P.CREATE_INVITE) },
      });
    },

    async memberAction({ req, res }) {
      const b = await readJson(req);
      need(isSnowflake(b.guild) && isSnowflake(b.user));
      const base = `/guilds/${b.guild}/members/${b.user}`;
      switch (b.action) {
        case 'nick': await this.adm('PATCH', base, { json: { nick: str(b.value, 32) || null } }, b); break;
        case 'timeout': {
          const s = int(b.seconds, 0, 28 * 86400, -1); need(s >= 0);
          await this.adm('PATCH', base, { json: { communication_disabled_until: s ? new Date(Date.now() + s * 1000).toISOString() : null } }, b); break;
        }
        case 'kick': await this.adm('DELETE', base, {}, b); break;
        case 'ban': await this.adm('PUT', `/guilds/${b.guild}/bans/${b.user}`, { json: { delete_message_seconds: int(b.deleteSeconds, 0, 604800, 0) } }, b); break;
        case 'unban': await this.adm('DELETE', `/guilds/${b.guild}/bans/${b.user}`, {}, b); break;
        case 'addrole': need(isSnowflake(b.role)); await this.adm('PUT', `${base}/roles/${b.role}`, {}, b); break;
        case 'delrole': need(isSnowflake(b.role)); await this.adm('DELETE', `${base}/roles/${b.role}`, {}, b); break;
        default: throw new HttpError(400, 'bad request');
      }
      this.json(res, 200, { ok: true });
    },

    async guildEdit({ req, res }) {
      const b = await readJson(req);
      need(isSnowflake(b.guild));
      const name = str(b.name, 100); need(name.length >= 2);
      await this.adm('PATCH', `/guilds/${b.guild}`, { json: { name } }, b);
      this.json(res, 200, { ok: true });
    },

    async roleSave({ req, res }) {
      const b = await readJson(req);
      need(isSnowflake(b.guild) && (!b.role || isSnowflake(b.role)));
      const json = {};
      if (b.name !== undefined) { json.name = str(b.name, 100); need(json.name); }
      if (b.color !== undefined) json.color = int(b.color, 0, 0xffffff, 0);
      if (b.hoist !== undefined) json.hoist = !!b.hoist;
      if (b.mentionable !== undefined) json.mentionable = !!b.mentionable;
      if (b.permissions !== undefined) { need(/^\d{1,20}$/.test(String(b.permissions))); json.permissions = String(b.permissions); }
      const out = b.role ? await this.adm('PATCH', `/guilds/${b.guild}/roles/${b.role}`, { json }, b) : await this.adm('POST', `/guilds/${b.guild}/roles`, { json: { name: 'new role', ...json } }, b);
      this.json(res, 200, { ok: true, id: out.id || b.role });
    },

    async roleDelete({ req, res }) {
      const b = await readJson(req);
      need(isSnowflake(b.guild) && isSnowflake(b.role) && b.role !== b.guild);
      await this.adm('DELETE', `/guilds/${b.guild}/roles/${b.role}`, {}, b);
      this.json(res, 200, { ok: true });
    },

    async channelCreate({ req, res }) {
      const b = await readJson(req);
      need(isSnowflake(b.guild));
      const type = [0, 2, 4, 5].includes(b.type) ? b.type : 0;
      const name = str(b.name, 100); need(name);
      const json = { name, type };
      if (b.topic && (type === 0 || type === 5)) json.topic = str(b.topic, 1024);
      if (b.parent && type !== 4) { need(isSnowflake(b.parent)); json.parent_id = b.parent; }
      const out = await this.adm('POST', `/guilds/${b.guild}/channels`, { json }, b);
      this.json(res, 200, { ok: true, id: out.id });
    },

    async channelEdit({ req, res }) {
      const b = await readJson(req);
      need(isSnowflake(b.channel));
      const json = {};
      if (b.name !== undefined) { json.name = str(b.name, 100); need(json.name); }
      if (b.topic !== undefined) json.topic = str(b.topic, 1024);
      if (b.nsfw !== undefined) json.nsfw = !!b.nsfw;
      if (b.slowmode !== undefined) json.rate_limit_per_user = int(b.slowmode, 0, 21600, 0);
      await this.adm('PATCH', `/channels/${b.channel}`, { json }, b);
      this.json(res, 200, { ok: true });
    },

    async channelDelete({ req, res }) {
      const b = await readJson(req);
      need(isSnowflake(b.channel));
      await this.adm('DELETE', `/channels/${b.channel}`, {}, b);
      this.json(res, 200, { ok: true });
    },

    /** Deletes the latest N messages (2-100; Discord only bulk-deletes messages younger than 14 days). */
    async purge({ req, res }) {
      const b = await readJson(req);
      need(isSnowflake(b.channel));
      const n = int(b.count, 1, 100, 0); need(n);
      const list = await this.adm('GET', `/channels/${b.channel}/messages?limit=${n}`);
      const minId = (BigInt(Date.now() - 14 * 86400e3 + 60e3 - 1420070400000) << 22n);
      const ids = (Array.isArray(list) ? list : []).map((m) => m.id).filter((id) => isSnowflake(id) && BigInt(id) > minId);
      if (ids.length >= 2) await this.adm('POST', `/channels/${b.channel}/messages/bulk-delete`, { json: { messages: ids } }, b);
      else if (ids.length === 1) await this.adm('DELETE', `/channels/${b.channel}/messages/${ids[0]}`, {}, b);
      this.json(res, 200, { ok: true, deleted: ids.length });
    },

    async invite({ req, res }) {
      const b = await readJson(req);
      need(isSnowflake(b.channel));
      const out = await this.adm('POST', `/channels/${b.channel}/invites`, { json: { max_age: int(b.maxAge, 0, 604800, 86400), max_uses: int(b.maxUses, 0, 100, 0), unique: true } }, b);
      need(typeof out.code === 'string' && /^[\w-]{2,40}$/.test(out.code));
      this.json(res, 200, { ok: true, url: 'https://discord.gg/' + out.code });
    },
  });
}
