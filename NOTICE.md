# Notice

**BotDeck** is a modified version of **DiscordBotClient v3.10.6** by **aiko-chan-ai**
(https://github.com/aiko-chan-ai/DiscordBotClient), licensed under the **GNU General Public
License v3.0**. This project is distributed under the same license; see `LICENSE`.
The original copyright notices in the source files are kept as they were.

## What was changed from upstream

- Renamed the product, window titles, app id and user-visible text to "BotDeck".
- **Removed the auto-updater** (`electron-updater`) and the release feed that pointed to the
  upstream repository. BotDeck never downloads or installs code by itself.
- **Removed promotional content**: the upstream welcome message with sponsor images/links,
  the GitHub / sponsor menu entries and the funding file. The welcome message is now local text only.
- **Removed third-party artwork** (the animated startup screen and its "Artwork by Mihoyo"
  images, the contour data and bundled font). The startup window is always the plain one.
- Removed the winget publishing workflow and the animated-startup test.
- Replaced upstream identity strings (user-agent URL, template user name, fake session label).

## Not included in this source tree

The upstream build downloads, at build time and pinned to exact commits (see
`scripts/build-dependencies.json`): **Vencord** (GPL-3.0), the **botClient Vencord plugin** by
aiko-chan-ai and **Discohook**. Review those sources before building a release you intend to
distribute. The Discord web client itself is loaded from Discord at run time and is not part of this repository.

## Disclaimer

Third-party Discord clients are discouraged by, and may violate, the Discord Terms of Service.
Use at your own risk. This project is not affiliated with or endorsed by Discord.
