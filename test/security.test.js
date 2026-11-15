import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { App } from '../src/app.js';
import { Gate } from '../src/gate.js';
import { startRig, PASSWORD } from './helpers.js';

async function plainServer(opts = {}) {
  const app = new App({ password: PASSWORD, ...opts });
  const server = http.createServer(app.handler());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { app, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
const form = (pw) => ({ method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `password=${encodeURIComponent(pw)}` });

test('nothing is reachable without logging in', async () => {
  const s = await plainServer({ allowHttp: true });
  try {
    for (const p of ['/app/', '/app/api/state', '/app/api/events', '/app/api/messages?channel=1', '/other']) {
      const r = await fetch(s.origin + p, { redirect: 'manual' });
      assert.notEqual(r.status, 200, p);
    }
    assert.equal((await fetch(s.origin + '/app/api/send', { method: 'POST', headers: { 'X-BD': '1' }, body: '{}' })).status, 401);
    assert.equal((await fetch(s.origin + '/healthz')).status, 200);
  } finally { await s.close(); }
});

test('wrong password, forged cookie, and the right password', async () => {
  const s = await plainServer({ allowHttp: true });
  try {
    assert.equal((await fetch(s.origin + '/login', form('nope'))).status, 401);
    const r = await fetch(s.origin + '/login', form(PASSWORD));
    assert.equal(r.status, 303);
    const c = r.headers.get('set-cookie');
    assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/);
    const ok = await fetch(s.origin + '/app/api/state', { headers: { Cookie: c.split(';')[0] } });
    assert.equal(ok.status, 200);
    const forged = await fetch(s.origin + '/app/api/state', { headers: { Cookie: 'bd_session=forged' } });
    assert.equal(forged.status, 401);
  } finally { await s.close(); }
});

test('POST without the custom header is refused even when logged in', async () => {
  const rig = await startRig();
  try {
    const r = await fetch(rig.origin + '/app/api/send', { method: 'POST', headers: { Cookie: rig.cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
  } finally { await rig.close(); }
});

test('login is locked after repeated failures', async () => {
  const s = await plainServer({ allowHttp: true });
  try {
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await fetch(s.origin + '/login', form('bad'))).status;
    assert.equal(last, 429);
    assert.equal((await fetch(s.origin + '/login', form(PASSWORD))).status, 429, 'even the right password waits out the lock');
  } finally { await s.close(); }
});

test('plain HTTP login is refused unless allowed; proxy-forwarded HTTPS is accepted', async () => {
  const s = await plainServer({ allowHttp: false });
  try {
    assert.equal((await fetch(s.origin + '/login', form(PASSWORD))).status, 403);
    const r = await fetch(s.origin + '/login', { ...form(PASSWORD), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'https' } });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('set-cookie'), /Secure/);
  } finally { await s.close(); }
});

test('sessions expire', () => {
  let t = 1000;
  const g = new Gate({ password: PASSWORD, allowHttp: true, now: () => t });
  const req = { socket: {}, headers: {} };
  const { cookie } = g.login(req, PASSWORD);
  const authed = { socket: {}, headers: { cookie: cookie.split(';')[0] } };
  assert.equal(g.valid(authed), true);
  t += 13 * 3600 * 1000;
  assert.equal(g.valid(authed), false);
});

test('security headers are set', async () => {
  const s = await plainServer({ allowHttp: true });
  try {
    const r = await fetch(s.origin + '/');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  } finally { await s.close(); }
});
