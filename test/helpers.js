import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from '../src/config.js';
import { App } from '../src/app.js';

export const GOOD = 'test-token-not-a-real-discord-token-0123456789';
export const PASSWORD = 'correct-horse-battery';

export async function startFake() {
  const f = { sent: [], deleted: [], calls: [], presences: [], voiceOps: [], identifies: [], resumes: [], beats: 0, sockets: new Set(), helloInterval: 40000, ackBeats: true, resumable: true, closeOnIdentify: 0 };
  const rest = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const path = req.url;
      f.calls.push(`${req.method} ${path}`);
      const j = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bot ${GOOD}`) return j(401, { message: '401: Unauthorized' });
      if (path === '/api/v10/users/@me') return j(200, { id: '100', username: 'TestBot', avatar: null });
      if (req.method === 'GET' && path.startsWith('/api/v10/channels/403/')) return j(403, { message: 'Missing Access' });
      if (req.method === 'GET' && /^\/api\/v10\/channels\/\d+\/messages(\?|$)/.test(path)) {
        return j(200, [{ id: '902', content: 'second', author: { id: '5', username: 'ann' }, timestamp: new Date().toISOString() }, { id: '901', content: 'first', author: { id: '5', username: 'ann' }, timestamp: new Date().toISOString() }]);
      }
      if (req.method === 'POST' && /^\/api\/v10\/channels\/\d+\/messages$/.test(path)) {
        const ct = req.headers['content-type'] || '';
        const rec = ct.startsWith('multipart/') ? { _multipart: raw.toString('latin1') } : JSON.parse(raw.toString());
        rec._path = path;
        f.sent.push(rec);
        return j(200, { id: '999' });
      }
      if (req.method === 'DELETE' && /\/messages\/\d+$/.test(path)) { f.deleted.push(path); res.writeHead(204); return res.end(); }
      if (req.method === 'PATCH' && /\/messages\/\d+$/.test(path)) { f.sent.push({ _patch: path, ...JSON.parse(raw.toString()) }); return j(200, { id: '901', content: 'edited' }); }
      if (req.method === 'GET' && /\/reactions\/[^/]+\?/.test(path)) return j(200, [{ id: '5', username: 'ann' }, { id: '6', username: 'bob' }]);
      if (req.method === 'GET' && /^\/api\/v10\/channels\/\d+\/messages\/pins/.test(path)) return j(200, { items: [{ pinned_at: 'x', message: { id: '901', content: 'pinned one', author: { id: '5', username: 'ann' }, timestamp: new Date().toISOString() } }], has_more: false });
      if (/\/messages\/pins\/\d+$/.test(path) && (req.method === 'PUT' || req.method === 'DELETE')) { res.writeHead(204); return res.end(); }
      if (/\/reactions\/.+\/@me/.test(path)) { res.writeHead(204); return res.end(); }
      if (path.endsWith('/typing')) { res.writeHead(204); return res.end(); }
      if (path === '/api/v10/users/@me/channels') return j(200, { id: '777', type: 1 });
      if (path.startsWith('/api/v10/guilds/403/members')) return j(403, { message: 'Missing Access' });
      if (/^\/api\/v10\/guilds\/\d+\/members/.test(path)) return j(200, [{ user: { id: '5', username: 'ann' }, roles: ['41'], nick: 'Annie' }, { user: { id: '6', username: 'bob' }, roles: [] }, { user: { id: '100', username: 'TestBot', bot: true }, roles: [] }]);
      return j(404, { message: 'Unknown' });
    });
  });
  await new Promise((r) => rest.listen(0, '127.0.0.1', r));
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  let seq = 0;
  const push = (ws, t, d) => ws.send(JSON.stringify({ op: 0, t, s: ++seq, d }));
  wss.on('connection', (ws) => {
    f.sockets.add(ws);
    ws.on('close', () => f.sockets.delete(ws));
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: f.helloInterval } }));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.op === 3) f.presences.push(m.d);
      if (m.op === 4) f.voiceOps.push(m.d);
      if (m.op === 1) { f.beats++; if (f.ackBeats) ws.send(JSON.stringify({ op: 11 })); }
      if (m.op === 2) {
        f.identifies.push(m.d);
        if (f.closeOnIdentify) return ws.close(f.closeOnIdentify);
        push(ws, 'READY', { user: { id: '100', username: 'TestBot', avatar: null }, session_id: 'sess1', resume_gateway_url: `ws://127.0.0.1:${wss.address().port}`, guilds: [{ id: '10', unavailable: true }] });
        push(ws, 'GUILD_CREATE', {
          id: '10', name: 'Test Guild', icon: null,
          channels: [{ id: '20', name: 'chat zone', type: 4, position: 0 }, { id: '21', name: 'general', type: 0, position: 0, parent_id: '20' }, { id: '22', name: 'random', type: 0, position: 1, parent_id: '20' }, { id: '23', name: 'Talk', type: 2, position: 2, parent_id: '20' }],
          emojis: [{ id: '31', name: 'party', animated: false, available: true }, { id: '32', name: 'gone', available: false }],
          roles: [{ id: '41', name: 'Mod', color: 255, position: 1, hoist: true }],
        });
      }
      if (m.op === 6) {
        f.resumes.push(m.d);
        if (!f.resumable) return ws.send(JSON.stringify({ op: 9, d: false }));
        push(ws, 'RESUMED', {});
      }
    });
  });
  f.push = (t, d) => { for (const ws of f.sockets) push(ws, t, d); };
  f.dropAll = (code = 4000) => { for (const ws of f.sockets) ws.close(code); };
  f.stop = async () => { for (const ws of f.sockets) ws.terminate(); wss.close(); rest.closeAllConnections?.(); await new Promise((r) => rest.close(r)); };
  f.restUrl = `http://127.0.0.1:${rest.address().port}/api/v10`;
  f.wsUrl = `ws://127.0.0.1:${wss.address().port}/?v=10&encoding=json`;
  return f;
}

/** Starts BotDeck against a fake Discord and logs in to the password gate. */
export async function startRig({ login = false } = {}) {
  const f = await startFake();
  Object.assign(config, { apiBase: f.restUrl, gatewayUrl: f.wsUrl, reconnectBase: 30, maxReconnectBackoff: 100 });
  const app = new App({ password: PASSWORD, allowHttp: true });
  const server = http.createServer(app.handler());
  app.attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `password=${PASSWORD}` });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const rig = {
    f, app, origin, cookie,
    async api(path, body, extra = {}) {
      const isGet = body === undefined;
      const res = await fetch(`${origin}/app/api/${path}`, { method: isGet ? 'GET' : 'POST', headers: { Cookie: cookie, 'X-BD': '1', ...(isGet || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: isGet ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, json, text };
    },
    async waitFor(cond, ms = 4000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 15)); }
      throw new Error('timed out waiting for condition');
    },
    async ready() { await rig.waitFor(async () => (await rig.api('state')).json.status === 'ready'); },
    async close() { app.stop(); server.closeAllConnections(); await new Promise((r) => server.close(r)); await f.stop(); },
  };
  if (login) { await rig.api('login', { token: GOOD }); await rig.ready(); }
  return rig;
}
