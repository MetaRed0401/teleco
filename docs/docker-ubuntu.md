# Docker Ubuntu Runtime

TeleCodex can run in Docker when isolation matters more than direct access to the host developer environment. Host user services are still the recommended default for a personal workstation.

## Image Variants

Docker provides two variants with the same TeleCodex app behavior:

- `Dockerfile` + `docker-compose.yml`: normal image with Node, pnpm, Codex CLI, and required runtime dependencies.
- `Dockerfile.local` + `docker-compose.local.yml`: operator image with the brew-parity toolset used in this environment.

Use the normal image by default:

```bash
docker compose build
```

Use the tool-rich image when Codex should have common CLI tools available inside the container:

```bash
docker compose -f docker-compose.local.yml build
```

## Auth And Workspace

Do not bake credentials into the image. Mount Codex state and the workspace:

```bash
CODEX_HOME_DIR=${HOME}/.codex
TELECODEX_WORKSPACE_DIR=/path/to/workspace
TELECODEX_CONTAINER_WORKSPACE=/workspace
```

Inside Docker, TeleCodex uses `TELECODEX_WORKSPACE` when set, otherwise `/workspace`.
The local compose file defaults `TELECODEX_WORKSPACE_DIR` to `${HOME}` so Codex can see the host home directory. Set `TELECODEX_WORKSPACE_DIR` explicitly when you want a narrower mount.
Compose mounts the Codex home directory but masks `/home/telecodex/.codex/auth.json` with `.telecodex/docker-empty-auth.json`. This keeps sessions, skills, plugins, memories, sqlite state, and other local Codex assets available while hiding the host auth file.

## Tool Layer

The normal `Dockerfile` is intentionally small. If a deployment needs extra preinstalled CLI tools, use `Dockerfile.local` or add Ubuntu install commands there.

`Dockerfile.local` installs or aliases common tools such as `rg`, `fd`, `fzf`, `jq`, `sqlite3`, `tree`, `bat`, `tokei`, `ast-grep`, `gron`, `yq`, `websocat`, `tcping`, and `zoxide`.

## Smoke Checks

After building, useful checks are:

```bash
docker compose run --rm telecodex codex --version
docker compose run --rm telecodex codex app-server --help
docker compose run --rm telecodex node dist/index.js
```

Use `/doctor` in Telegram after startup to confirm `codex`, workspace access, auth state, and tool availability.
