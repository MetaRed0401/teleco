# Linux user service

TeleCodex is usually most useful as a host user service. Running on the host lets Codex use the same `codex` auth state, workspace files, shell tools, and language CLIs that you use in your terminal.

## Install service support

From the repository root:

```bash
scripts/telecodex-service.sh install
```

This installs dependencies, builds `dist/`, and installs both units:

```text
~/.config/systemd/user/telecodex.service
~/.config/systemd/user/telecodex@.service
```

Single-bot mode uses only `.env` with `telecodex.service`. Multi-bot mode uses `.env.<instance>` files with `telecodex@<instance>.service`.

Do not use `.env.default`. If it exists, move its values into `.env` and delete `.env.default`.

## Single instance

```bash
scripts/telecodex-service.sh start
```

In single-bot mode the script reads only `.env`. If no `.env.first`, `.env.second`, or other instance files exist, commands without an instance target the single `telecodex.service`.

## Multiple bots

Each bot should use a separate env file and systemd instance:

```bash
scripts/telecodex-service.sh add first
scripts/telecodex-service.sh add second
scripts/telecodex-service.sh add third
scripts/telecodex-service.sh edit first
scripts/telecodex-service.sh edit second
scripts/telecodex-service.sh edit third
scripts/telecodex-service.sh start first
scripts/telecodex-service.sh start second
scripts/telecodex-service.sh start third
```

Result:

```text
telecodex@first.service   -> .env.first
telecodex@second.service  -> .env.second
telecodex@third.service   -> .env.third
```

Separate `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_CHANNEL_ID`, workspace, and Codex auth settings per env file.

`TELECODEX_INSTANCE` normally does not need to be set in `.env` files. The systemd units set it automatically: `default` for `telecodex.service`, and `%i` for `telecodex@<instance>.service`. Only set it manually when running without systemd and still using `/service_update`.

Each non-default instance stores Telegram context metadata separately at `.telecodex/<instance>/contexts.json`. This prevents `first`, `second`, and `third` from reusing each other's Telegram context bindings.

## Manage

```bash
scripts/telecodex-service.sh list
scripts/telecodex-service.sh status first
scripts/telecodex-service.sh logs first
scripts/telecodex-service.sh restart first
scripts/telecodex-service.sh stop first
```

If the user journal is unavailable, TeleCodex also writes an instance log under the active workspace:

```text
.telecodex/service.log
.telecodex/<instance>/service.log
```

`telecodex-service logs <instance>` follows journal logs when available and falls back to this file log otherwise.

Use `--all` only when you intend to affect every configured instance:

```bash
scripts/telecodex-service.sh restart --all
scripts/telecodex-service.sh stop --all
```

## Update

Updates require an explicit instance or `--all`:

```bash
scripts/telecodex-service.sh update first
scripts/telecodex-service.sh update --all
```

`update` installs dependencies, rebuilds `dist/`, and restarts the selected instance(s). During update, the script writes `.telecodex/service-update.lock` with the running PID, target, command, and start time so other agents/scripts can avoid colliding.

`/service_update` from Telegram updates the current process instance using `TELECODEX_INSTANCE`. In single-bot mode this is `default`; in multi-bot mode it is the systemd instance name such as `first`, `second`, or `third`.

## Edit and remove

```bash
scripts/telecodex-service.sh edit review
scripts/telecodex-service.sh remove review
scripts/telecodex-service.sh remove review --delete-env
```

`remove` stops and disables the instance. It keeps `.env.<instance>` unless `--delete-env` is provided.

## Bin registration

```bash
scripts/telecodex-service.sh bin-install
telecodex-service list
telecodex-service update first
```

This registers `~/.local/bin/telecodex-service`. If `~/.local/bin` is not in `PATH`, the script prints an instruction and does not edit shell profiles automatically.

Remove it with:

```bash
scripts/telecodex-service.sh bin-remove
```

## Boot behavior

User services run while the user systemd manager is active. To allow services to start on boot without an interactive login, enable linger:

```bash
loginctl enable-linger "$USER"
```

Disable it later with:

```bash
loginctl disable-linger "$USER"
```

## Notes

- `ENABLE_LIFECYCLE_NOTIFICATIONS=true` sends start/stop notifications to private users and `TELEGRAM_CHANNEL_ID` when configured.
- `ENABLE_CODEX_APP_SERVER_RUNTIME=true` is recommended for tool streaming, approval requests, status details, and native compact.
- Auto compact options such as `AUTO_COMPACT_ENABLED` and `AUTO_COMPACT_CONTEXT_THRESHOLD` belong in each `.env.<instance>` file when using multiple bots.
- If your Node binary is not available through `/usr/bin/env node`, edit the unit files before installing.
- Docker remains available for isolated deployment, but host service mode is recommended for a personal development machine.

## Telegram update and restart recovery

Telegram commands that restart the service are fire-and-forget. The old bot process may exit before it can report final success. TeleCodex writes a small instance-local marker before launching update or restart, then reads it on startup and sends a recovery message after the bot is back online.

Marker paths:

```text
.telecodex/service-operation-marker.json
.telecodex/<instance>/service-operation-marker.json
```

Commands:

```text
/update            update the current service instance
/service_update    alias for /update
/restart           restart the current service instance
/force_restart     alias for /restart
/service_restart   alias for /restart
```

The recovery message includes the instance, workspace, launcher PID when available, start time, and elapsed time. Use `/status` or `/doctor` after the recovery message to verify the runtime.
