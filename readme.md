<h1 align="center">BotDeck</h1>

BotDeck lets you use your **Discord bot** in a Discord-style desktop client.
It is a modified fork of [DiscordBotClient](https://github.com/aiko-chan-ai/DiscordBotClient)
by aiko-chan-ai (GPL-3.0). See [NOTICE.md](NOTICE.md) for exactly what was changed.

> [!WARNING]
> Third-party clients are discouraged by and may violate the Discord Terms of Service.

## Safety

- No auto-updater, no telemetry, no ads: the app does not download or run code by itself.
- The Electron windows run sandboxed with context isolation; the local API server listens on `127.0.0.1` only.
- Your bot token is only sent to Discord. Never share it.
- Build from source, or only install builds from a source you trust.

## Build (Windows)

Requirements: Node.js 22+, Git.

```
npm run requirement      # npm ci + fetches pinned Vencord, botClient plugin and Discohook
npm run build            # builds dependencies, TypeScript and the Windows installer (NSIS, you choose the install folder)
```

The installer is written to `dist/`. A GitHub Actions workflow (`.github/workflows/build.yml`)
builds it on `windows-latest` if you push this repository to your own GitHub account.

## License

GPL-3.0. Based on DiscordBotClient © 2026 aiko-chan-ai.
