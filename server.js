import http from 'node:http';
import { App } from './src/app.js';

const password = process.env.BOTDECK_PASSWORD || '';
if (password.length < 10) {
  console.error('BOTDECK_PASSWORD must be set to at least 10 characters');
  process.exit(1);
}
const port = Number(process.env.BOTDECK_PORT || process.env.PORT || process.env.SERVER_PORT || 8080);
const allowHttp = process.env.BOTDECK_ALLOW_HTTP === '1';

const app = new App({ password, allowHttp });
const server = http.createServer(app.handler());
app.attach(server);
server.headersTimeout = 15000;
server.requestTimeout = 0; // SSE and uploads are long-lived; bodies are size-limited instead

server.listen(port, '0.0.0.0', () => {
  console.log(`BotDeck listening on 0.0.0.0:${port}`);
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

process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e && e.message));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { app.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
