# BotDeck

A self-hosted web client for Discord **bots**, written in Node.js. Open the site, sign in with your password, and chat as your bot:
servers, channels, replies, edit/delete, reactions, uploads, DMs, members, and an embed composer with live preview.

It is BotDeck's own UI - it does not load, copy or proxy Discord's web client. No voice (yet).

## Run

```bash
npm ci --omit=dev
BOTDECK_PASSWORD='a-long-password' PORT=8080 npm start
```

Needs Node.js 18.17 or newer. Open `http://<host>:8080`, sign in, paste the bot token (or set `BOTDECK_TOKEN`).

| Variable | Meaning |
|---|---|
| `BOTDECK_PASSWORD` | **Required**, 10+ characters. The website password |
| `PORT` / `BOTDECK_PORT` / `SERVER_PORT` | Port to listen on (default 8080) |
| `BOTDECK_TOKEN` | Optional. Start the bot session at boot so the token is never typed into the page |
| `BOTDECK_MESSAGE_CONTENT=1` | With `BOTDECK_TOKEN`: request the Message Content intent (enable it in the Developer Portal first) |
| `BOTDECK_MEMBERS=1` | With `BOTDECK_TOKEN`: request the Server Members intent (privileged) |
| `BOTDECK_ALLOW_HTTP=1` | Allow password login over plain HTTP. Only for hosts without HTTPS; the password then crosses the network in clear text |

### Hosting panels (Wispbyte, Pterodactyl, ...)
Upload the repository (or `git clone` it), set the startup command to `npm ci --omit=dev && npm start`, and set the variables above.

## Security model
- One password gate in front of everything; 12 h sessions; HttpOnly + SameSite=Strict cookies (Secure behind HTTPS)
- 8 wrong passwords lock logins for 10 minutes
- Login is refused over plain HTTP unless `BOTDECK_ALLOW_HTTP=1`
- The bot token is kept in memory only and never sent back to the browser or written to disk
- State-changing requests need a custom header, so other sites cannot trigger them
- Strict CSP; messages are escaped before rendering; embeds are rebuilt from a whitelist before being sent
- Runtime dependencies: `ws`, `busboy`

Anyone with the password controls the bot. Use a long, unique one.

## Develop
```bash
npm ci
npm test        # fake Discord (REST + gateway) - no network needed
```
Layout: `server.js` (entry) · `src/` (app, gateway, REST, store, gate, embeds) · `public/index.html` (UI) · `test/`.

The previous Electron-based fork lives at the tag `electron-fork-archive`.

## Voice, microphone and soundpad

The browser is the audio device: your microphone and soundpad clips are streamed to the server, which sends them into the Discord voice channel; other people's voices come back the same way.

- Needs **Node 22.12+** on the host (the optional `@discordjs/voice` package requires it). On older Node the rest of the app still works and voice shows as unavailable.
- Needs the host to allow **outbound UDP** (Discord voice runs over UDP).
- The browser only lets pages use the microphone over **HTTPS** (or `localhost`).
- The bot needs the **Connect** and **Speak** permissions in the channel. Playing a server soundboard sound also needs the bot to be in that voice channel.
- Soundpad clips are stored only in your browser (IndexedDB); nothing is uploaded anywhere except into the voice call when you press a pad.
- Bots cannot Go Live / share a screen; that is a Discord limit.
