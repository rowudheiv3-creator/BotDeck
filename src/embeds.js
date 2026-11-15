// Rebuilds each embed from a fixed set of fields and limits, so only what
// Discord documents is ever forwarded.
const httpUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v) && v.length <= 2000;
const len = (s) => [...s].length;

/** @returns {{embeds?: object[], error?: string}} */
export function cleanEmbeds(input) {
  if (input === undefined || input === null) return { embeds: [] };
  if (!Array.isArray(input)) return { error: 'embeds ต้องเป็นอาร์เรย์' };
  if (input.length > 10) return { error: 'ใส่ embed ได้สูงสุด 10 อัน' };
  let total = 0;
  const str = (obj, key, max) => {
    const v = obj && obj[key];
    if (v === undefined || v === null || v === '') return { ok: true, value: '' };
    if (typeof v !== 'string' || len(v) > max) return { ok: false };
    total += len(v);
    return { ok: true, value: v };
  };
  const out = [];
  for (const e of input) {
    if (!e || typeof e !== 'object') return { error: 'embed ไม่ถูกต้อง' };
    const o = {};
    for (const [k, max] of [['title', 256], ['description', 4096]]) {
      const r = str(e, k, max);
      if (!r.ok) return { error: `${k} ยาวเกินกำหนด` };
      if (r.value) o[k] = r.value;
    }
    if (e.url) {
      if (!httpUrl(e.url)) return { error: 'url ต้องขึ้นต้นด้วย http(s)://' };
      o.url = e.url;
    }
    if (typeof e.color === 'number' && e.color >= 0 && e.color <= 0xffffff) o.color = Math.trunc(e.color);
    if (e.timestamp) {
      if (typeof e.timestamp !== 'string' || Number.isNaN(Date.parse(e.timestamp))) return { error: 'timestamp ไม่ถูกต้อง' };
      o.timestamp = e.timestamp;
    }
    const specs = [
      ['footer', { text: 2048 }, ['icon_url']],
      ['author', { name: 256 }, ['url', 'icon_url']],
      ['image', {}, ['url']],
      ['thumbnail', {}, ['url']],
    ];
    for (const [k, texts, urls] of specs) {
      const raw = e[k];
      if (!raw || typeof raw !== 'object') continue;
      const sub = {};
      for (const [tk, max] of Object.entries(texts)) {
        const r = str(raw, tk, max);
        if (!r.ok) return { error: `${k}.${tk} ยาวเกินกำหนด` };
        if (r.value) sub[tk] = r.value;
      }
      for (const uk of urls) {
        if (!raw[uk]) continue;
        if (!httpUrl(raw[uk])) return { error: `${k}: ลิงก์ต้องขึ้นต้นด้วย http(s)://` };
        sub[uk] = raw[uk];
      }
      if (Object.keys(sub).length) o[k] = sub;
    }
    if (e.fields !== undefined) {
      if (!Array.isArray(e.fields) || e.fields.length > 25) return { error: 'field ได้สูงสุด 25 อัน' };
      const fields = [];
      for (const f of e.fields) {
        const n = str(f, 'name', 256);
        const v = str(f, 'value', 1024);
        if (!n.ok || !v.ok || !n.value || !v.value) return { error: 'field ต้องมีชื่อและค่า (ชื่อ ≤256, ค่า ≤1024 ตัวอักษร)' };
        const field = { name: n.value, value: v.value };
        if (typeof f.inline === 'boolean') field.inline = f.inline;
        fields.push(field);
      }
      if (fields.length) o.fields = fields;
    }
    if (!Object.keys(o).length) return { error: 'embed ว่างเปล่า' };
    out.push(o);
  }
  if (total > 6000) return { error: 'embed รวมกันยาวเกิน 6000 ตัวอักษร' };
  return { embeds: out };
}
