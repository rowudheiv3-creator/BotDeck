import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRig, GOOD } from './helpers.js';

const withRig = (name, opts, fn) => test(name, async () => {
  const rig = await startRig(opts);
  try { await fn(rig); } finally { await rig.close(); }
});

withRig('login identifies with the right intents and fills the snapshot', {}, async (rig) => {
  assert.equal((await rig.api('login', { token: 'Bot ' + GOOD })).status, 200);
  await rig.ready();
  const { json } = await rig.api('state');
  assert.equal(json.snapshot.me.username, 'TestBot');
  const g = json.snapshot.guilds[0];
  assert.equal(g.name, 'Test Guild');
  assert.deepEqual(g.channels.map((c) => c.name), ['chat zone', 'general', 'random', 'Talk']);
  assert.deepEqual(g.emojis.map((e) => e.name), ['party']); // unavailable emoji dropped
  assert.equal(g.roles[0].name, 'Mod');
  const id = rig.f.identifies[0];
  assert.equal(id.token, GOOD);
  assert.equal(id.intents & (1 << 15), 0, 'message content is opt-in');
  assert.equal(id.intents & (1 << 1), 0, 'members is opt-in');
  assert.ok(id.intents & (1 << 9) && id.intents & (1 << 10), 'messages + reactions');
});

withRig('message content / members intents are applied when asked', {}, async (rig) => {
  await rig.api('login', { token: GOOD, messageContent: true, members: true });
  await rig.ready();
  const i = rig.f.identifies[0].intents;
  assert.ok(i & (1 << 15) && i & (1 << 1));
});

withRig('a bad token is rejected before the gateway', {}, async (rig) => {
  const r = await rig.api('login', { token: 'x'.repeat(50) });
  assert.equal(r.status, 401);
  assert.equal(rig.f.identifies.length, 0);
  assert.equal((await rig.api('login', { token: 'short' })).status, 400);
});

withRig('live events reach the browser over SSE', { login: true }, async (rig) => {
  const res = await fetch(rig.origin + '/app/api/events', { headers: { Cookie: rig.cookie } });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const readUntil = async (needle) => { while (!buf.includes(needle)) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } };
  await readUntil(': hi');
  rig.f.push('MESSAGE_CREATE', { id: '1', channel_id: '21', content: 'hello', author: { id: '5', username: 'ann' } });
  rig.f.push('CHANNEL_CREATE', { id: '23', guild_id: '10', name: 'new', type: 0 });
  await readUntil('"t":"state"');
  assert.match(buf, /"t":"MESSAGE_CREATE"/);
  assert.match(buf, /hello/);
  await reader.cancel();
  const names = (await rig.api('state')).json.snapshot.guilds[0].channels.map((c) => c.name);
  assert.ok(names.includes('new'));
});

withRig('send, delete, history, 403 surfaced', { login: true }, async (rig) => {
  assert.equal((await rig.api('send', { channel: '21', content: 'hi there', replyTo: '901' })).status, 200);
  const sent = rig.f.sent[0];
  assert.equal(sent.content, 'hi there');
  assert.equal(sent.message_reference.message_id, '901');
  assert.equal(sent._path, '/api/v10/channels/21/messages');
  assert.deepEqual(sent.allowed_mentions.parse, ['users', 'roles'], '@everyone must not be allowed');
  for (const bad of [{ channel: '21', content: '' }, { channel: '21', content: 'x'.repeat(2001) }, { channel: '../x', content: 'a' }, { channel: '21', content: 'a', replyTo: 'x/y' }]) {
    assert.equal((await rig.api('send', bad)).status, 400, JSON.stringify(bad).slice(0, 50));
  }
  assert.equal((await rig.api('delete', { channel: '21', id: '901' })).status, 200);
  assert.deepEqual(rig.f.deleted, ['/api/v10/channels/21/messages/901']);
  const h = await rig.api('messages?channel=21');
  assert.equal(h.status, 200);
  assert.equal(h.json.length, 2);
  assert.equal((await rig.api('messages?channel=403')).status, 403);
  assert.equal((await rig.api('messages?channel=21&before=abc')).status, 400);
});

withRig('react, edit, typing, dm, members', { login: true }, async (rig) => {
  assert.equal((await rig.api('react', { channel: '21', id: '901', emoji: '👍', on: true })).status, 200);
  assert.equal((await rig.api('react', { channel: '21', id: '901', emoji: 'party:31', on: false })).status, 200);
  assert.ok(rig.f.calls.includes('PUT /api/v10/channels/21/messages/901/reactions/%F0%9F%91%8D/@me'));
  assert.ok(rig.f.calls.includes('DELETE /api/v10/channels/21/messages/901/reactions/party%3A31/@me'));
  for (const bad of ['', 'a/b', 'x?y', '../..', 'x'.repeat(40)]) assert.equal((await rig.api('react', { channel: '21', id: '901', emoji: bad, on: true })).status, 400, bad);
  assert.equal((await rig.api('edit', { channel: '21', id: '901', content: 'new text' })).status, 200);
  assert.equal(rig.f.sent.at(-1).content, 'new text');
  assert.equal((await rig.api('typing', { channel: '21' })).status, 200);
  assert.equal((await rig.api('dm', { user: '5' })).json.id, '777');
  assert.equal((await rig.api('members?guild=10')).json[0].user.username, 'ann');
  const denied = await rig.api('members?guild=403');
  assert.equal(denied.status, 403);
  assert.match(denied.json.error, /Members Intent/);
});

withRig('embeds are rebuilt from a whitelist and bad ones rejected', { login: true }, async (rig) => {
  const ok = { channel: '21', content: '', embeds: [{ title: 'T', description: 'D', color: 255, evil: 'x', footer: { text: 'f', bogus: 1 }, image: { url: 'https://a.example/i.png' }, fields: [{ name: 'n', value: 'v', inline: true }] }] };
  assert.equal((await rig.api('send', ok)).status, 200);
  const e = rig.f.sent.at(-1).embeds[0];
  assert.equal(e.title, 'T');
  assert.equal(e.evil, undefined);
  assert.equal(e.footer.bogus, undefined);
  assert.equal(e.fields[0].inline, true);
  for (const bad of [
    { embeds: [{ image: { url: 'javascript:alert(1)' } }] },
    { embeds: [{ title: 'x'.repeat(257) }] },
    { embeds: [{}] },
    { embeds: [{ fields: [{ name: '', value: 'v' }] }] },
    { embeds: 'nope' },
    { embeds: Array.from({ length: 11 }, () => ({ title: 't' })) },
    { embeds: [{ description: 'x'.repeat(4000) }, { description: 'y'.repeat(2500) }] },
  ]) assert.equal((await rig.api('send', { channel: '21', ...bad })).status, 400, JSON.stringify(bad).slice(0, 60));
});

withRig('upload forwards files as multipart and enforces limits', { login: true }, async (rig) => {
  const fd = new FormData();
  fd.append('channel', '21'); fd.append('content', 'with file'); fd.append('replyTo', '');
  fd.append('files', new Blob(['hello file'], { type: 'text/plain' }), 'a"b/../c.txt');
  const r = await rig.api('upload', fd);
  assert.equal(r.status, 200, r.text);
  const body = rig.f.sent.at(-1)._multipart;
  assert.match(body, /payload_json/);
  assert.match(body, /hello file/);
  assert.match(body, /filename="c\.txt"/, 'path and quotes stripped from the name');
  const none = new FormData(); none.append('channel', '21');
  assert.equal((await rig.api('upload', none)).status, 400);
  const big = new FormData(); big.append('channel', '21');
  big.append('files', new Blob([Buffer.alloc(26 * 1024 * 1024)]), 'big.bin');
  assert.equal((await rig.api('upload', big)).status, 413);
});

withRig('logout stops the session and forgets everything', { login: true }, async (rig) => {
  assert.equal((await rig.api('logout', {})).status, 200);
  const s = (await rig.api('state')).json;
  assert.equal(s.status, 'idle');
  assert.deepEqual(s.snapshot.guilds, []);
  assert.equal((await rig.api('send', { channel: '21', content: 'x' })).status, 401);
  const before = rig.f.identifies.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(rig.f.identifies.length, before, 'no reconnect after logout');
});

withRig('the token never appears in any response', { login: true }, async (rig) => {
  for (const r of [await rig.api('state'), await rig.api('messages?channel=21'), await rig.api('send', { channel: '21', content: 'x' }), await rig.api('login', { token: GOOD })]) {
    assert.ok(!r.text.includes(GOOD));
  }
});

withRig('super reactions, reactor list and pins', { login: true }, async (rig) => {
  assert.equal((await rig.api('react', { channel: '21', id: '901', emoji: 'party:31', on: true, burst: true })).status, 200);
  assert.ok(rig.f.calls.includes('PUT /api/v10/channels/21/messages/901/reactions/party%3A31/@me?type=1'));
  assert.equal((await rig.api('react', { channel: '21', id: '901', emoji: 'party:31', on: false, burst: true })).status, 200);
  assert.ok(rig.f.calls.includes('DELETE /api/v10/channels/21/messages/901/reactions/party%3A31/@me?type=1'));
  const who = await rig.api('reactors?channel=21&id=901&emoji=' + encodeURIComponent('👍'));
  assert.equal(who.status, 200);
  assert.deepEqual(who.json.map((u) => u.username), ['ann', 'bob']);
  assert.equal((await rig.api('reactors?channel=21&id=901&emoji=a%2Fb')).status, 400);
  const pins = await rig.api('pins?channel=21');
  assert.equal(pins.status, 200);
  assert.equal(pins.json[0].content, 'pinned one', 'new {items} shape is flattened to messages');
  assert.equal((await rig.api('pin', { channel: '21', id: '901', on: true })).status, 200);
  assert.equal((await rig.api('pin', { channel: '21', id: '901', on: false })).status, 200);
  assert.equal((await rig.api('pin', { channel: 'x', id: '901', on: true })).status, 400);
});

withRig('presence is validated and sent over the gateway; typing events reach the browser', { login: true }, async (rig) => {
  assert.equal((await rig.api('presence', { status: 'dnd', text: 'with tests', type: 3 })).status, 200);
  await rig.waitFor(() => rig.f.presences.length === 1);
  assert.deepEqual(rig.f.presences[0].activities, [{ name: 'with tests', type: 3 }]);
  assert.equal(rig.f.presences[0].status, 'dnd');
  assert.equal((await rig.api('presence', { status: 'bogus', text: '', type: 99 })).status, 200);
  await rig.waitFor(() => rig.f.presences.length === 2);
  assert.equal(rig.f.presences[1].status, 'online', 'unknown status falls back to online');
  assert.deepEqual(rig.f.presences[1].activities, []);
  const ctl = new AbortController();
  const r = await fetch(rig.origin + '/app/api/events', { headers: { Cookie: rig.cookie }, signal: ctl.signal });
  const reader = r.body.getReader();
  for (const ws of rig.f.sockets) ws.send(JSON.stringify({ op: 0, s: 50, t: 'TYPING_START', d: { channel_id: '21', user_id: '5', timestamp: 1 } }));
  let seen = '';
  const end = Date.now() + 3000;
  while (Date.now() < end && !seen.includes('TYPING_START')) { const { value } = await reader.read(); seen += Buffer.from(value).toString(); }
  ctl.abort();
  assert.ok(seen.includes('TYPING_START'));
});

withRig('voice: validation, gateway wiring, failure handling, member list and the audio socket', { login: true }, async (rig) => {
  const { config } = await import('../src/config.js');
  const { default: WebSocket } = await import('ws');
  config.voiceTimeout = 400;
  assert.equal((await rig.api('voice/join', { guild: '10', channel: '21' })).status, 400, 'text channel refused');
  assert.equal((await rig.api('voice/join', { guild: 'x', channel: '23' })).status, 400);
  assert.equal((await rig.api('voice/join', { guild: '10', channel: '23' }, { 'X-BD': '0' })).status, 403);
  const st = (await rig.api('state')).json;
  if (!st.voiceAvailable) {
    // Node < 22.12 (or the optional packages are missing): the rest of the app must keep working.
    const r = await rig.api('voice/join', { guild: '10', channel: '23' });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /unavailable/);
  } else {
    // joining asks Discord for the channel; nobody answers, so it times out cleanly and leaves again
    const r = await rig.api('voice/join', { guild: '10', channel: '23' });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /UDP|voice/);
    assert.ok(rig.f.voiceOps.some((o) => o.guild_id === '10' && o.channel_id === '23'), 'sent op 4 join');
    assert.ok(rig.f.voiceOps.some((o) => o.guild_id === '10' && o.channel_id === null), 'sent op 4 leave after failing');
    assert.equal((await rig.api('state')).json.voice.status, 'error');
  }
  assert.equal((await rig.api('voice/leave', {})).status, 200);
  assert.equal((await rig.api('state')).json.voice.status, 'idle');
  // who is in voice shows up in the snapshot
  for (const ws of rig.f.sockets) ws.send(JSON.stringify({ op: 0, s: 60, t: 'VOICE_STATE_UPDATE', d: { guild_id: '10', channel_id: '23', user_id: '5', member: { user: { id: '5', username: 'ann' } } } }));
  await rig.waitFor(async () => (await rig.api('state')).json.snapshot.guilds[0].voice.length === 1);
  assert.equal((await rig.api('state')).json.snapshot.guilds[0].voice[0].name, 'ann');
  for (const ws of rig.f.sockets) ws.send(JSON.stringify({ op: 0, s: 61, t: 'VOICE_STATE_UPDATE', d: { guild_id: '10', channel_id: null, user_id: '5' } }));
  await rig.waitFor(async () => (await rig.api('state')).json.snapshot.guilds[0].voice.length === 0);
  // audio socket: needs the session cookie and a same-origin Origin header
  const url = rig.origin.replace('http', 'ws') + '/app/api/voice';
  const tryWs = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('message', (m) => { resolve('open:' + JSON.parse(m.toString()).t); ws.close(); });
    ws.on('unexpected-response', (_q, res) => resolve('http:' + res.statusCode));
    ws.on('error', () => {});
  });
  assert.equal(await tryWs({ Origin: rig.origin }), 'http:403', 'no cookie');
  assert.equal(await tryWs({ Cookie: rig.cookie }), 'http:403', 'no origin');
  assert.equal(await tryWs({ Cookie: rig.cookie, Origin: 'http://evil.example' }), 'http:403', 'foreign origin');
  assert.equal(await tryWs({ Cookie: rig.cookie, Origin: rig.origin }), 'open:hello');
  // soundboard validates ids and relays the call
  assert.equal((await rig.api('soundboard/play', { channel: 'x', sound: '1' })).status, 400);
});
