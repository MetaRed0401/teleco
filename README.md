# teleco

teleco connects Telegram to Codex app-server so you can run Codex sessions from a private Telegram bot. It is designed for a personal developer workstation: Telegram provides the remote control surface, while Codex runs on the machine that has your repository, tools, and Codex authentication state.

This project is based on [TeleCodex](https://github.com/benedict2310/telecodex) by Benedict Evert and remains licensed under the MIT License.

## Highlights

- Stream Codex replies back to Telegram while work is in progress.
- Use Codex app-server as the primary runtime for turns, tool events, approvals, token usage, and compact.
- Reinforce compaction with a two-stage flow: app-server native compact followed by Codex CLI PTY `/compact`.
- Detect Codex auto-compaction events and optionally run the PTY compact reinforcement after the turn finishes.
- Keep Telegram `typing` status active during long Codex turns.
- Show tool activity as separate Telegram messages, including shell commands and file-change summaries.
- Send text, voice, images, and documents into the active Codex session.
- Browse the workspace directly from Telegram with file, tree, view, find, and grep commands.
- Run multiple isolated bot instances from one source checkout using separate `.env.*` files.
- Keep compatibility with existing `telecodex-*` service helpers and `TELECODEX_*` environment variable names.
- Run as a Linux user systemd service with lifecycle notifications and service update commands.
- Mirror final Codex responses to a configured Telegram channel when needed.
- Use launch profiles to switch Codex model, sandbox, approval policy, and reasoning level.

## Requirements

- Node.js 20 or newer.
- pnpm 11 or newer.
- A Telegram bot token from `@BotFather`.
- Your numeric Telegram user ID.
- Codex authentication on the host machine, or a `CODEX_API_KEY` if you choose API-key based auth.

For best results, install common developer tools such as `git`, `rg`, `fd`, `tree`, `fzf`, and any language-specific tools your projects require. When teleco runs on the host, Codex can use the same tools that are available in your terminal.

## Runtime Architecture

teleco is a Telegram control plane for Codex running on the same machine as your repositories. Telegram receives prompts, progress, tool activity, approvals, and final replies. Codex still runs locally through the Codex app-server and CLI session files under your Codex home.

The recommended runtime path is:

```text
Telegram bot -> teleco Node.js service -> Codex app-server -> local workspace/tools
                                                |
                                                +-> Codex CLI PTY for compact reinforcement
```

App-server is used for normal turns, tool/file-change streaming, approval requests, account/rate-limit status, and native compact. The CLI PTY path is used only where terminal parity matters, especially after compaction.

## Quick Start

```bash
pnpm install
cp .env.example .env
$EDITOR .env
pnpm run dev
```

Required `.env` values:

```bash
TELEGRAM_BOT_TOKEN=123456:telegram-token
TELEGRAM_ALLOWED_USER_IDS=123456789
```

If you already use Codex CLI on this machine, leave `CODEX_API_KEY` empty so teleco can use the existing Codex auth state. If you do not use Codex CLI auth, set `CODEX_API_KEY` explicitly.

## Environment Configuration

Important options are documented in `.env.example`.

Common settings:

- `TELEGRAM_BOT_TOKEN`: Telegram bot token from `@BotFather`.
- `TELEGRAM_ALLOWED_USER_IDS`: comma-separated list of Telegram users allowed to control the bot.
- `TELEGRAM_CHANNEL_ID`: optional channel or supergroup chat ID for copied final replies.
- `CODEX_MODEL`: default Codex model slug.
- `CODEX_SANDBOX_MODE`: `read-only`, `workspace-write`, or `danger-full-access`.
- `CODEX_APPROVAL_POLICY`: `never`, `on-request`, `on-failure`, or `untrusted`.
- `CODEX_DEFAULT_LAUNCH_PROFILE`: default launch profile ID.
- `ENABLE_UNSAFE_LAUNCH_PROFILES`: exposes the built-in `Restrict` and `Full` profiles when set to `true`.
- `TOOL_VERBOSITY`: `all`, `summary`, `errors-only`, or `none`.
- `ENABLE_LIFECYCLE_NOTIFICATIONS`: sends start and stop notifications.
- `ENABLE_TELEGRAM_LOGIN`: enables `/login` and `/logout` from Telegram.
- `ENABLE_CODEX_APP_SERVER_RUNTIME`: recommended `true`; set `false` only for the legacy SDK fallback.
- `AUTO_COMPACT_ENABLED`: enables teleco automatic compact checks.
- `AUTO_COMPACT_CONTEXT_THRESHOLD`: context usage ratio or percentage that triggers auto compact, for example `0.80` or `80`.
- `AUTO_COMPACT_AFTER_CODEX_AUTO_COMPACT`: when Codex auto-compacts during a turn, run CLI PTY compact reinforcement after the turn.
- `AUTO_COMPACT_AFTER_EVERY_TURN`: check the threshold after every turn. This does not compact every turn by itself.
- `AUTO_COMPACT_COOLDOWN_TURNS` and `AUTO_COMPACT_COOLDOWN_MINUTES`: cooldown for threshold-based auto compact.

`TELECODEX_INSTANCE` is normally set by the service unit. Leave it empty in `.env` files unless you are running teleco manually and need to force an instance name.

## Development Commands

```bash
pnpm run dev      # Run from TypeScript with tsx
pnpm run build    # Compile TypeScript into dist/
pnpm start        # Run compiled dist/index.js
pnpm test         # Run the Vitest test suite
```

## Host User Service

For a personal development machine, the host service mode is usually better than Docker because Codex can use your real terminal tools, repositories, and auth state.

Linux uses a user systemd service. macOS uses a user LaunchAgent.

macOS LaunchAgent setup:

```bash
scripts/telecodex-launchd.sh bin-install
scripts/telecodex-launchd.sh install
scripts/telecodex-launchd.sh start
```

Useful macOS commands:

```bash
telecodex-launchd list
telecodex-launchd status
telecodex-launchd logs default
telecodex-launchd restart
telecodex-launchd update
```

See `docs/macos-service.md` for macOS-specific LaunchAgent details.

Linux systemd setup:

Install the service helper and a single-instance user service:

```bash
scripts/telecodex-service.sh bin-install
scripts/telecodex-service.sh install
scripts/telecodex-service.sh start
```

Useful service commands:

```bash
telecodex-service list
telecodex-service status
telecodex-service logs default
telecodex-service restart
telecodex-service update
```

The update command installs dependencies, builds the project, and restarts the selected service. During an update, teleco writes a lock file under `.telecodex/` so another update does not start on top of it.

If systemd cannot find `node`, edit the user service environment or PATH so it can see the same Node.js installation used by your shell.

## Multi-Bot Instances

teleco supports multiple bot instances from one checkout. Each instance uses its own environment file and systemd unit.

Single-instance mode:

```text
.env -> telecodex.service -> TELECODEX_INSTANCE=default
```

Multi-instance mode:

```text
.env.first  -> telecodex@first.service
.env.second -> telecodex@second.service
.env.third  -> telecodex@third.service
```

Create and manage instances:

```bash
telecodex-service add first
telecodex-service add second
telecodex-service add third
telecodex-service list
telecodex-service start first
telecodex-service restart --all
telecodex-service update first
telecodex-service update --all
telecodex-service logs second
telecodex-service remove third
```

When `.env.*` files exist, commands that can affect running services require either an explicit instance name or `--all`. This avoids accidentally updating, stopping, or restarting the wrong bot.

`.env.default` is deprecated. Use `.env` for single-instance mode, or `.env.<instance>` for multi-instance mode.

## Telegram Commands

| Command | Description |
| --- | --- |
| `/start` | Show the welcome message and current connection summary. |
| `/help` | Show command help. |
| `/new` | Start a new Codex session for the current Telegram context. |
| `/status` | Show session, model, profile, queue, and workspace status. |
| `/doctor` | Check the service runtime environment, PATH, tools, git/auth state, and approval bridge support. |
| `/locks` | Show known Git and teleco runtime lock files without removing them. |
| `/compact` | Run two-stage context compaction for the current thread. |
| `/compact status` | Show compact availability and current context information. |
| `/stop` | Abort the active Codex turn as quickly as possible. |
| `/retry` | Retry the last prompt. |
| `/steer <prompt>` | Send steering instructions into the active Codex turn. |
| `/queue <prompt>` | Queue a prompt after the active turn. |
| `/queue clear` | Clear queued prompts. |
| `/queue pop <n>` | Remove queued prompt number `n`. |
| `/think` | Show reasoning options as buttons. |
| `/think <level>` | Set the reasoning level directly. |
| `/model` | Show available model controls. |
| `/model <slug>` | Set the Codex model. |
| `/launch_profiles` | Show launch profiles. |
| `/launch <profile>` | Apply a launch profile. |
| `/auth` | Show authentication status. |
| `/login` | Start Telegram-driven Codex login when enabled. |
| `/logout` | Clear Telegram-driven login state when enabled. |
| `/voice` | Toggle voice input handling. |
| `/attach` | Show attachment guidance. |
| `/handback` | Show handback guidance for continuing locally. |
| `/files [path]` | List files under a workspace path. |
| `/tree [path]` | Show a workspace tree. |
| `/find <query>` | Find files by name. |
| `/view <path>` | Read a workspace file. |
| `/grep <query>` | Search text in the workspace. |
| `/update` | Trigger a service update for the current instance. |
| `/service_update` | Alias for `/update`. |

Plain text messages are sent to Codex as prompts. Replying to a bot message keeps the conversation attached to the same Telegram context.

## Sessions, Workspaces, and State

teleco stores one active Codex session per Telegram context. In private chats the context is the chat ID. In topic-enabled chats, the context can include the topic ID. This keeps independent conversations from mixing.

Workspace browsing commands operate on the configured workspace root. They are implemented by teleco itself, not by Telegram, so they can work even before you ask Codex to inspect files.

Runtime metadata is stored under `.telecodex/`:

```text
.telecodex/contexts.json              # single/default instance
.telecodex/<instance>/contexts.json   # named instance
.telecodex/service-update.lock        # update lock
```

Do not commit `.telecodex/`, `.env`, Codex credentials, Telegram tokens, or API keys.

## Context Compact and Auto Compact

Manual `/compact` uses two stages:

```text
1. app-server native compact on the active thread
2. Codex CLI PTY `codex resume <thread>` followed by `/compact`
```

The second stage is intentional. It helps keep the CLI-backed session aligned with what you would expect from an interactive Codex terminal session.

Auto compact has two triggers:

- Codex app-server emits a context compaction event during a turn.
- teleco sees context usage at or above `AUTO_COMPACT_CONTEXT_THRESHOLD` after a turn.

`AUTO_COMPACT_AFTER_EVERY_TURN=true` means “check after every turn.” It does not mean “compact after every turn.” If the threshold is not reached, no compact is run.

Incoming Telegram prompts are queued while compact is running.

## Launch Profiles and Safety

Launch profiles let you switch Codex behavior without editing `.env` each time. Profiles can define model, sandbox mode, approval policy, reasoning level, and a safety policy.

Built-in profiles include normal workspace-write operation and safer read-only/review modes. The `Restrict` and `Full` profiles use `danger-full-access` and are hidden unless `ENABLE_UNSAFE_LAUNCH_PROFILES=true`.

For unattended service operation, `CODEX_APPROVAL_POLICY=never` is recommended. Use stronger permissions only on trusted machines and trusted repositories.

## Tool Activity and Telegram Formatting

Codex tool activity can be shown separately from final assistant replies. This avoids long, concatenated progress messages and makes Telegram output easier to read on mobile.

Set `TOOL_VERBOSITY` to control how much tool detail is sent:

```bash
TOOL_VERBOSITY=summary
```

Long shell commands are formatted as code blocks when possible. File changes, shell usage, and other tool summaries are labeled so they are easier to scan in Telegram.

See `docs/runtime-architecture.md` and `docs/terminal-parity.md` for the deeper runtime model and the remaining differences from an interactive Codex terminal session.

## Docker

Docker support is available, but it is not the recommended default for a personal workstation. A container needs its own tools, filesystem mounts, and Codex auth/session path.

Docker has two Ubuntu-based variants:

- `Dockerfile` + `docker-compose.yml`: normal image with Node, pnpm, Codex CLI, and required runtime dependencies.
- `Dockerfile.local` + `docker-compose.local.yml`: tool-rich image with common developer CLI tools.

Typical Docker values:

```bash
CODEX_HOME_DIR=${HOME}/.codex
TELECODEX_WORKSPACE_DIR=/path/to/workspace
TELECODEX_CONTAINER_WORKSPACE=/workspace
```

Use `docker compose up -d` for the normal image.

Use `docker compose -f docker-compose.local.yml up -d` when Codex should have extra tools such as `rg`, `fd`, `fzf`, `jq`, `sqlite3`, `tree`, `bat`, `tokei`, `ast-grep`, `gron`, `yq`, `websocat`, `tcping`, and `zoxide` preinstalled.

Do not bake credentials into the image. Mount `CODEX_HOME_DIR` or provide secrets through your deployment environment.

See `docs/docker-ubuntu.md` for the Ubuntu container layout and smoke checks.

Use Docker when isolation matters more than direct access to the host developer environment.

## Troubleshooting

- Bot does not respond: check `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, and service logs.
- `/stop` feels delayed: make sure you are running a version with background Codex turn handling, then inspect `telecodex-service logs <instance>`.
- Auto compact does not run: confirm `ENABLE_CODEX_APP_SERVER_RUNTIME=true`, `AUTO_COMPACT_ENABLED=true`, and check `/status` for context usage availability.
- Codex cannot access files: confirm the service user can read the workspace path.
- Codex cannot find tools: install the tools on the host, or update the systemd PATH.
- Multi-instance command is refused: specify an instance name or pass `--all`.
- Channel messages do not arrive: confirm `TELEGRAM_CHANNEL_ID` and that the bot can post to the channel.

## Security Notes

teleco can give a Telegram account remote access to Codex running on your machine. Keep the bot private, restrict `TELEGRAM_ALLOWED_USER_IDS`, avoid committing secrets, and be careful with `danger-full-access` profiles.
