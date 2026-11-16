/** In-memory view of what the gateway has told us. */
const usableEmoji = (e) => e && e.id && e.available !== false;
const pickChannel = (c) => ({ id: c.id, name: c.name || '', type: c.type, parent_id: c.parent_id || null, position: c.position || 0, topic: c.topic || '' });
const pickEmoji = (e) => ({ id: e.id, name: e.name, animated: !!e.animated });
const pickRole = (r) => ({ id: r.id, name: r.name, color: r.color || 0, position: r.position || 0, hoist: !!r.hoist });

const pickVoice = (v) => {
  const u = (v.member && v.member.user) || {};
  return { user_id: v.user_id, channel_id: v.channel_id, name: (v.member && v.member.nick) || u.global_name || u.username || '', avatar: u.avatar || null, bot: !!u.bot };
};

export class Store {
  constructor() {
    this.reset({});
  }

  reset(me) {
    this.me = me && me.id ? { id: me.id, username: me.username, avatar: me.avatar } : {};
    this.guilds = new Map();
  }

  snapshot() {
    const guilds = [...this.guilds.values()].map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
      channels: [...g.channels.values()].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)),
      emojis: g.emojis,
      roles: g.roles,
      voice: [...g.voice.values()],
    }));
    guilds.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { me: this.me, guilds };
  }

  /** Folds a gateway event in; returns true when the UI snapshot changed. */
  apply(t, d) {
    if (!d || typeof d !== 'object') return false;
    switch (t) {
      case 'READY':
        if (!d.user) return false;
        this.me = { id: d.user.id, username: d.user.username, avatar: d.user.avatar };
        return true;
      case 'GUILD_CREATE': {
        if (!d.id) return false;
        this.guilds.set(d.id, {
          id: d.id,
          name: d.name || '',
          icon: d.icon || null,
          channels: new Map((d.channels || []).map((c) => [c.id, pickChannel(c)])),
          emojis: (d.emojis || []).filter(usableEmoji).map(pickEmoji),
          roles: (d.roles || []).map(pickRole),
          voice: new Map((d.voice_states || []).filter((v) => v.channel_id).map((v) => [v.user_id, pickVoice(v)])),
        });
        return true;
      }
      case 'VOICE_STATE_UPDATE': {
        const g = this.guilds.get(d.guild_id);
        if (!g || !d.user_id) return false;
        const had = g.voice.get(d.user_id);
        if (!d.channel_id) return g.voice.delete(d.user_id);
        const next = pickVoice(d);
        if (!next.name && had) next.name = had.name;
        if (had && had.channel_id === next.channel_id && had.name === next.name) return false; // mute/deafen changes: nothing to show
        g.voice.set(d.user_id, next);
        return true;
      }
      case 'GUILD_EMOJIS_UPDATE': {
        const g = this.guilds.get(d.guild_id);
        if (!g) return false;
        g.emojis = (d.emojis || []).filter(usableEmoji).map(pickEmoji);
        return true;
      }
      case 'GUILD_UPDATE': {
        const g = this.guilds.get(d.id);
        if (!g) return false;
        g.name = d.name || g.name;
        g.icon = d.icon || null;
        return true;
      }
      case 'GUILD_DELETE':
        if (d.unavailable) return false;
        return this.guilds.delete(d.id);
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
      case 'CHANNEL_DELETE': {
        const g = this.guilds.get(d.guild_id);
        if (!g) return false;
        if (t === 'CHANNEL_DELETE') g.channels.delete(d.id);
        else g.channels.set(d.id, pickChannel(d));
        return true;
      }
      default:
        return false;
    }
  }
}
