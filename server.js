import http from 'node:http';
import https from 'node:https';
import { App } from './src/app.js';
import { loadEnvFile } from './src/dotenv.js';
import { loadOrCreateCert } from './src/tls.js';
import { createFrontServer } from './src/front.js';

loadEnvFile(new URL('./.env', import.meta.url));

import fs from 'node:fs';
import crypto from 'node:crypto';

// Zero-config start: with no password configured, make a random one, keep it in .botdeck-password and print it.
const pwFile = new URL('./.botdeck-password', import.meta.url);
let password = process.env.BOTDECK_PASSWORD || '';
let generated = false;
if (!password) {
  try { password = fs.readFileSync(pwFile, 'utf8').trim(); } catch { /* first run */ }
  if (password.length < 6) {
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    password = Array.from(crypto.randomBytes(14), (b) => alphabet[b % alphabet.length]).join('');
    try { fs.writeFileSync(pwFile, password + '\n', { mode: 0o600 }); } catch { /* read-only disk: password changes each start */ }
  }
  generated = true;
}
if (password.length < 6) {
  console.error('BOTDECK_PASSWORD must be at least 6 characters');
  process.exit(1);
}
if (generated) {
  console.log('==================================================');
  console.log(' BotDeck login password (no BOTDECK_PASSWORD set):');
  console.log('   ' + password);
  console.log(' Saved in .botdeck-password. Set BOTDECK_PASSWORD or a .env file to choose your own.');
  console.log('==================================================');
} else if (password.length < 10) {
  console.warn('WARNING: BOTDECK_PASSWORD is short; anyone who guesses it controls your bot. 10+ characters is recommended.');
}
const port = Number(process.env.BOTDECK_PORT || process.env.PORT || process.env.SERVER_PORT || 8080);
// Panels like Wispbyte hand out plain http://ip:port. Allowed by default (set BOTDECK_ALLOW_HTTP=0 to require HTTPS).
const allowHttp = process.env.BOTDECK_ALLOW_HTTP !== '0';

const app = new App({ password, allowHttp });
const handler = app.handler();
const servers = [];
const httpServer = http.createServer(handler);
servers.push(httpServer);
let httpsServer = null;
if (process.env.BOTDECK_HTTPS !== '0') {
  try {
    const cert = loadOrCreateCert(new URL('./.botdeck-cert.json', import.meta.url), [process.env.BOTDECK_PUBLIC_HOST]);
    httpsServer = https.createServer({ key: cert.key, cert: cert.cert, minVersion: 'TLSv1.2' }, handler);
    servers.push(httpsServer);
  } catch (e) { console.error('HTTPS disabled (could not create a certificate):', e.message); }
}
for (const sv of servers) { app.attach(sv); sv.headersTimeout = 15000; sv.requestTimeout = 0; /* SSE and uploads are long-lived; bodies are size-limited instead */ }

const front = createFrontServer(httpServer, httpsServer);
front.listen(port, '0.0.0.0', () => {
  console.log(`BotDeck listening on 0.0.0.0:${port}  (http://  and ${httpsServer ? 'https://  — self-signed, accept the browser warning once to use the microphone' : 'no https'})`);
  if (allowHttp) console.log('WARNING: plain HTTP allowed; the password can be read on the network');
});

// Optional auto-login so the token never has to be typed into the page.
if (process.env.BOTDECK_TOKEN) {
  app.connect(process.env.BOTDECK_TOKEN, {
    messageContent: process.env.BOTDECK_MESSAGE_CONTENT === '1',
    members: process.env.BOTDECK_MEMBERS === '1',
  }).then(() => console.log('Bot session starting from BOTDECK_TOKEN'))
    .catch((e) => console.error('Auto-login failed:', e.message));
}

process.on('uncaughtException', (e) => console.error('uncaught exception (kept running):', e && e.message));
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e && e.message));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { app.stop(); front.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
