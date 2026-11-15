# BotDeck Web Server (own client, written from scratch)

A single static Go binary: open the site in a browser, sign in with your password, paste your bot token, chat.
No Electron, no dependencies, nothing written to disk. The bot token lives in memory only.

**Not** a copy of Discord's web client: it is BotDeck's own UI (messages, send/edit/delete, reactions, uploads, DMs, members).
No voice.

## Run on a hosting panel (Wispbyte etc.)
1. Upload `botdeck-server-linux-amd64` (or `-arm64`) and make it the startup file/command (`./botdeck-server-linux-amd64`).
2. Environment variables:
   - `BOTDECK_PASSWORD` (required, 10+ characters) - the website password
   - `PORT` (or `BOTDECK_PORT` / `SERVER_PORT`) - port to listen on, default 8080
   - `BOTDECK_ALLOW_HTTP=1` - only if your host has no HTTPS; then the password and token cross the network in clear text
3. Open the public URL, sign in, paste the bot token.

Security: login is refused over plain HTTP unless allowed, 8 wrong passwords lock logins for 10 minutes, sessions last 12h,
cookies are HttpOnly + SameSite=Strict.

## Build
`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o botdeck-server-linux-amd64 .`
