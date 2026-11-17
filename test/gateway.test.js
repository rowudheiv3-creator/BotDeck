import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRig } from './helpers.js';

const withRig = (name, opts, fn) => test(name, async () => {
  const rig = await startRig(opts);
  try { await fn(rig); } finally { await rig.close(); }
});

withRig('reconnect resumes the session instead of identifying again', { login: true }, async (rig) => {
  rig.f.push('MESSAGE_CREATE', { id: '1', channel_id: '21', content: 'x', author: { id: '5', username: 'a' } });
  await rig.waitFor(() => true);
  rig.f.dropAll(4000);
  await rig.waitFor(() => rig.f.resumes.length === 1);
  assert.equal(rig.f.resumes[0].session_id, 'sess1');
  assert.equal(rig.f.identifies.length, 1);
  await rig.ready();
});

withRig('an invalid (non-resumable) session falls back to a fresh identify', { login: true }, async (rig) => {
  rig.f.resumable = false;
  rig.f.dropAll(4000);
  await rig.waitFor(() => rig.f.identifies.length === 2);
  await rig.ready();
});

withRig('heartbeats are sent and a silent server is treated as a zombie', {}, async (rig) => {
  rig.f.helloInterval = 60;
  rig.f.ackBeats = false;
  await rig.api('login', { token: (await import('./helpers.js')).GOOD });
  await rig.waitFor(() => rig.f.beats >= 1);
  // no acks: the client must drop the connection and come back
  await rig.waitFor(() => rig.f.identifies.length + rig.f.resumes.length >= 2, 6000);
});

withRig('fatal close codes stop retrying and explain why', {}, async (rig) => {
  rig.f.closeOnIdentify = 4014;
  const { GOOD } = await import('./helpers.js');
  await rig.api('login', { token: GOOD, messageContent: true });
  await rig.waitFor(async () => (await rig.api('state')).json.status === 'error');
  const s = (await rig.api('state')).json;
  assert.match(s.error, /Privileged Intent/);
  const n = rig.f.identifies.length;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(rig.f.identifies.length, n, 'must not retry a fatal error');
});

import { Store } from '../src/store.js';
test('store folds role create/update/delete events', () => {
  const s = new Store();
  s.apply('GUILD_CREATE', { id: '10', name: 'G', roles: [{ id: '41', name: 'Mod', permissions: '8' }] });
  assert.equal(s.apply('GUILD_ROLE_CREATE', { guild_id: '10', role: { id: '42', name: 'VIP', color: 5, permissions: '1' } }), true);
  assert.equal(s.apply('GUILD_ROLE_UPDATE', { guild_id: '10', role: { id: '42', name: 'VIP2', color: 6 } }), true);
  assert.deepEqual(s.snapshot().guilds[0].roles.map((r) => r.name), ['Mod', 'VIP2']);
  assert.equal(s.apply('GUILD_ROLE_DELETE', { guild_id: '10', role_id: '41' }), true);
  assert.equal(s.snapshot().guilds[0].roles.length, 1);
});
