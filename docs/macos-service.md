# macOS LaunchAgent service

TeleCodex can run as a macOS user LaunchAgent. This is the macOS equivalent of the Linux user systemd service: it runs under your user account, can reuse your Codex CLI auth state, and can access the same workspace files and developer tools available on the host.

## Install service support

From the repository root:

```bash
scripts/telecodex-launchd.sh install
```

This installs dependencies, builds `dist/`, and writes LaunchAgent plist files under:

```text
~/Library/LaunchAgents/io.telecodex.plist
~/Library/LaunchAgents/io.telecodex.<instance>.plist
```

Single-bot mode uses `.env` with the `default` instance. Multi-bot mode uses `.env.<instance>` files.

## Single instance

```bash
scripts/telecodex-launchd.sh install
scripts/telecodex-launchd.sh start
```

The generated LaunchAgent runs:

```text
launchd/start.sh <repo-dir> <env-path> <instance>
```

The wrapper sources the env file, sets `TELECODEX_INSTANCE`, changes into the repository, and executes `node dist/index.js`.

## Multiple bots

Create one env file and LaunchAgent per bot:

```bash
scripts/telecodex-launchd.sh add first
scripts/telecodex-launchd.sh add second
scripts/telecodex-launchd.sh edit first
scripts/telecodex-launchd.sh edit second
scripts/telecodex-launchd.sh start first
scripts/telecodex-launchd.sh start second
```

Result:

```text
.env.first  -> io.telecodex.first
.env.second -> io.telecodex.second
```

Keep `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_CHANNEL_ID`, workspace, and Codex auth settings separate per env file.

## Manage

```bash
scripts/telecodex-launchd.sh list
scripts/telecodex-launchd.sh status first
scripts/telecodex-launchd.sh logs first
scripts/telecodex-launchd.sh restart first
scripts/telecodex-launchd.sh stop first
```

Use `--all` only when you intend to affect every configured instance:

```bash
scripts/telecodex-launchd.sh restart --all
scripts/telecodex-launchd.sh stop --all
```

## Update

```bash
scripts/telecodex-launchd.sh update first
scripts/telecodex-launchd.sh update --all
```

`update` installs dependencies, rebuilds `dist/`, rewrites the selected plist file(s), and restarts the selected LaunchAgent(s). During update, the script writes `.telecodex/service-update.lock` so another service operation does not collide.

Telegram `/update` and `/restart` can also use the same service operation marker recovery path after the process comes back online.

## Bin registration

```bash
scripts/telecodex-launchd.sh bin-install
telecodex-launchd list
```

This registers `~/.local/bin/telecodex-launchd`. Add `~/.local/bin` to your shell `PATH` if needed.

Remove it with:

```bash
scripts/telecodex-launchd.sh bin-remove
```

## Notes

- macOS LaunchAgents do not read your interactive shell startup files by default.
- Do not run `telecodex-launchd` with `sudo`. User LaunchAgents must be managed by the logged-in macOS user.
- The wrapper sets a practical default `PATH` that includes Homebrew paths: `/opt/homebrew/bin`, `/usr/local/bin`, and common system paths.
- TeleCodex also searches common Homebrew and user bin paths when it needs to start the Codex CLI for PTY compact.
- `.env` files are sourced by Bash, so quote values that contain spaces or shell-special characters.
- Logs are written to `.telecodex/logs/<instance>.out.log` and `.telecodex/logs/<instance>.err.log`.

## LaunchAgent bootstrap troubleshooting

If you see this error:

```text
launchctl bootstrap gui/0 ...
Bootstrap failed: 125: Domain does not support specified action
```

the helper was run as root, usually through `sudo`. Re-run the command as the normal logged-in user:

```bash
scripts/telecodex-launchd.sh start fifth
```

The domain should use your user id, not `0`.

## Compact troubleshooting

Auto compact runs app-server native compact first, then starts Codex CLI through a PTY to reinforce `/compact` behavior. On macOS, `Compact failed: posix_spawnp failed` usually means the PTY helper or the `codex` CLI could not be executed.

First, repair the local `node-pty` helper permissions:

```bash
node scripts/fix-node-pty-spawn-helper.mjs
```

This is also wired into `pnpm install` through `postinstall`, and service update scripts run the repair explicitly after installing dependencies.

TeleCodex searches these paths automatically:

```text
current PATH
/opt/homebrew/bin
/opt/homebrew/sbin
/usr/local/bin
~/.local/bin
~/bin
~/.bun/bin
~/.npm-global/bin
```

If compact still fails, check where Codex is installed from Terminal:

```bash
command -v codex
```

Then make sure that directory is one of the standard locations above, or install/link `codex` into `/opt/homebrew/bin`, `/usr/local/bin`, or `~/.local/bin`.
